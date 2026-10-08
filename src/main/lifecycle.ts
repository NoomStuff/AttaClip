/** Close a pending-work prompt when there is nothing left to decide, then complete the requested exit. */
export async function pendingExitDecision(hasPending: () => boolean, prompt: (signal: AbortSignal) => Promise<number>): Promise<number> {
   const completed = new AbortController();
   const timer = setInterval(() => {
      if (!hasPending()) completed.abort();
   }, 100);
   try {
      const response = await prompt(completed.signal);
      return completed.signal.aborted ? 0 : response;
   } finally {
      clearInterval(timer);
   }
}
