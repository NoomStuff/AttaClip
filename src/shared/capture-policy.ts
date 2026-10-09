import type { CaptureSource, RecordingCapabilities, SourceKind } from "./types";

export const portalScreenId = "portal:screen";
export function portalSources(capabilities: RecordingCapabilities): CaptureSource[] | null {
   if (capabilities.captureBackend !== "wayland-portal") return null;
   if (!capabilities.supported || !capabilities.portalPicker || !capabilities.sourceKinds?.includes("screen")) return [];
   return [{ id: portalScreenId, name: "Choose a screen when recording starts", kind: "screen", thumbnail: "" }];
}
export function sourceChoices(sources: CaptureSource[]): { value: SourceKind; label: string; disabled?: boolean }[] {
   const portal = sources.some((source) => source.id === portalScreenId);
   return [
      { value: "screen", label: "Screen" },
      { value: "app", label: "App", disabled: portal },
      { value: "auto", label: "Auto", disabled: portal },
   ];
}
