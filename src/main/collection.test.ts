import { describe, expect, it, vi } from "vitest";
import { resolve, join } from "node:path";
import { mkdtemp, rm, writeFile, stat, utimes } from "node:fs/promises";
import os from "node:os";
import { CollectionService, withinRoot } from "./collection";
import type * as fileOperations from "node:fs/promises";
import type * as mediaOperations from "./media";

const io = vi.hoisted(() => ({ identities: 0, writes: 0 }));
vi.mock("node:fs/promises", async (original) => {
   const fs = await original<typeof fileOperations>();
   return {
      ...fs,
      open: async (...args: Parameters<typeof fs.open>) => {
         if (args[1] === "r") io.identities++;
         if (args[1] === "wx") io.writes++;
         return fs.open(...args);
      },
   };
});
vi.mock("./media", async (original) => {
   const media = await original<typeof mediaOperations>();
   return {
      ...media,
      probe: async () => ({ duration: 10, width: 640, height: 360, frameRate: 30, videoCodec: "h264", tracks: [] }),
      runMedia: async (_name: string, args: string[]) => {
         await writeFile(args.at(-1)!, "fixture thumbnail");
         return "";
      },
   };
});

describe("collection ownership boundaries", () => {
   const root = resolve("isolated-collection");
   it("accepts collection files and nested folders", () => {
      expect(withinRoot(root, join(root, "game", "clip.mp4"))).toBe(true);
      expect(withinRoot(root, root)).toBe(true);
   });
   it("rejects traversal and sibling folders with matching prefixes", () => {
      expect(withinRoot(root, join(root, "..", "other", "clip.mp4"))).toBe(false);
      expect(withinRoot(root, `${root}-other/clip.mp4`)).toBe(false);
   });
});

describe("collection scan cost and fresh action checks", () => {
   it("keeps a warm 200-file scan free of sampled reads and metadata writes", async () => {
      const root = await mkdtemp(join(os.tmpdir(), "attaclip-scan-cost-"));
      try {
         await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(join(root, `clip-${index}.mp4`), `synthetic media ${index}`)));
         const collection = new CollectionService();
         io.identities = io.writes = 0;
         const initialStart = performance.now();
         await collection.open(root);
         const initialMs = performance.now() - initialStart;
         expect(collection.clips).toHaveLength(200);
         expect(io.identities).toBe(200);
         io.identities = io.writes = 0;
         const warmStart = performance.now();
         await collection.scan();
         const warmMs = performance.now() - warmStart;
         expect(io.identities).toBe(0);
         expect(io.writes).toBe(0);
         console.log(
            `Collection filesystem profile, 200 synthetic files with media probe mocked: initial ${initialMs.toFixed(0)}ms, warm ${warmMs.toFixed(0)}ms.`
         );
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });
   it("skips unchanged sampling and metadata writes, but rereads changed files and before deletion", async () => {
      const root = await mkdtemp(join(os.tmpdir(), "attaclip-scan-"));
      try {
         const file = join(root, "clip.mp4");
         await writeFile(file, "synthetic media fixture");
         const collection = new CollectionService();
         await collection.open(root);
         const id = collection.clips[0]!.id;
         const metadata = join(root, ".attaclip", "collection.json");
         const firstMetadataTime = (await stat(metadata, { bigint: true })).mtimeNs;
         io.identities = io.writes = 0;
         await collection.scan();
         await collection.scan();
         expect(io.identities).toBe(0);
         expect(io.writes).toBe(0);
         expect((await stat(metadata, { bigint: true })).mtimeNs).toBe(firstMetadataTime);
         expect(await collection.filesForDeletion(id)).toEqual([file]);
         expect(io.identities).toBe(1);
         const before = await stat(file);
         await writeFile(file, "different media content");
         await utimes(file, before.atime, before.mtime);
         io.identities = 0;
         await collection.scan();
         expect(io.identities).toBe(1);
         expect(collection.clips[0]!.id).not.toBe(id);
         expect(io.writes).toBe(1);
         // Repair a primary removed outside the app, despite unchanged in-memory metadata.
         await rm(metadata);
         await collection.scan();
         expect((await stat(metadata)).size).toBeGreaterThan(0);
      } finally {
         await rm(root, { recursive: true, force: true });
      }
   });
});
