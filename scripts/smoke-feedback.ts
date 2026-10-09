import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import sharp from "sharp";

if (process.platform !== "win32") throw new Error("The native feedback proof requires Windows");
const folder = path.resolve(".cache/native-feedback", randomUUID());
await mkdir(folder, { recursive: true });
const child = spawn(path.resolve("resources/recorder/attaclip-notifier.exe"), [], { windowsHide: true, stdio: "pipe" });
const events: Array<{ event: string; window?: number; visible?: boolean; protected?: boolean; focusPreserved?: boolean }> = [];
const errors: string[] = [];
const metrics: Array<{ memory: number; cpuSeconds: number }> = [];
child.stderr.on("data", (value: Buffer) => errors.push(value.toString()));
createInterface({ input: child.stdout }).on("line", (line) => {
   const event = JSON.parse(line) as (typeof events)[number];
   if (["shown", "hidden"].includes(event.event)) events.push(event);
   else if (event.event === "metrics") metrics.push(JSON.parse(line) as (typeof metrics)[number]);
});
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function wait(count: number): Promise<void> {
   const deadline = Date.now() + 10_000;
   while (events.length < count && Date.now() < deadline && child.exitCode === null) await delay(20);
   assert(events.length >= count, `Feedback failed: ${errors.join("")}`);
}
try {
   for (const [index, value] of [
      { message: "Saving clip...", saving: true },
      { message: "Clip saved", saving: false },
      { message: "The drive is full. Choose another save folder.", error: true },
   ].entries()) {
      const image = path.join(folder, `state-${index}.png`);
      child.stdin.write(`${JSON.stringify({ ...value, proofPath: image })}\n`);
      await wait(index + 1);
      const event = events[index]!;
      assert.equal(event.event, "shown");
      assert.equal(event.visible, true);
      assert.equal(event.protected, true, `Feedback must be excluded from captured media: ${JSON.stringify(event)}`);
      assert.equal(event.focusPreserved, true, "Feedback stole focus from the foreground application");
      assert.equal(event.window, events[0]!.window, "Each update should reuse the same native popup");
      const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert(info.width >= 368 && info.height >= 100);
      assert(data[3]! < 10, "Popup corners must remain transparent");
      let colored = 0;
      for (let pixel = 0; pixel < data.length; pixel += 4) if (data[pixel + 3]! > 200 && data[pixel]! > 100 && data[pixel + 2]! > 100) colored++;
      assert(colored > 100, "The actual native drawing lacks readable text and feedback icon");
   }
   child.stdin.write(`${JSON.stringify({ message: "Clip saved" })}\n`);
   await wait(4);
   await wait(5);
   assert.equal(events[4]!.event, "hidden");
   child.stdin.write(`${JSON.stringify({ action: "metrics" })}\n`);
   await delay(100);
   await delay(1500);
   child.stdin.write(`${JSON.stringify({ action: "metrics" })}\n`);
   await delay(100);
   assert.equal(metrics.length, 2);
   const measurements = { memory: metrics[1]!.memory, idleCPU: metrics[1]!.cpuSeconds - metrics[0]!.cpuSeconds };
   assert(measurements.memory < 40 * 1024 * 1024, "Native feedback memory exceeded 40 MB");
   assert(measurements.idleCPU < 0.1, "Hidden native feedback keeps doing CPU work");
   const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
   child.stdin.end(`${JSON.stringify({ action: "exit" })}\n`);
   assert.equal(await Promise.race([exited, delay(3000).then(() => "timeout")]), 0);
   await writeFile(path.join(folder, "proof.json"), JSON.stringify({ events, measurements }, null, 2));
   console.log(`Native feedback, capture exclusion, focus, drawing, reuse, idle and shutdown passed. ${JSON.stringify(measurements)} ${folder}`);
} finally {
   if (child.exitCode === null) child.kill();
}
