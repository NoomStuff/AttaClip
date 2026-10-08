import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { copyFile, link, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Category, Clip, Job, Shareable } from "../shared/types";
import { encodeShareable, ffmpegBase, probe, runMedia } from "./media";
import type { MediaInfo } from "./media";

const categorySchema = z.object({ id: z.string(), name: z.string(), color: z.string() });
const fileSchema = z.object({ relativePath: z.string(), absolutePath: z.string(), identity: z.string() });
const shareSchema = fileSchema.extend({ id: z.string(), size: z.number().nonnegative(), targetMB: z.number().positive(), createdAt: z.number() });
const clipSchema = fileSchema.extend({
   id: z.string(),
   name: z.string(),
   source: z.string(),
   createdAt: z.number(),
   categories: z.array(z.string()),
   shareables: z.array(shareSchema),
});
const metadataSchema = z.object({ version: z.literal(1), collectionId: z.string(), categories: z.array(categorySchema), clips: z.array(clipSchema) });
type Metadata = z.infer<typeof metadataSchema>;
type StoredClip = Metadata["clips"][number];
type StoredFile = z.infer<typeof fileSchema>;
const supported = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".ts", ".flv"]);
const normal = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
export function withinRoot(root: string, path: string): boolean {
   const rel = relative(normal(resolve(root)), normal(resolve(path)));
   return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
const safeRelative = (path: string) => !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const fileStamp = (value: BigIntStats) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}:${value.birthtimeNs}`;

async function publishWithoutOverwrite(source: string, destination: string): Promise<void> {
   try {
      await link(source, destination);
   } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOTSUP", "ENOSYS", "EPERM", "EXDEV"].includes(code ?? "")) throw error;
      // Removable drives may not support hard links. Exclusive copy still protects existing files.
      await copyFile(source, destination, constants.COPYFILE_EXCL);
   }
}

/** Sampled identity is for recovery, not security or duplicate deletion. */
export async function fileIdentity(path: string): Promise<string> {
   const handle = await open(path, "r");
   try {
      const size = (await handle.stat()).size;
      const hash = createHash("sha256").update(String(size));
      for (const position of new Set([0, Math.max(0, size - 65536)])) {
         const buffer = Buffer.alloc(Math.min(size, 65536));
         const result = await handle.read(buffer, 0, buffer.length, position);
         hash.update(buffer.subarray(0, result.bytesRead));
      }
      return hash.digest("hex");
   } finally {
      await handle.close();
   }
}

export interface CollectionOptions {
   onChange?: () => void;
   onJob?: (job: Job) => void;
   onWarning?: (message: string) => void;
   mediaUrl?: (path: string) => string;
}
export class CollectionService {
   root = "";
   clips: Clip[] = [];
   jobs: Job[] = [];
   warnings: string[] = [];
   private options: CollectionOptions;
   private metadata: Metadata = { version: 1, collectionId: randomUUID(), categories: [], clips: [] };
   private controllers = new Map<string, AbortController>();
   private queue: Promise<void> = Promise.resolve();
   private writes: Promise<void> = Promise.resolve();
   private scanRunning: Promise<Clip[]> | undefined;
   private metadataWritable = true;
   private cache = new Map<string, { stamp: string; info: MediaInfo; thumbnail: string }>();
   // Scanning may reuse sampled identities. Export, rename and deletion always
   // read a fresh identity through resolveFile instead of trusting this cache.
   private identities = new Map<string, { stamp: string; identity: string }>();
   private writtenMetadata: { snapshot: string; stamp: string } | undefined;
   constructor(options: CollectionOptions = {}) {
      this.options = options;
   }
   get categories(): Category[] {
      return this.metadata.categories;
   }
   get pendingJobs(): Job[] {
      return this.jobs.filter((job) => job.state === "queued" || job.state === "running");
   }
   private notify() {
      this.options.onChange?.();
   }
   private warn(text: string) {
      if (!this.warnings.includes(text)) {
         this.warnings.push(text);
         this.options.onWarning?.(text);
      }
   }
   private url(path: string) {
      return this.options.mediaUrl?.(path) ?? pathToFileURL(path).href;
   }
   private metaPath() {
      return join(this.root, ".attaclip", "collection.json");
   }

   async open(root: string): Promise<void> {
      if (this.pendingJobs.length) throw new Error("Finish or cancel shareable creation before changing folders.");
      if (this.scanRunning) await this.scanRunning;
      await this.writes;
      await mkdir(resolve(root), { recursive: true });
      this.root = await realpath(resolve(root));
      await this.safeDirectory(join(this.root, ".attaclip"));
      this.cache.clear();
      this.identities.clear();
      this.writtenMetadata = undefined;
      this.warnings = [];
      this.clips = [];
      this.metadataWritable = true;
      this.metadata = { version: 1, collectionId: randomUUID(), clips: [], categories: [] };
      let broken = false;
      for (const path of [this.metaPath(), `${this.metaPath()}.bak`]) {
         try {
            this.metadata = metadataSchema.parse(JSON.parse(await readFile(path, "utf8")));
            if (path === this.metaPath())
               this.writtenMetadata = {
                  snapshot: JSON.stringify(this.metadata, null, 2),
                  stamp: fileStamp(await stat(path, { bigint: true })),
               };
            if (broken) this.warn("Collection metadata was recovered from its backup.");
            broken = false;
            break;
         } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") broken = true;
         }
      }
      if (broken) {
         this.metadataWritable = false;
         this.warn(
            "Collection metadata is damaged. Videos remain available, but categories and shareable changes are disabled to preserve recovery information."
         );
      }
      await this.scan();
   }

   private async safeDirectory(path: string): Promise<void> {
      if (!withinRoot(this.root, path)) throw new Error("The folder is outside this collection.");
      let existing = path;
      while (true) {
         try {
            const actual = await realpath(existing);
            if (!withinRoot(this.root, actual)) throw new Error("A collection folder points outside the collection.");
            break;
         } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const parent = dirname(existing);
            if (parent === existing) throw error;
            existing = parent;
         }
      }
      await mkdir(path, { recursive: true });
      if (!withinRoot(this.root, await realpath(path))) throw new Error("The folder points outside this collection.");
   }

   private async writeMetadata(): Promise<void> {
      if (!this.metadataWritable) throw new Error("Collection metadata needs recovery before making this change.");
      const snapshot = JSON.stringify(this.metadata, null, 2);
      const path = this.metaPath();
      const write = this.writes
         .catch(() => undefined)
         .then(async () => {
            if (this.writtenMetadata?.snapshot === snapshot) {
               try {
                  if (this.writtenMetadata.stamp === fileStamp(await stat(path, { bigint: true }))) return;
               } catch {
                  /* Recreate a missing metadata file safely. */
               }
            }
            await this.safeDirectory(dirname(path));
            const temporary = `${path}.${randomUUID()}.tmp`;
            try {
               const handle = await open(temporary, "wx");
               try {
                  await handle.writeFile(snapshot);
                  await handle.sync();
               } finally {
                  await handle.close();
               }
               // Never rotate a damaged primary over the known-good recovery copy.
               try {
                  metadataSchema.parse(JSON.parse(await readFile(path, "utf8")));
                  await copyFile(path, `${path}.bak`);
               } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
               }
               await rename(temporary, path);
               this.writtenMetadata = { snapshot, stamp: fileStamp(await stat(path, { bigint: true })) };
            } finally {
               await rm(temporary, { force: true });
            }
         });
      this.writes = write;
      await write;
   }

   private async scanIdentity(path: string, stamp?: BigIntStats): Promise<string> {
      const key = fileStamp(stamp ?? (await stat(path, { bigint: true })));
      const previous = this.identities.get(path);
      if (previous?.stamp === key) return previous.identity;
      const identity = await fileIdentity(path);
      // A changing file must not retain an identity under its earlier stamp.
      if (fileStamp(await stat(path, { bigint: true })) === key) this.identities.set(path, { stamp: key, identity });
      else this.identities.delete(path);
      return identity;
   }

   private async resolveFile(file: StoredFile, scanning = false): Promise<string | undefined> {
      const identity = (path: string) => (scanning ? this.scanIdentity(path) : fileIdentity(path));
      if (safeRelative(file.relativePath)) {
         const path = resolve(this.root, file.relativePath);
         try {
            const actual = await realpath(path);
            if (withinRoot(this.root, actual) && (await identity(actual)) === file.identity) return actual;
         } catch {
            /* Try verified recovery below. */
         }
      }
      try {
         const actual = await realpath(file.absolutePath);
         if ((await identity(actual)) !== file.identity) return undefined;
         if (!withinRoot(this.root, actual)) {
            this.warn("A missing video was found outside this collection. Relink or copy it into this folder before using it here.");
            return undefined;
         }
         file.relativePath = relative(this.root, actual);
         file.absolutePath = actual;
         return actual;
      } catch {
         return undefined;
      }
   }

   private async shareablesOwned(): Promise<boolean> {
      try {
         const marker: unknown = JSON.parse(await readFile(join(this.root, "shareables", ".attaclip-owner.json"), "utf8"));
         return typeof marker === "object" && marker !== null && "collectionId" in marker && marker.collectionId === this.metadata.collectionId;
      } catch {
         return false;
      }
   }

   scan(): Promise<Clip[]> {
      if (this.scanRunning) return this.scanRunning;
      this.scanRunning = this.scanCollection().finally(() => {
         this.scanRunning = undefined;
      });
      return this.scanRunning;
   }
   private async scanCollection(): Promise<Clip[]> {
      if (!this.root) return [];
      const files: string[] = [];
      const ownedShares = await this.shareablesOwned();
      const walk = async (directory: string): Promise<void> => {
         const entries = await readdir(directory, { withFileTypes: true });
         for (const entry of entries) {
            if (entry.isSymbolicLink() || entry.name === ".attaclip") continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
               if (directory === this.root && entry.name === "shareables" && ownedShares) continue;
               await walk(path);
            } else if (
               entry.isFile() &&
               supported.has(extname(entry.name).toLowerCase()) &&
               !entry.name.startsWith(".attaclip-") &&
               !/\.saving\./i.test(entry.name)
            )
               files.push(path);
         }
      };
      await walk(this.root);
      const result: Clip[] = [];
      const used = new Set<string>();
      const retainedPaths = new Set<string>();
      const currentRelativePaths = new Set(files.map((file) => relative(this.root, file)));
      for (const path of files) {
         try {
            const actual = await realpath(path);
            if (!withinRoot(this.root, actual)) continue;
            const fileStat = await stat(actual, { bigint: true });
            const stamp = fileStamp(fileStat);
            const identity = await this.scanIdentity(actual, fileStat);
            retainedPaths.add(actual);
            const rel = relative(this.root, actual);
            let stored = this.metadata.clips.find((clip) => clip.relativePath === rel && clip.identity === identity && !used.has(clip.id));
            stored ??= this.metadata.clips.find((clip) => clip.identity === identity && !used.has(clip.id) && !currentRelativePaths.has(clip.relativePath));
            if (!stored) {
               stored = {
                  id: randomUUID(),
                  relativePath: rel,
                  absolutePath: actual,
                  identity,
                  name: basename(actual, extname(actual)),
                  source: "Unknown",
                  createdAt: Number(fileStat.birthtimeMs || fileStat.mtimeMs),
                  categories: [],
                  shareables: [],
               };
               this.metadata.clips.push(stored);
            }
            used.add(stored.id);
            stored.relativePath = rel;
            stored.absolutePath = actual;
            let cached = this.cache.get(actual);
            if (!cached || cached.stamp !== stamp) {
               const info = await probe(actual);
               let thumb = join(this.root, ".attaclip", "thumbnails", `${identity}.jpg`);
               try {
                  await this.safeDirectory(dirname(thumb));
                  try {
                     await stat(thumb);
                  } catch {
                     const temporary = `${thumb}.${randomUUID()}.jpg`;
                     try {
                        await runMedia(
                           "ffmpeg",
                           [
                              ...ffmpegBase,
                              "-y",
                              "-ss",
                              String(Math.min(info.duration * 0.2, 2)),
                              "-i",
                              actual,
                              "-frames:v",
                              "1",
                              "-vf",
                              "scale=480:-2",
                              "-threads",
                              "1",
                              temporary,
                           ],
                           { belowNormal: true }
                        );
                        await rename(temporary, thumb);
                     } finally {
                        await rm(temporary, { force: true });
                     }
                  }
               } catch (error) {
                  this.warn(`Preview thumbnail unavailable for ${basename(actual)}: ${message(error)}`);
                  thumb = "";
               }
               cached = { stamp, info, thumbnail: thumb };
               this.cache.set(actual, cached);
            }
            const shares: Shareable[] = [];
            for (const share of stored.shareables) {
               const located = await this.resolveFile(share, true);
               if (located) {
                  retainedPaths.add(located);
                  shares.push({
                     id: share.id,
                     path: located,
                     relativePath: share.relativePath,
                     size: (await stat(located)).size,
                     targetMB: share.targetMB,
                     createdAt: share.createdAt,
                  });
               }
            }
            result.push({
               id: stored.id,
               path: actual,
               relativePath: rel,
               name: stored.name,
               source: stored.source,
               size: Number(fileStat.size),
               duration: cached.info.duration,
               width: cached.info.width,
               height: cached.info.height,
               createdAt: stored.createdAt,
               thumbnail: cached.thumbnail ? this.url(cached.thumbnail) : "",
               playbackUrl: this.url(actual),
               tracks: cached.info.tracks,
               categories: [...stored.categories],
               shareables: shares,
            });
         } catch (error) {
            this.warn(`Could not read ${basename(path)}: ${message(error)}`);
         }
      }
      this.clips = result.sort((a, b) => b.createdAt - a.createdAt);
      for (const path of this.identities.keys()) if (!retainedPaths.has(path)) this.identities.delete(path);
      for (const path of this.cache.keys()) if (!retainedPaths.has(path)) this.cache.delete(path);
      if (this.metadataWritable) await this.writeMetadata();
      this.notify();
      return this.clips;
   }

   private stored(id: string): StoredClip {
      const clip = this.metadata.clips.find((entry) => entry.id === id);
      if (!clip) throw new Error("This clip is no longer in the collection.");
      return clip;
   }
   private visible(id: string): Clip {
      const clip = this.clips.find((entry) => entry.id === id);
      if (!clip) throw new Error("This video is missing. Refresh the collection.");
      return clip;
   }
   async rename(id: string, name: string): Promise<void> {
      const cleaned = name.trim();
      if (!cleaned || cleaned.length > 200) throw new Error("Choose a clip name between 1 and 200 characters.");
      if (
         /[<>:"/\\|?*]/.test(cleaned) ||
         [...cleaned].some((character) => character.charCodeAt(0) < 32) ||
         /[. ]$/.test(cleaned) ||
         /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)
      )
         throw new Error("That name contains characters reserved for files. Choose another name.");
      if (!this.metadataWritable) throw new Error("Restore the collection metadata before renaming clips.");
      if (this.pendingJobs.some((job) => job.clipId === id)) throw new Error("Finish or cancel this clip's shareable before renaming it.");
      const stored = this.stored(id);
      const original = await this.resolveFile(stored);
      if (!original) throw new Error("The original video moved or changed. Refresh the collection.");
      const destination = join(dirname(original), `${cleaned}${extname(original)}`);
      if (normal(destination) !== normal(original)) {
         try {
            await publishWithoutOverwrite(original, destination);
         } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
               throw new Error("A video with that name already exists. Choose another name.", { cause: error });
            throw error;
         }
         try {
            await rm(original);
         } catch (error) {
            await rm(destination, { force: true });
            throw error;
         }
         stored.relativePath = relative(this.root, destination);
         stored.absolutePath = destination;
      }
      stored.name = cleaned;
      await this.writeMetadata();
      await this.scan();
   }
   async registerRecording(path: string, source: string): Promise<Clip> {
      const actual = await realpath(path);
      if (!withinRoot(this.root, actual)) throw new Error("The saved recording is outside the collection.");
      await this.scan();
      const clip = this.clips.find((entry) => normal(entry.path) === normal(actual));
      if (!clip) throw new Error("The recording finished, but could not be opened. Its file has been kept.");
      this.stored(clip.id).source = source;
      await this.writeMetadata();
      await this.scan();
      return this.visible(clip.id);
   }
   async createCategory(name: string, color = "#b197fc"): Promise<void> {
      if (!this.metadataWritable) throw new Error("Restore the collection metadata before changing categories.");
      const cleaned = name.trim();
      if (!cleaned || cleaned.length > 80) throw new Error("Choose a category name between 1 and 80 characters.");
      if (!/^#[\da-f]{6}$/i.test(color)) throw new Error("Choose a valid category color.");
      if (this.categories.some((category) => category.name.toLowerCase() === cleaned.toLowerCase()))
         throw new Error("A category with that name already exists.");
      this.metadata.categories.push({ id: randomUUID(), name: cleaned, color });
      await this.writeMetadata();
      this.notify();
   }
   async deleteCategory(id: string): Promise<void> {
      if (!this.metadataWritable) throw new Error("Restore the collection metadata before changing categories.");
      this.metadata.categories = this.categories.filter((category) => category.id !== id);
      for (const clip of this.metadata.clips) clip.categories = clip.categories.filter((category) => category !== id);
      await this.writeMetadata();
      await this.scan();
   }
   async assignCategories(id: string, ids: string[]): Promise<void> {
      if (!this.metadataWritable) throw new Error("Restore the collection metadata before changing categories.");
      if (ids.some((category) => !this.categories.some((entry) => entry.id === category))) throw new Error("That category no longer exists.");
      this.stored(id).categories = [...new Set(ids)];
      await this.writeMetadata();
      await this.scan();
   }

   async filesForDeletion(id: string, shareableId?: string): Promise<string[]> {
      if (this.pendingJobs.some((job) => job.clipId === id)) throw new Error("Finish or cancel this clip's shareable before deleting it.");
      const stored = this.stored(id);
      const files: StoredFile[] = shareableId ? stored.shareables.filter((share) => share.id === shareableId) : [stored, ...stored.shareables];
      if (shareableId && !files.length) throw new Error("That shareable no longer exists.");
      const result: string[] = [];
      for (const file of files) {
         const path = await this.resolveFile(file);
         if (path && withinRoot(this.root, path)) result.push(path);
      }
      return [...new Set(result)];
   }
   async removeDeleted(id: string, paths: string[]): Promise<void> {
      const stored = this.stored(id);
      const deleted = new Set(paths.map((path) => normal(resolve(path))));
      stored.shareables = stored.shareables.filter((share) => !deleted.has(normal(resolve(this.root, share.relativePath))));
      // Retain associations for shareables that failed to trash, even if the original is gone.
      if (deleted.has(normal(resolve(this.root, stored.relativePath))) && !stored.shareables.length)
         this.metadata.clips = this.metadata.clips.filter((clip) => clip.id !== id);
      await this.writeMetadata();
      await this.scan();
   }

   private jobUpdate(job: Job, change: Partial<Job>) {
      Object.assign(job, change);
      this.options.onJob?.({ ...job });
      this.notify();
   }
   async createShareable(id: string, targetMB: number): Promise<void> {
      if (!Number.isFinite(targetMB) || targetMB < 0.1 || targetMB > 10000) throw new Error("Choose a size limit between 0.1 and 10,000 MB.");
      if (!this.metadataWritable) throw new Error("Restore the collection metadata before creating shareables.");
      const clip = this.visible(id);
      const job: Job = { id: randomUUID(), clipId: id, kind: "shareable", state: "queued", progress: 0, message: "Waiting to create shareable" };
      const controller = new AbortController();
      this.controllers.set(job.id, controller);
      this.jobs.push(job);
      this.jobUpdate(job, {});
      const operation = this.queue
         .catch(() => undefined)
         .then(async () => {
            const temporaryFiles: string[] = [];
            try {
               if (controller.signal.aborted) throw new Error("Cancelled");
               this.jobUpdate(job, { state: "running", message: "Creating shareable" });
               const original = await this.resolveFile(this.stored(id));
               if (!original) throw new Error("The original video moved or changed. Refresh the collection.");
               const sharesRoot = join(this.root, "shareables");
               let existing = false;
               try {
                  await stat(sharesRoot);
                  existing = true;
               } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
               }
               if (existing && !(await this.shareablesOwned()))
                  throw new Error(
                     "A shareables folder already exists and is not owned by AttaClip. Rename it or choose another collection before creating shareables."
                  );
               await this.safeDirectory(sharesRoot);
               if (!existing)
                  await writeFile(join(sharesRoot, ".attaclip-owner.json"), JSON.stringify({ collectionId: this.metadata.collectionId }), { flag: "wx" });
               const folder = join(sharesRoot, dirname(clip.relativePath));
               await this.safeDirectory(folder);
               const final = join(folder, `${basename(original, extname(original))}-${targetMB}MB-${job.id.slice(0, 8)}.mp4`);
               const temporary = join(folder, `.attaclip-${job.id}.mp4`);
               const passLog = join(this.root, ".attaclip", `pass-${job.id}`);
               temporaryFiles.push(temporary, `${passLog}-0.log`, `${passLog}-0.log.mbtree`);
               const info = await probe(original);
               let verified = false;
               for (let attempt = 0; attempt < 3; attempt++) {
                  await encodeShareable(original, temporary, passLog, info, targetMB * Math.pow(0.9, attempt), {
                     signal: controller.signal,
                     onProgress: (progress) => this.jobUpdate(job, { progress, message: attempt ? "Adjusting to fit size limit" : "Creating shareable" }),
                  });
                  const size = (await stat(temporary)).size;
                  const outputInfo = await probe(temporary);
                  if (Math.abs(outputInfo.duration - info.duration) > Math.max(0.25, 2 / info.frameRate))
                     throw new Error("The shareable did not retain the complete clip. The original is safe.");
                  if (outputInfo.tracks.length !== Math.min(1, info.tracks.length))
                     throw new Error("The shareable's audio could not be verified. The original is safe.");
                  if (size <= Math.floor(targetMB * 1_000_000)) {
                     verified = true;
                     break;
                  }
               }
               if (!verified) throw new Error("The shareable could not fit the size limit. Choose a larger limit.");
               if (controller.signal.aborted) throw new Error("Cancelled");
               if ((await fileIdentity(original)) !== this.stored(id).identity)
                  throw new Error("The original changed during export. Create the shareable again after refreshing.");
               // Hard-link publication is atomic and cannot overwrite a pre-existing file.
               await publishWithoutOverwrite(temporary, final);
               const identity = await fileIdentity(final);
               const size = (await stat(final)).size;
               this.stored(id).shareables.push({
                  id: job.id,
                  relativePath: relative(this.root, final),
                  absolutePath: final,
                  identity,
                  size,
                  targetMB,
                  createdAt: Date.now(),
               });
               await this.writeMetadata();
               await this.scan();
               this.jobUpdate(job, { state: "complete", progress: 1, message: "Shareable ready" });
            } catch (error) {
               this.jobUpdate(job, {
                  state: controller.signal.aborted ? "cancelled" : "failed",
                  message: controller.signal.aborted ? "Shareable cancelled. Original kept." : message(error),
               });
            } finally {
               await Promise.all(temporaryFiles.map((path) => rm(path, { force: true }).catch(() => undefined)));
               this.controllers.delete(job.id);
            }
         });
      this.queue = operation;
      await operation;
   }
   cancelJob(id: string): void {
      this.controllers.get(id)?.abort();
   }

   async playback(path: string, track?: number): Promise<string> {
      const actual = await realpath(path);
      if (!withinRoot(this.root, actual)) throw new Error("The video is outside the current collection.");
      const allowed = this.clips.some((clip) => normal(clip.path) === normal(actual) || clip.shareables.some((share) => normal(share.path) === normal(actual)));
      if (!allowed) throw new Error("That video is not part of this collection.");
      const info = await probe(actual);
      if (track !== undefined && !info.tracks.some((entry) => entry.index === track)) throw new Error("That audio track is no longer available.");
      const extension = extname(actual).toLowerCase();
      const compatibleVideo = ["h264", "av1", "vp9", "vp8"].includes(info.videoCodec);
      const compatibleAudio = info.tracks.every((entry) => ["aac", "opus", "vorbis", "mp3"].includes(entry.codec));
      if (track === undefined && compatibleVideo && compatibleAudio && [".mp4", ".webm", ".m4v"].includes(extension)) return this.url(actual);
      const stamp = await stat(actual);
      const key = createHash("sha256")
         .update(`${actual}:${stamp.size}:${stamp.mtimeMs}:${track ?? "master"}`)
         .digest("hex");
      const destination = join(this.root, ".attaclip", "playback", `${key}.mp4`);
      await this.safeDirectory(dirname(destination));
      try {
         await stat(destination);
         return this.url(destination);
      } catch {
         /* Build the missing playback copy. */
      }
      const temporary = `${destination}.${randomUUID()}.mp4`;
      try {
         const audio = track === undefined ? ["-map", "0:a:0?"] : ["-map", `0:${track}`];
         try {
            if (!compatibleVideo) throw new Error("This video needs a compatible playback copy.");
            await runMedia(
               "ffmpeg",
               [...ffmpegBase, "-y", "-i", actual, "-map", "0:v:0", ...audio, "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", temporary],
               { belowNormal: true }
            );
         } catch {
            await runMedia(
               "ffmpeg",
               [
                  ...ffmpegBase,
                  "-y",
                  "-i",
                  actual,
                  "-map",
                  "0:v:0",
                  ...audio,
                  "-c:v",
                  "libx264",
                  "-preset",
                  "veryfast",
                  "-threads",
                  "2",
                  "-pix_fmt",
                  "yuv420p",
                  "-c:a",
                  "aac",
                  "-movflags",
                  "+faststart",
                  temporary,
               ],
               { belowNormal: true }
            );
         }
         await rename(temporary, destination);
         return this.url(destination);
      } finally {
         await rm(temporary, { force: true });
      }
   }
}
