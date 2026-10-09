import { spawnSync } from "node:child_process";

if (process.platform !== "win32") throw new Error("Native UI verification currently requires Windows with a working hardware encoder.");
for (const args of [
   ["run", "build"],
   ["x", "playwright", "test", "tests/ui/preview-native.spec.ts", "tests/ui/auto-native.spec.ts", "tests/ui/audio-native.spec.ts"],
]) {
   const result = spawnSync(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env, ATTACLIP_NATIVE_UI: "1" },
   });
   if (result.error) throw result.error;
   if (result.status !== 0) process.exit(result.status ?? 1);
}
