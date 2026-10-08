import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";

// The NSIS launcher does not forward Electron's inspector stderr. Connect to
// its child over a reserved localhost port, then run the same media assertions.
const { version } = z.object({ version: z.string().regex(/^[\w.-]+$/) }).parse(JSON.parse(await readFile("package.json", "utf8")));
process.env["ATTACLIP_PACKAGED_PORTABLE"] = "1";
process.env["ATTACLIP_PACKAGED_EXE"] = path.resolve(process.argv[2] ?? `release/AttaClip-${version}-win-x64.exe`);
await import("../tests/packaged");
