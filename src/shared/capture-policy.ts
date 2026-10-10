import type { CaptureSource, GameCandidate, RecordingCapabilities, SourceKind } from "./types";

export const portalScreenId = "portal:screen";
export function portalSources(capabilities: RecordingCapabilities, candidates: GameCandidate[] = []): CaptureSource[] | null {
   if (capabilities.captureBackend !== "wayland-portal") return null;
   if (!capabilities.supported || !capabilities.portalPicker || !capabilities.sourceKinds?.includes("screen")) return [];
   const sources: CaptureSource[] = [{ id: portalScreenId, name: "Choose a screen when recording starts", kind: "screen", thumbnail: "" }];
   if (capabilities.applicationBackend === "xwayland" && capabilities.sourceKinds.includes("app"))
      for (const candidate of candidates)
         if (/^window:[1-9]\d*:0$/.test(candidate.id) && candidate.pid > 0 && candidate.name.trim())
            sources.push({ id: candidate.id, name: candidate.name, kind: "app", thumbnail: "" });
   return sources;
}
export function sourceChoices(
   sources: CaptureSource[],
   capabilities?: RecordingCapabilities | null
): { value: SourceKind; label: string; disabled?: boolean }[] {
   const portal = capabilities?.captureBackend === "wayland-portal" || sources.some((source) => source.id === portalScreenId);
   const unavailable = (kind: SourceKind) =>
      portal && !(capabilities?.supported && capabilities.applicationBackend === "xwayland" && capabilities.sourceKinds?.includes(kind));
   return [
      { value: "screen", label: "Screen" },
      { value: "app", label: "App", disabled: unavailable("app") },
      { value: "auto", label: "Auto", disabled: unavailable("auto") },
   ];
}
