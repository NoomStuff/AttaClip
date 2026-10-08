import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GameCandidate, CustomGame } from "../shared/types";

export interface GameDefinition {
   id: string;
   name: string;
   executables: { name: string; os: string; arguments?: string; is_launcher?: boolean }[];
}
export interface DetectedGame extends GameCandidate {
   gameId: string;
   gameName: string;
}
const endpoint = "https://discord.com/api/v9/applications/detectable";
const normalize = (value: string) => value.replaceAll("\\", "/").toLowerCase();
// Independently maintained fallback facts, not a redistributed Discord snapshot.
const fallback: GameDefinition[] = [
   ["Roblox", "robloxplayerbeta.exe"],
   ["Counter-Strike 2", "cs2.exe"],
   ["Dota 2", "dota2.exe"],
   ["Fortnite", "fortniteclient-win64-shipping.exe"],
   ["Rocket League", "rocketleague.exe"],
   ["VALORANT", "valorant-win64-shipping.exe"],
   ["League of Legends", "league of legends.exe"],
   ["Minecraft", "minecraft.windows.exe"],
   ["Grand Theft Auto V", "gta5.exe"],
   ["Overwatch", "overwatch.exe"],
   ["Apex Legends", "r5apex.exe"],
   ["Baldur's Gate 3", "bg3.exe"],
   ["Baldur's Gate 3", "bg3_dx11.exe"],
].map(([name, executable]) => ({ id: `builtin:${name}`, name: name!, executables: [{ name: executable!, os: "win32" }] }));

export function parseCatalog(input: unknown): GameDefinition[] {
   if (!Array.isArray(input) || input.length > 100_000) throw new Error("The game catalog is invalid");
   const entries: GameDefinition[] = [];
   for (const item of input) {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || typeof item.name !== "string" || !Array.isArray(item.executables)) continue;
      if (item.name.length > 200 || item.id.length > 100) continue;
      const executables = item.executables.filter(
         (exe: unknown): exe is GameDefinition["executables"][number] =>
            !!exe &&
            typeof exe === "object" &&
            "name" in exe &&
            typeof exe.name === "string" &&
            exe.name.length <= 1000 &&
            "os" in exe &&
            typeof exe.os === "string" &&
            (!("arguments" in exe) || typeof exe.arguments === "string") &&
            (!("is_launcher" in exe) || typeof exe.is_launcher === "boolean")
      );
      if (executables.length) entries.push({ id: item.id, name: item.name, executables });
   }
   if (!entries.length) throw new Error("The game catalog has no usable entries");
   return entries;
}

export class GameCatalog {
   private entries = fallback;
   private index = new Map<string, { game: GameDefinition; suffix: string; arguments?: string }[]>();
   private loading: Promise<void> | null = null;
   private loaded = false;
   private updated = 0;
   private attempted = 0;
   private readonly file: string;
   private readonly onWarning: (message: string) => void;
   constructor(file: string, onWarning: (message: string) => void = () => undefined) {
      this.file = file;
      this.onWarning = onWarning;
      this.reindex();
   }
   private reindex(): void {
      this.index.clear();
      for (const game of this.entries)
         for (const executable of game.executables) {
            if (executable.is_launcher || executable.os !== process.platform) continue;
            const suffix = normalize(executable.name).replace(/^>/, "");
            const base = suffix.split("/").at(-1)!;
            const bucket = this.index.get(base) ?? [];
            bucket.push({ game, suffix, ...(executable.arguments ? { arguments: executable.arguments } : {}) });
            this.index.set(base, bucket);
         }
   }
   async load(): Promise<void> {
      if (this.loaded) return;
      this.loaded = true;
      try {
         const saved: unknown = JSON.parse(await readFile(this.file, "utf8"));
         if (saved && typeof saved === "object" && "entries" in saved) {
            this.entries = parseCatalog(saved.entries);
            if ("updated" in saved && typeof saved.updated === "number") this.updated = saved.updated;
            this.reindex();
         }
      } catch {
         /* Offline capture remains available with the fallback and local additions. */
      }
   }
   async refresh(): Promise<void> {
      await this.load();
      if (Date.now() - this.updated < 7 * 24 * 60 * 60 * 1000) return;
      if (this.loading) return this.loading;
      if (Date.now() - this.attempted < 60 * 60 * 1000) return;
      this.attempted = Date.now();
      this.loading = (async () => {
         try {
            const response = await fetch(endpoint, { signal: AbortSignal.timeout(15_000), credentials: "omit", redirect: "error" });
            if (!response.ok) throw new Error(`Catalog download failed with status ${response.status}`);
            const reader = response.body?.getReader();
            if (!reader) throw new Error("Catalog download was empty");
            const parts: Uint8Array[] = [];
            let size = 0;
            while (true) {
               const { done, value } = await reader.read();
               if (done) break;
               size += value.byteLength;
               if (size > 32 * 1024 * 1024) {
                  await reader.cancel();
                  throw new Error("Catalog download was too large");
               }
               parts.push(value);
            }
            const entries = parseCatalog(JSON.parse(Buffer.concat(parts).toString("utf8")));
            await mkdir(dirname(this.file), { recursive: true });
            const next = `${this.file}.next`;
            const updated = Date.now();
            await writeFile(next, JSON.stringify({ updated, entries }));
            await rename(next, this.file);
            this.entries = entries;
            this.updated = updated;
            this.reindex();
         } catch {
            this.onWarning("Game catalog could not update. Using the saved list and your added games.");
         }
      })().finally(() => {
         this.loading = null;
      });
      return this.loading;
   }
   match(candidates: GameCandidate[], additions: CustomGame[]): DetectedGame[] {
      return candidates.flatMap((candidate) => {
         const executable = normalize(candidate.executable);
         const custom = additions.find((game) => normalize(game.executable) === executable);
         if (custom) return [{ ...candidate, gameId: `custom:${executable}`, gameName: custom.name }];
         const base = executable.split("/").at(-1)!;
         const matches = (this.index.get(base) ?? []).filter(
            (entry) =>
               (executable === entry.suffix || executable.endsWith(`/${entry.suffix}`)) && (!entry.arguments || candidate.arguments?.includes(entry.arguments))
         );
         const ids = new Set(matches.map((entry) => entry.game.id));
         // Ambiguous generic executables must be added explicitly, not guessed.
         if (ids.size !== 1) return [];
         const game = matches[0]!.game;
         return [{ ...candidate, gameId: game.id, gameName: game.name }];
      });
   }
}

export function selectGame(games: DetectedGame[], currentId: string | null, lastFocused: Map<string, number>): DetectedGame | undefined {
   const foreground = games.find((game) => game.foreground);
   if (foreground) return foreground;
   const current = games.find((game) => game.id === currentId);
   if (current) return current;
   return [...games].sort(
      (a, b) => (lastFocused.get(b.id) ?? 0) - (lastFocused.get(a.id) ?? 0) || Number(b.fullscreen) - Number(a.fullscreen) || a.id.localeCompare(b.id)
   )[0];
}
