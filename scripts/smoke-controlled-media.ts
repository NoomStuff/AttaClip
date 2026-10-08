import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readControlledBuild } from "./controlled-media";

interface Probe {
   streams: { codec_type?: string; codec_name?: string }[];
   format: { duration?: string };
}
const project = process.cwd();
const directory = path.join(project, "work/controlled-media/windows-x64");
await readControlledBuild(directory);
const reference = process.env["ATTACLIP_REFERENCE_FFMPEG"] || path.join(project, "resources/media/ffmpeg.exe");
const controlled = path.join(directory, "ffmpeg.exe");
const probe = path.join(directory, "ffprobe.exe");
if (path.resolve(reference) === path.resolve(controlled)) throw new Error("Fixture generation needs the independent full reference FFmpeg.");
const temporary = await mkdtemp(path.join(project, "work", "controlled-codecs-"));
const result: { format: string; video: string; audio: string; duration: number; firstFrameMatches: boolean }[] = [];
const execute = (file: string, args: string[]) =>
   execFileSync(file, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
const fixtures = [
   { file: "h264-aac.mp4", video: "libx264", audio: "aac", options: ["-preset", "ultrafast"] },
   {
      file: "hevc-10bit.mkv",
      video: "libx265",
      audio: "aac",
      options: ["-pix_fmt", "yuv420p10le", "-preset", "ultrafast", "-x265-params", "pools=2:frame-threads=1:log-level=error"],
   },
   { file: "av1-aac.mp4", video: "libaom-av1", audio: "aac", options: ["-cpu-used", "8", "-threads", "2", "-crf", "35"] },
   { file: "vp9-opus.webm", video: "libvpx-vp9", audio: "libopus", options: ["-deadline", "realtime", "-cpu-used", "8", "-threads", "2"] },
   { file: "vp8-vorbis.webm", video: "libvpx", audio: "libvorbis", options: ["-deadline", "realtime", "-cpu-used", "8", "-threads", "2"] },
   { file: "h264-flac.mkv", video: "libx264", audio: "flac", options: ["-preset", "ultrafast"] },
   { file: "h264-mp3.mkv", video: "libx264", audio: "libmp3lame", options: ["-preset", "ultrafast"] },
   { file: "h264-pcm.mov", video: "libx264", audio: "pcm_s16le", options: ["-preset", "ultrafast"] },
];
for (const fixture of fixtures) {
   const clip = path.join(temporary, fixture.file);
   execute(reference, [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=550:sample_rate=48000",
      "-t",
      "1.25",
      "-c:v",
      fixture.video,
      ...fixture.options,
      "-c:a",
      fixture.audio,
      "-y",
      clip,
   ]);
   const info = JSON.parse(
      execFileSync(probe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", clip], { windowsHide: true, encoding: "utf8" })
   ) as Probe;
   const duration = Number(info.format.duration);
   if (duration < 1.2 || duration > 1.4 || !info.streams.some((stream) => stream.codec_type === "audio"))
      throw new Error(`Fixture metadata failed: ${fixture.file}`);
   execute(controlled, ["-i", clip, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "NUL"]);
   const referenceImage = path.join(temporary, `${fixture.file}.reference.png`);
   const controlledImage = path.join(temporary, `${fixture.file}.controlled.png`);
   for (const [binary, image] of [
      [reference, referenceImage],
      [controlled, controlledImage],
   ])
      execute(binary!, ["-i", clip, "-map", "0:v:0", "-frames:v", "1", "-c:v", "png", "-y", image!]);
   const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
   const matches = hash(await readFile(referenceImage)) === hash(await readFile(controlledImage));
   if (!matches) throw new Error(`Decoded first frame differs from reference: ${fixture.file}`);
   result.push({
      format: fixture.file,
      video: info.streams.find((stream) => stream.codec_type === "video")?.codec_name ?? "",
      audio: info.streams.find((stream) => stream.codec_type === "audio")?.codec_name ?? "",
      duration,
      firstFrameMatches: matches,
   });
}
await mkdir(path.join(directory, "verification"), { recursive: true });
await writeFile(
   path.join(directory, "verification/codecs.json"),
   `${JSON.stringify(
      {
         referenceSha256: createHash("sha256")
            .update(await readFile(reference))
            .digest("hex"),
         results: result,
      },
      null,
      2
   )}\n`
);
console.log(`Controlled media passed ${result.length} video/audio/container import fixtures and exact decoded first-frame comparisons.`);
