import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linuxDesktopIdentity, linuxDesktopName } from "./startup";

describe("Linux packaged portal identity", () => {
   it("creates a matching desktop entry and updates only entries it owns", async () => {
      const directory = await mkdtemp(join(tmpdir(), "attaclip-desktop-"));
      const file = join(directory, "applications", linuxDesktopName);
      const icon = join(directory, "source-icon.png");
      await writeFile(icon, "isolated app icon");
      await linuxDesktopIdentity(directory, "/apps/My App%.AppImage", icon);
      const initial = await readFile(file, "utf8");
      expect(initial).toContain('Exec="/apps/My App%%.AppImage"');
      expect(initial).toContain("StartupWMClass=dev.attaclip.app");
      expect(initial).toContain("Icon=dev.attaclip.app");
      expect(await readFile(join(directory, "icons", "hicolor", "256x256", "apps", "dev.attaclip.app.png"), "utf8")).toBe("isolated app icon");
      await linuxDesktopIdentity(directory, "/apps/new.AppImage", icon);
      expect(await readFile(file, "utf8")).toContain('Exec="/apps/new.AppImage"');
      await writeFile(file, "[Desktop Entry]\nName=My custom launcher\n");
      await linuxDesktopIdentity(directory, "/apps/third.AppImage", "/apps/icon.png");
      expect(await readFile(file, "utf8")).toBe("[Desktop Entry]\nName=My custom launcher\n");
   });
   it("rejects paths that inject desktop entry keys", async () => {
      const directory = await mkdtemp(join(tmpdir(), "attaclip-desktop-"));
      await expect(linuxDesktopIdentity(directory, "/apps/app\nExec=other", "/apps/icon.png")).rejects.toThrow("app path");
      await expect(linuxDesktopIdentity(directory, "/apps/app", "/apps/icon\nHidden=true")).rejects.toThrow("app path");
   });
});
