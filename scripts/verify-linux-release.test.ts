import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { hashFile } from "./release-sources";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap";
import { verifyAppImageLauncher, verifyAppImageLibraries, verifyLinuxUpdater } from "./verify-linux-release";

it("binds the real container prefix to the exact reviewed launcher", async () => {
   const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-appimage-check-"));
   const runtime = path.join(root, "runtime");
   const image = path.join(root, "image");
   const bytes = Buffer.from("exact official launcher bytes");
   await writeFile(runtime, bytes);
   const expected = { path: "runtime", sha256: await hashFile(runtime), size: bytes.length };
   await writeFile(image, Buffer.concat([bytes, Buffer.from("hsqsactual filesystem bytes")]));
   await expect(verifyAppImageLauncher(image, runtime, expected)).resolves.toBeUndefined();
   await writeFile(image, Buffer.concat([Buffer.from("changed launcher bytes here!!"), Buffer.from("hsqsactual filesystem bytes")]));
   await expect(verifyAppImageLauncher(image, runtime, expected)).rejects.toThrow("launcher differs");
   await writeFile(image, Buffer.concat([bytes, Buffer.from("not a squashfs")]));
   await expect(verifyAppImageLauncher(image, runtime, expected)).rejects.toThrow("payload");
});

it("rejects changed and additional injected libraries", async () => {
   const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-libraries-check-"));
   await mkdir(path.join(root, "usr/lib"), { recursive: true });
   const records = [];
   for (const name of ["libappindicator.so.1", "libgconf-2.so.4", "libindicator.so.7", "libnotify.so.4", "libXss.so.1", "libXtst.so.6"]) {
      const file = path.join(root, "usr/lib", name);
      await writeFile(file, "official byte proof");
      records.push({ path: `usr/lib/${name}`, sha256: await hashFile(file), size: 19 });
   }
   await expect(verifyAppImageLibraries(root, records)).resolves.toBeUndefined();
   await writeFile(path.join(root, "usr/lib/extra.so"), "unreviewed code");
   await expect(verifyAppImageLibraries(root, records)).rejects.toThrow("unexpected");
   await writeFile(path.join(root, "usr/lib/libnotify.so.4"), "changed library bytes");
   await expect(verifyAppImageLibraries(root, records)).rejects.toThrow("changed");
});

it("checks Linux update metadata and regenerates the embedded differential map", async () => {
   const root = await mkdtemp(path.join(os.tmpdir(), "attaclip-linux-updater-"));
   const image = path.join(root, "AttaClip.AppImage");
   await writeFile(image, Buffer.alloc(65000, 42));
   const info = await buildBlockMap(image, "deflate");
   const metadata = { version: "0.1.0", path: "AttaClip.AppImage", sha512: info.sha512, files: [{ url: "AttaClip.AppImage", ...info }] };
   await writeFile(path.join(root, "latest-linux.yml"), JSON.stringify(metadata));
   const scratch = path.join(root, "scratch");
   await mkdir(scratch);
   await expect(verifyLinuxUpdater(image, "0.1.0", scratch)).resolves.toMatchObject({ path: "latest-linux.yml" });
   metadata.files[0]!.sha512 = "previous installer digest";
   await writeFile(path.join(root, "latest-linux.yml"), JSON.stringify(metadata));
   await expect(verifyLinuxUpdater(image, "0.1.0", scratch)).rejects.toThrow("metadata");
});
