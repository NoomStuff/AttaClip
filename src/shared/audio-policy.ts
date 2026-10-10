import type { AdditionalAudioSource } from "./types";

export function needsMicrophonePermission(preferences: {
   microphone: boolean;
   audioSources: ReadonlyArray<Pick<AdditionalAudioSource, "kind" | "enabled">>;
}): boolean {
   return preferences.microphone || preferences.audioSources.some((source) => source.enabled && source.kind === "input");
}
