import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { Notification } from "electron";

/** Feedback is independent of the library renderer and never acquires focus. */
export class Feedback {
   private child: ChildProcessWithoutNullStreams | null = null;
   private notification: Notification | null = null;
   private readonly executable: string;
   private readonly onWarning: (message: string) => void;
   constructor(executable: string, onWarning: (message: string) => void) {
      this.executable = executable;
      this.onWarning = onWarning;
   }
   show(message: string, error = false, saving = false): void {
      if (existsSync(this.executable)) {
         try {
            const child = this.child ?? spawn(this.executable, [], { windowsHide: true, stdio: "pipe" });
            if (!this.child) {
               this.child = child;
               child.stdout.resume();
               child.stderr.on("data", (value: Buffer) => this.onWarning(value.toString("utf8").slice(0, 4000)));
               child.once("error", (failure) => {
                  if (this.child === child) this.child = null;
                  this.onWarning(`Native feedback failed: ${failure.message}`);
                  this.system(message);
               });
               child.once("exit", () => {
                  if (this.child === child) this.child = null;
               });
               child.stdin.on("error", () => {
                  if (this.child === child) this.child = null;
               });
            }
            child.stdin.write(`${JSON.stringify({ message: message.slice(0, 4000), error, saving })}\n`);
            return;
         } catch (failure) {
            this.onWarning(failure instanceof Error ? failure.message : "Native feedback could not start");
         }
      }
      this.system(message);
   }
   private system(message: string): void {
      if (!Notification.isSupported()) return;
      this.notification?.close();
      this.notification = new Notification({ title: "AttaClip", body: message, silent: true });
      this.notification.on("failed", (_event, reason) => this.onWarning(`System feedback failed: ${reason}`));
      this.notification.show();
   }
   close(): void {
      this.notification?.close();
      const child = this.child;
      this.child = null;
      if (!child) return;
      child.stdin.end(`${JSON.stringify({ action: "exit" })}\n`);
      const timeout = setTimeout(() => child.kill(), 1000);
      timeout.unref();
      child.once("exit", () => clearTimeout(timeout));
   }
}
