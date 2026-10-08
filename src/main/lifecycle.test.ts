import { afterEach, describe, expect, it, vi } from "vitest";
import { pendingExitDecision } from "./lifecycle";
afterEach(() => vi.useRealTimers());
describe("exit decision lifecycle", () => {
   it("auto-closes the decision and continues exiting when pending work finishes", async () => {
      vi.useFakeTimers();
      let pending = true;
      const decision = pendingExitDecision(
         () => pending,
         (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(2)))
      );
      pending = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(await decision).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
   });
   it("preserves an explicit keep-open choice and releases the polling timer", async () => {
      vi.useFakeTimers();
      expect(
         await pendingExitDecision(
            () => true,
            async () => 2
         )
      ).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
   });
});
