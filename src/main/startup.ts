import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function desktopExec(executable: string, args: string[]): string {
   const quote = (value: string) => `"${value.replaceAll("%", "%%").replace(/[\\"`$]/g, "\\$&")}"`;
   return [executable, ...args].map(quote).join(" ");
}
export async function linuxStartup(enabled: boolean, configDirectory: string, executable: string, args: string[]): Promise<void> {
   const directory = join(configDirectory, "autostart");
   const path = join(directory, "attaclip.desktop");
   if (!enabled) {
      await rm(path, { force: true });
      return;
   }
   await mkdir(directory, { recursive: true });
   await writeFile(
      path,
      `[Desktop Entry]\nType=Application\nName=AttaClip\nExec=${desktopExec(executable, args)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`
   );
}
