import { test, expect, _electron as electron } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultPreferences } from "../../src/shared/defaults";

test("Auto waits privately, adds a local game and follows it without losing accepted clips", async () => {
   test.skip(process.platform !== "win32" || process.env["ATTACLIP_NATIVE_UI"] !== "1", "Requires actual Windows capture");
   test.setTimeout(100_000);
   const profile = await mkdtemp(join(tmpdir(), "attaclip-auto-native-"));
   const collection = join(profile, "clips");
   await mkdir(collection);
   const title = `Clip detector fixture ${Date.now()}`;
   const action = join(profile, "focus.txt");
   const handle = join(profile, "handle.txt");
   const script = join(profile, "fixture.ps1");
   const quoted = (value: string) => value.replaceAll("'", "''");
   await writeFile(
      script,
      `
Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System; using System.Runtime.InteropServices; public class FocusFixture { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command); }'
$form = New-Object System.Windows.Forms.Form
$form.Text = '${quoted(title)}'
$form.ClientSize = New-Object System.Drawing.Size(640,360)
$form.BackColor = [System.Drawing.Color]::DodgerBlue
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
 if (Test-Path -LiteralPath '${quoted(action)}') {
  $command = Get-Content -LiteralPath '${quoted(action)}' -Raw
  Remove-Item -LiteralPath '${quoted(action)}'
  if ($command -eq 'focus') { $form.WindowState = 'Normal'; $form.Activate(); [FocusFixture]::SetForegroundWindow($form.Handle) | Out-Null }
  if ($command -eq 'exit') { $form.Close() }
 }
})
$form.Add_Shown({ [FocusFixture]::ShowWindow($form.Handle,5) | Out-Null; [System.IO.File]::WriteAllText('${quoted(handle)}', $form.Handle.ToInt64().ToString()); $timer.Start() })
[System.Windows.Forms.Application]::Run($form)
$timer.Dispose()
$form.Dispose()
`
   );
   const fixture = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, stdio: "ignore" });
   await writeFile(
      join(profile, "preferences.json"),
      JSON.stringify({
         ...defaultPreferences,
         collection,
         setupComplete: true,
         sourceKind: "auto",
         clipSeconds: 5,
         quality: "custom",
         customWidth: 640,
         customHeight: 360,
         customFPS: 24,
         captureAudio: false,
      })
   );
   const desktop = await electron.launch({
      args: [resolve("."), "--disable-gpu-sandbox"],
      env: { ...process.env, ATTACLIP_TEST: "1", ATTACLIP_PROFILE: profile, ATTACLIP_COLLECTION: collection },
   });
   try {
      await expect
         .poll(async () => {
            try {
               return await readFile(handle, "utf8");
            } catch {
               return "";
            }
         })
         .not.toBe("");
      const page = await desktop.firstWindow();
      console.log("Auto fixture and app opened");
      await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Start recording", exact: true }).click();
      console.log("Auto recording start requested");
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).recorder.state).toBe("waiting");
      expect((await page.evaluate(() => window.attaClip.state())).recorder.availableSeconds).toBe(0);
      await page.getByRole("button", { name: "Add game", exact: true }).click();
      console.log("Auto waiting state confirmed");
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.games())).some((game) => game.name === title)).toBe(true);
      const candidate = (await page.evaluate(() => window.attaClip.games())).find((game) => game.name === title)!;
      await page.getByRole("combobox", { name: "Running application" }).selectOption(candidate.id);
      await page.getByRole("button", { name: "Add selected game", exact: true }).click();
      console.log("Local fixture game added");
      await writeFile(action, "focus");
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).recorder.sourceId, { timeout: 20_000 }).toBe(candidate.id);
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).recorder.availableSeconds, { timeout: 15_000 }).toBeGreaterThan(3);
      await desktop.evaluate(({ BrowserWindow }) => {
         const window = BrowserWindow.getAllWindows().find((item) => item.getTitle() === "AttaClip");
         window?.show();
         window?.focus();
      });
      await page.getByRole("button", { name: "Library", exact: true }).click();
      await page.waitForTimeout(1500);
      expect((await page.evaluate(() => window.attaClip.state())).recorder.sourceId).toBe(candidate.id);
      await page.evaluate(() => window.attaClip.saveClip());
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).clips.length, { timeout: 20_000 }).toBe(1);
      const clip = (await page.evaluate(() => window.attaClip.state())).clips[0]!;
      expect(clip.source).toBe(title);
      expect(clip.duration).toBeGreaterThan(3);
      const decoded = spawnSync(resolve("resources/media/ffmpeg.exe"), ["-v", "error", "-i", clip.path, "-f", "null", "-"], {
         encoding: "utf8",
         windowsHide: true,
      });
      expect(decoded.status, decoded.stderr).toBe(0);
      const image = spawnSync(
         resolve("resources/media/ffmpeg.exe"),
         ["-v", "error", "-ss", "1", "-i", clip.path, "-vf", "crop=400:200:80:80,signalstats,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-"],
         { windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
      );
      expect(image.status).toBe(0);
      const luma = Number(/lavfi.signalstats.YAVG=([\d.]+)/.exec(image.stdout)?.[1]);
      const blue = Number(/lavfi.signalstats.UAVG=([\d.]+)/.exec(image.stdout)?.[1]);
      expect(luma).toBeGreaterThan(50);
      expect(blue).toBeGreaterThan(160);
      await writeFile(action, "exit");
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).recorder.state, { timeout: 20_000 }).toBe("waiting");
      await expect.poll(async () => (await page.evaluate(() => window.attaClip.state())).recorder.sourceKind).toBe("waiting");
      await page.evaluate(() => window.attaClip.stopRecording());
      expect((await page.evaluate(() => window.attaClip.state())).recorder.availableSeconds).toBe(0);
      const saved = JSON.parse(await readFile(join(profile, "preferences.json"), "utf8"));
      expect(saved.customGames).toEqual([{ name: title, executable: candidate.executable }]);
      expect(saved.desktopFallback).toBe(false);
   } finally {
      await desktop.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
      await desktop.close().catch(() => undefined);
      if (fixture.exitCode === null) fixture.kill();
   }
});
