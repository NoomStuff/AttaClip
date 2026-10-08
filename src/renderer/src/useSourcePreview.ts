import { useEffect, useRef, useState } from "react";
import { api, describeError } from "./ui";

type PreviewStatus = "idle" | "connecting" | "live" | "error";

export function useSourcePreview(sourceId: string | undefined, visible: boolean) {
   const video = useRef<HTMLVideoElement>(null);
   const [status, setStatus] = useState<PreviewStatus>("idle");
   const [error, setError] = useState("");
   const [retry, setRetry] = useState(0);
   const operations = useRef(Promise.resolve());

   useEffect(() => {
      let disposed = false;
      let stream: MediaStream | undefined;
      let frame: number | undefined;
      const element = video.current;
      const stop = () => {
         if (frame !== undefined) element?.cancelVideoFrameCallback(frame);
         stream?.getTracks().forEach((track) => track.stop());
         if (element) {
            element.pause();
            element.srcObject = null;
         }
      };
      const cancel = () => {
         disposed = true;
         stop();
      };
      const visibility = () => {
         if (document.hidden) cancel();
      };
      const unsubscribe = api.onEvent((event) => {
         if (event.type === "visibility" && !event.visible) cancel();
      });
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener("pagehide", cancel);
      setError("");
      setStatus(sourceId && visible ? "connecting" : "idle");

      // Finish or revoke the previous request before arming a different source.
      // A stream that arrives after navigation is stopped before reaching the player.
      operations.current = operations.current
         .catch(() => undefined)
         .then(async () => {
            try {
               await api.previewSource(null);
               if (disposed || !visible || !sourceId || document.hidden) return;
               await api.previewSource(sourceId);
               if (disposed) {
                  await api.previewSource(null);
                  return;
               }
               const captured = await navigator.mediaDevices.getDisplayMedia({
                  audio: false,
                  video: { width: { ideal: 960, max: 960 }, height: { ideal: 540, max: 540 }, frameRate: { ideal: 15, max: 15 } },
               });
               stream = captured;
               if (disposed || document.hidden || !element) {
                  stop();
                  await api.previewSource(null);
                  return;
               }
               // Preview must never open another audio capture path.
               captured.getAudioTracks().forEach((track) => track.stop());
               captured.getVideoTracks().forEach((track) => {
                  track.addEventListener(
                     "ended",
                     () => {
                        if (disposed) return;
                        stop();
                        setError("This source is no longer available.");
                        setStatus("error");
                     },
                     { once: true }
                  );
               });
               element.srcObject = captured;
               frame = element.requestVideoFrameCallback(() => {
                  if (!disposed) setStatus("live");
               });
               await element.play();
            } catch (reason) {
               stop();
               await api.previewSource(null).catch(() => undefined);
               if (!disposed) {
                  const message = describeError(reason);
                  setError(message === "Permission denied" ? "Allow screen capture in your system settings, then retry." : message);
                  setStatus("error");
               }
            }
         });

      return () => {
         cancel();
         unsubscribe();
         document.removeEventListener("visibilitychange", visibility);
         window.removeEventListener("pagehide", cancel);
         operations.current = operations.current
            .catch(() => undefined)
            .then(() => api.previewSource(null))
            .catch(() => undefined);
      };
   }, [sourceId, visible, retry]);

   return { video, status, error, retry: () => setRetry((value) => value + 1) };
}
