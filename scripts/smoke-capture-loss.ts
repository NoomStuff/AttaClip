import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";

if (process.platform !== "win32") throw new Error("This real application capture test requires Windows");
const runtime = path.resolve("resources/recorder");
const folder = path.resolve(".cache/native-loss", randomUUID());
await mkdir(folder, { recursive: true });
const title = `AttaClip capture fixture ${randomUUID()}`;
const appAudio = Boolean(process.env["ATTACLIP_TEST_APP_AUDIO"]);
const tonePath = path.join(folder, "fixture-tone.wav");
if (appAudio) {
   const tone = spawnSync(
      path.resolve("resources/media/ffmpeg.exe"),
      ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=70", "-ac", "2", tonePath],
      { encoding: "utf8", windowsHide: true }
   );
   assert.equal(tone.status, 0, tone.stderr);
}
const escapePowerShell = (value: string): string => value.replaceAll("'", "''");
const fixtureScript = path.join(folder, "fixture.ps1");
const handlePath = path.join(folder, "handle.txt");
const actionPath = path.join(folder, "action.txt");
await writeFile(
   fixtureScript,
   `
Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System; using System.Runtime.InteropServices; public class FixtureWindow { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command); }'
$form = New-Object System.Windows.Forms.Form
$form.Text = '${escapePowerShell(title)}'
$form.ClientSize = New-Object System.Drawing.Size(640,360)
$form.BackColor = [System.Drawing.Color]::DodgerBlue
$form.ShowInTaskbar = $true
$form.TopMost = $true
${appAudio ? `$player = New-Object System.Media.SoundPlayer('${escapePowerShell(tonePath)}'); $player.PlayLooping()` : ""}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  if (Test-Path -LiteralPath '${escapePowerShell(actionPath)}') {
    $action = Get-Content -LiteralPath '${escapePowerShell(actionPath)}' -Raw
    Remove-Item -LiteralPath '${escapePowerShell(actionPath)}'
    if ($action -eq 'minimize') { $form.WindowState = 'Minimized' }
    if ($action -eq 'restore') { $form.WindowState = 'Normal'; $form.Activate() }
    if ($action -eq 'exit') { $form.Close() }
  }
})
$form.Add_Shown({ [FixtureWindow]::ShowWindow($form.Handle,5) | Out-Null; [System.IO.File]::WriteAllText('${escapePowerShell(handlePath)}', $form.Handle.ToInt64().ToString()); $timer.Start() })
[System.Windows.Forms.Application]::Run($form)
$timer.Dispose()
$form.Dispose()
${appAudio ? "$player.Stop(); $player.Dispose()" : ""}
`
);
const fixture = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", fixtureScript], { windowsHide: true, stdio: "ignore" });
interface NativeEvent {
   event: string;
   id?: string;
   requestId?: string;
   waiting?: boolean;
   previousFootage?: boolean;
   secondsSinceCapture?: number;
   availableSeconds?: number;
   message?: string;
}
const events: NativeEvent[] = [];
const logs: string[] = [];
const helper = spawn(path.join(runtime, "attaclip-recorder.exe"), [runtime], { cwd: runtime, windowsHide: true, stdio: "pipe" });
helper.stderr.on("data", (value: Buffer) => logs.push(value.toString()));
createInterface({ input: helper.stdout }).on("line", (line) => events.push(JSON.parse(line) as NativeEvent));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(predicate: (event: NativeEvent) => boolean, after = 0): Promise<NativeEvent> {
   const deadline = Date.now() + 20000;
   while (Date.now() < deadline) {
      const event = events.slice(after).find(predicate);
      if (event) return event;
      if (helper.exitCode !== null) throw new Error(`Recorder exited ${helper.exitCode}`);
      await delay(20);
   }
   throw new Error(`Native event timed out: ${JSON.stringify(events)}`);
}
async function command(value: Record<string, unknown>): Promise<void> {
   const id = randomUUID();
   helper.stdin.write(`${JSON.stringify({ ...value, id })}\n`);
   const result = await wait((event) => event.id === id);
   assert.equal(result.event, "response", result.message ?? "Native command failed");
}
async function verify(name: string, minimumDuration: number): Promise<NativeEvent> {
   const file = path.join(folder, `${name}.mkv`);
   await command({ action: "save", requestId: name, requestedAt: Date.now(), path: file });
   const saved = await wait((event) => event.event === "saved" && event.requestId === name);
   const probe = spawnSync(path.resolve("resources/media/ffprobe.exe"), ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], {
      encoding: "utf8",
      windowsHide: true,
   });
   assert.equal(probe.status, 0, probe.stderr);
   const duration = Number((JSON.parse(probe.stdout) as { format: { duration: string } }).format.duration);
   assert(duration > minimumDuration && duration < 3.2, `${name}: wrong duration ${duration}`);
   const decode = spawnSync(path.resolve("resources/media/ffmpeg.exe"), ["-v", "error", "-i", file, "-f", "null", "-"], {
      encoding: "utf8",
      windowsHide: true,
   });
   assert.equal(decode.status, 0, decode.stderr);
   const pixel = spawnSync(
      path.resolve("resources/media/ffmpeg.exe"),
      ["-v", "error", "-ss", "0.4", "-i", file, "-vf", "crop=2:2:iw/2:ih/2,scale=1:1", "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
      { windowsHide: true }
   );
   assert.equal(pixel.status, 0, pixel.stderr.toString());
   assert(
      pixel.stdout.length === 3 && pixel.stdout[0]! < 60 && pixel.stdout[1]! > 80 && pixel.stdout[2]! > 130,
      `${name}: expected the blue fixture, got ${[...pixel.stdout]}`
   );
   if (appAudio) {
      for (const track of [0, 1]) {
         const measured = spawnSync(
            path.resolve("resources/media/ffmpeg.exe"),
            ["-hide_banner", "-i", file, "-map", `0:a:${track}`, "-af", "volumedetect", "-f", "null", "-"],
            { encoding: "utf8", windowsHide: true }
         );
         assert.equal(measured.status, 0, measured.stderr);
         const volume = /mean_volume: (-?[\d.]+) dB/.exec(measured.stderr)?.[1];
         assert(volume && Number(volume) > -65, `${name}: application tone missing from track ${track}: ${volume}`);
         console.log(`${name} application audio track ${track}: ${volume} dB`);
      }
   }
   return saved;
}
try {
   let handle = "";
   for (let i = 0; i < 100 && !handle; i++) {
      handle = await readFile(handlePath, "utf8").catch(() => "");
      await delay(50);
   }
   assert(handle, "The fixture window did not open");
   await delay(1000);
   await wait((event) => event.event === "ready");
   await command({
      action: "start",
      sourceKind: "app",
      sourceId: `window:${handle}:0`,
      sourceName: title,
      quality: "custom",
      customWidth: 640,
      customHeight: 360,
      customFPS: 24,
      customCQ: 28,
      clipSeconds: 2,
      captureAudio: appAudio,
      microphone: false,
   });
   await delay(4000);
   await verify("healthy", 1.5);
   await writeFile(actionPath, "minimize");
   await delay(5000);
   let after = events.length;
   await command({ action: "status" });
   const waiting = await wait((event) => event.event === "status", after);
   assert.equal(waiting.waiting, true);
   assert((waiting.availableSeconds ?? 0) > 1.5, "Valid earlier history was lost");
   const earlier = await verify("minimized", 1.5);
   assert.equal(earlier.previousFootage, true);
   assert((earlier.secondsSinceCapture ?? 0) > 4, "The save must explain it uses earlier footage");
   await writeFile(actionPath, "restore");
   await delay(5000);
   after = events.length;
   await command({ action: "status" });
   assert.equal((await wait((event) => event.event === "status", after)).waiting, false);
   const resumed = await verify("resumed", 1.5);
   assert.equal(resumed.previousFootage, false, "Resumed footage should use current capture");
   await writeFile(actionPath, "exit");
   await delay(5000);
   const closed = await verify("closed", 1.5);
   assert.equal(closed.previousFootage, true);
   await command({ action: "stop" });
   helper.stdin.end('{"action":"exit"}\n');
   await new Promise<void>((resolve, reject) => helper.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Native exit ${code}`)))));
   console.log(`Real app capture, minimize, resume, close, preserved history and full decode passed: ${folder}`);
} finally {
   if (helper.exitCode === null) helper.kill();
   if (fixture.exitCode === null) fixture.kill();
   await writeFile(path.join(folder, "events.json"), JSON.stringify(events, null, 2));
   await writeFile(path.join(folder, "native.log"), logs.join(""));
}
