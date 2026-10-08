import { describe, expect, test } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameCatalog, parseCatalog, selectGame, type DetectedGame } from "./games";
import type { GameCandidate } from "../shared/types";

const candidate = (id: string, patch: Partial<GameCandidate> = {}): GameCandidate => ({
   id,
   name: "Game window",
   executable: "C:/Games/demo/game.exe",
   pid: 123,
   foreground: false,
   fullscreen: false,
   ...patch,
});
const detected = (id: string, patch: Partial<GameCandidate> = {}): DetectedGame => ({ ...candidate(id, patch), gameId: id, gameName: id });
describe("automatic game selection", () => {
   test("prefers the focused recognized game and retains it during an ordinary-app alt-tab", () => {
      const games = [detected("one", { fullscreen: true }), detected("two", { foreground: true })];
      expect(selectGame(games, "one", new Map())?.id).toBe("two");
      expect(
         selectGame(
            games.map((game) => ({ ...game, foreground: false })),
            "two",
            new Map()
         )?.id
      ).toBe("two");
   });
   test("uses previous game focus, then fullscreen, and waits with no games", () => {
      const games = [detected("one"), detected("two", { fullscreen: true })];
      expect(selectGame(games, null, new Map())?.id).toBe("two");
      expect(selectGame(games, null, new Map([["one", 123]]))?.id).toBe("one");
      expect(selectGame([], "old", new Map())).toBeUndefined();
   });
   test("excludes launchers, respects platform, arguments and exact custom executable paths", async () => {
      const file = join(await mkdtemp(join(tmpdir(), "attaclip-games-")), "catalog.json");
      const entries = [
         { id: "game", name: "Demo", executables: [{ name: "demo/game.exe", os: process.platform }] },
         { id: "launcher", name: "Launcher", executables: [{ name: "launcher.exe", os: process.platform, is_launcher: true }] },
         { id: "wrong-os", name: "Wrong OS", executables: [{ name: "other.exe", os: "not-this-platform" }] },
         { id: "java", name: "Java game", executables: [{ name: "java.exe", os: process.platform, arguments: "game.jar" }] },
         { id: "ambiguous", name: "Other Demo", executables: [{ name: "shared.exe", os: process.platform }] },
         { id: "ambiguous2", name: "Second Demo", executables: [{ name: "shared.exe", os: process.platform }] },
      ];
      await writeFile(file, JSON.stringify({ entries, updated: Date.now() }));
      const catalog = new GameCatalog(file);
      await catalog.load();
      const candidates = [
         candidate("game"),
         candidate("launcher", { executable: "C:/launcher.exe" }),
         candidate("wrong-os", { executable: "C:/other.exe" }),
         candidate("java", { executable: "C:/java.exe" }),
         candidate("shared", { executable: "C:/shared.exe" }),
         candidate("custom", { executable: "C:/custom/game.exe" }),
      ];
      expect(catalog.match(candidates, []).map((game) => game.id)).toEqual(["game"]);
      expect(catalog.match(candidates, [{ executable: "c:\\custom\\GAME.EXE", name: "My game" }]).map((game) => game.id)).toEqual(["game", "custom"]);
      expect(catalog.match([candidate("java", { executable: "C:/java.exe", arguments: "-jar game.jar" })], [])[0]?.gameName).toBe("Java game");
   });
   test("rejects empty or corrupt replacement catalogs", () => {
      expect(() => parseCatalog({})).toThrow();
      expect(() => parseCatalog([{ id: "bad", name: "Bad", executables: [{ name: "exe" }] }])).toThrow();
   });
});
