import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";

if (process.platform !== "win32") throw new Error("This loopback smoke test requires Windows and an NVENC GPU");
const folder = path.resolve(".cache", "native-audio", randomUUID());
await mkdir(folder, { recursive: true });
const ffmpeg = path.resolve("resources/media/ffmpeg.exe");
const ffprobe = path.resolve("resources/media/ffprobe.exe");
const tonePath = path.join(folder, "tone.wav");
const generated = spawnSync(
   ffmpeg,
   ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=8", "-ac", "2", "-c:a", "pcm_s16le", tonePath],
   { windowsHide: true, encoding: "utf8" }
);
assert.equal(generated.status, 0, generated.stderr);
const toneScript = path.join(folder, "play-tone.ps1");
await writeFile(
   toneScript,
   `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.IO; using System.Threading;
public class TonePlayer {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Caps { public ushort mid,pid; public uint version; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name; public uint formats; public ushort channels,reserved; public uint support; }
 [StructLayout(LayoutKind.Sequential,Pack=2)] struct Format { public ushort tag,channels; public uint samples,bytes; public ushort align,bits,size; }
 [StructLayout(LayoutKind.Sequential)] struct Header { public IntPtr data; public uint length,recorded; public IntPtr user; public uint flags,loops; public IntPtr next,reserved; }
 [DllImport("winmm.dll")] static extern uint waveOutGetNumDevs();
 [DllImport("winmm.dll",CharSet=CharSet.Unicode)] static extern uint waveOutGetDevCapsW(UIntPtr id,out Caps caps,uint size);
 [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr handle,uint id,ref Format format,IntPtr callback,IntPtr instance,uint flags);
 [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr handle,ref Header header,uint size);
 [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr handle,ref Header header,uint size);
 [DllImport("winmm.dll")] static extern uint waveOutSetVolume(IntPtr handle,uint volume);
 [DllImport("winmm.dll")] static extern uint waveOutReset(IntPtr handle);
 [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr handle);
 public static void Play(string file) {
  uint id=0xffffffff; for(uint i=0;i<waveOutGetNumDevs();i++){Caps caps;waveOutGetDevCapsW((UIntPtr)i,out caps,(uint)Marshal.SizeOf(typeof(Caps))); Console.WriteLine(caps.name); if(caps.name.Contains("2475W1"))id=i;}
  if(id==0xffffffff)throw new Exception("The explicit loopback test output was not found");
  byte[] wav=File.ReadAllBytes(file); int offset=12; while(System.Text.Encoding.ASCII.GetString(wav,offset,4)!="data")offset+=8+BitConverter.ToInt32(wav,offset+4); int count=BitConverter.ToInt32(wav,offset+4); offset+=8;
  IntPtr memory=Marshal.AllocHGlobal(count); Marshal.Copy(wav,offset,memory,count);
  var format=new Format{tag=1,channels=2,samples=48000,bytes=192000,align=4,bits=16,size=0}; IntPtr handle;
  if(waveOutOpen(out handle,id,ref format,IntPtr.Zero,IntPtr.Zero,0)!=0)throw new Exception("Output open failed");
  waveOutSetVolume(handle,0xffffffff);
  var header=new Header{data=memory,length=(uint)count,flags=12,loops=20}; uint size=(uint)Marshal.SizeOf(typeof(Header));
  if(waveOutPrepareHeader(handle,ref header,size)!=0 || waveOutWrite(handle,ref header,size)!=0)throw new Exception("Tone playback failed");
  Thread.Sleep(90000); waveOutReset(handle);waveOutClose(handle); Marshal.FreeHGlobal(memory);
 }
}
'@
[TonePlayer]::Play('${tonePath.replaceAll("'", "''")}')
`
);
const tone = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", toneScript], { windowsHide: true, stdio: "pipe" });
tone.stderr.on("data", (data: Buffer) => console.error(data.toString()));
const runtime = path.resolve("resources/recorder");
const helper = spawn(path.join(runtime, "attaclip-recorder.exe"), [runtime], { cwd: runtime, windowsHide: true, stdio: "pipe" });
interface Event {
   event: string;
   id?: string;
   requestId?: string;
   message?: string;
   capture?: number;
}
const events: Event[] = [];
const diagnostics: string[] = [];
helper.stderr.on("data", (data: Buffer) => diagnostics.push(data.toString()));
createInterface({ input: helper.stdout }).on("line", (line: string) => events.push(JSON.parse(line) as Event));
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function wait(predicate: (event: Event) => boolean): Promise<Event> {
   const deadline = Date.now() + 20000;
   while (Date.now() < deadline) {
      const event = events.find(predicate);
      if (event) return event;
      if (helper.exitCode !== null) throw new Error(`Recorder exited ${helper.exitCode}`);
      await delay(20);
   }
   throw new Error(`Timed out: ${JSON.stringify(events)}`);
}
async function command(value: Record<string, unknown>): Promise<void> {
   const id = randomUUID();
   helper.stdin.write(`${JSON.stringify({ ...value, id })}\n`);
   const response = await wait((event) => event.id === id);
   assert.equal(response.event, "response", response.message ?? "Native command failed");
}
function rms(file: string, track: number): number {
   const measured = spawnSync(ffmpeg, ["-hide_banner", "-i", file, "-map", `0:a:${track}`, "-af", "volumedetect", "-f", "null", "-"], {
      windowsHide: true,
      encoding: "utf8",
   });
   assert.equal(measured.status, 0, measured.stderr);
   const match = /mean_volume: (-?[\d.]+) dB/.exec(measured.stderr);
   assert(match, measured.stderr);
   return Number(match[1]);
}
try {
   await wait((event) => event.event === "ready");
   await command({
      action: "start",
      sourceKind: "screen",
      screenIndex: 0,
      sourceName: "Audio test",
      clipSeconds: 2,
      quality: "custom",
      customWidth: 640,
      customHeight: 360,
      customFPS: 24,
      customCQ: 28,
      captureAudio: true,
      microphone: false,
      captureVolume: 0.5,
      captureMuted: false,
   });
   const measurements: Record<string, number[]> = {};
   for (const [name, volume, muted] of [
      ["initial-half", 0.5, false],
      ["full", 1, false],
      ["half-after-switch", 0.5, false],
      ["muted", 1, true],
   ] as const) {
      if (name !== "initial-half") await command({ action: "audio", source: "capture", volume, muted });
      if (name === "half-after-switch")
         await command({ action: "source", sourceKind: "screen", screenIndex: 0, sourceName: "Switched audio test", captureAudio: true });
      await delay(4000);
      const file = path.join(folder, `${name}.mkv`);
      await command({ action: "save", path: file, requestId: name, requestedAt: Date.now() });
      await wait((event) => event.event === "saved" && event.requestId === name);
      measurements[name] = [rms(file, 0), rms(file, 1)];
      const probe = spawnSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", file], {
         windowsHide: true,
         encoding: "utf8",
      });
      assert.equal(probe.status, 0, probe.stderr);
      const result = JSON.parse(probe.stdout) as { streams: Array<{ width: number; height: number; r_frame_rate: string }> };
      assert.deepEqual(result.streams[0], { width: 640, height: 360, r_frame_rate: "24/1" });
   }
   const full = measurements["full"]!;
   assert(full[0]! > -55, `The loopback did not receive the generated tone: ${JSON.stringify(measurements)}`);
   for (let track = 0; track < 2; track++) {
      for (const half of ["initial-half", "half-after-switch"])
         assert(Math.abs(full[track]! - measurements[half]![track]! - 6.02) < 1, JSON.stringify(measurements));
      assert(measurements["muted"]![track]! < -70, JSON.stringify(measurements));
   }
   assert(
      events.some((event) => event.event === "audio-levels" && (event.capture ?? 0) > 0.05),
      "No measured audio levels arrived"
   );
   await command({ action: "stop" });
   helper.stdin.write(`${JSON.stringify({ action: "exit" })}\n`);
   await new Promise<void>((resolve) => helper.once("exit", () => resolve()));
   assert.equal(helper.exitCode, 0);
   await writeFile(path.join(folder, "measurements.json"), JSON.stringify(measurements, null, 2));
   console.log(
      `Audio smoke passed. Persisted gain, live gain, source-switch gain, mute on master and isolated AAC, measured levels, and custom 640x360 at 24 fps. ${JSON.stringify(measurements)}`
   );
   console.log(folder);
} finally {
   tone.kill();
   if (helper.exitCode === null) helper.kill();
   await writeFile(path.join(folder, "native.log"), diagnostics.join(""));
   await writeFile(path.join(folder, "events.json"), JSON.stringify(events, null, 2));
}
