import type { AdditionalAudioSource, GameCandidate } from "../shared/types";

// A window ID can change after an application restarts. The executable remains
// the saved binding, and the current candidate supplies its verified PID.
export function resolveAudioSources(sources: AdditionalAudioSource[], candidates: GameCandidate[]): Array<AdditionalAudioSource & { pid?: number }> {
   return sources.map((source) => {
      if (!source.enabled || source.kind !== "application") return { ...source };
      const matches = candidates.filter((candidate) => candidate.executable === source.executable && candidate.pid > 0);
      const target = matches.find((candidate) => candidate.id === source.sourceId) ?? matches.find((candidate) => candidate.foreground) ?? matches[0];
      if (!target) throw new Error(`${source.name} is unavailable. Open the application or disable its audio source.`);
      return { ...source, sourceId: target.id, pid: target.pid };
   });
}
