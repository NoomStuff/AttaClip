import { useEffect, useRef, useState } from "react";
import { AppWindow, AudioLines, Clapperboard, Circle, CircleStop, Mic, MicOff, Monitor, RefreshCw, Volume2, VolumeX, WandSparkles } from "lucide-react";
import type { AppState, CaptureSource, Preferences, SourceKind } from "../../shared/types";
import { api, Empty, IconButton, LevelSlider, Segmented, Toggle } from "./ui";
import type { Run } from "./ui";

export function Recording({ state, visible, run, pulse }: { state: AppState; visible: boolean; run: Run; pulse: number }) {
   const [sources, setSources] = useState<CaptureSource[]>([]);
   const [loading, setLoading] = useState(false);
   const [saving, setSaving] = useState(false);
   const [pulsing, setPulsing] = useState(false);
   const [micLevel, setMicLevel] = useState(0);
   const [nativeLevels, setNativeLevels] = useState({ capture: 0, microphone: 0 });
   const latestPreferences = useRef(state.preferences);
   latestPreferences.current = state.preferences;
   const writes = useRef(Promise.resolve());
   const [audioDevices, setAudioDevices] = useState<{ id: string; name: string }[]>([]);
   const [micError, setMicError] = useState("");
   const levelRef = useRef(0);
   const active = state.recorder.state === "recording" || state.recorder.state === "waiting";
   useEffect(() => {
      if (!visible || !active) {
         setNativeLevels({ capture: 0, microphone: 0 });
         return;
      }
      return api.onEvent((event) => {
         if (event.type === "audio-levels" && event.levels) setNativeLevels(event.levels);
      });
   }, [visible, active]);
   const source =
      state.preferences.sourceKind === "auto"
         ? undefined
         : (sources.find((item) => item.id === state.preferences.sourceId) ??
           (!state.preferences.sourceId && state.preferences.sourceKind === "screen" ? sources.find((item) => item.kind === "screen") : undefined));
   const refresh = async () => {
      setLoading(true);
      await run(async () => setSources(await api.sources()));
      setLoading(false);
   };
   useEffect(() => {
      if (!visible || !state.preferences.microphone) return;
      void run(async () => setAudioDevices(await api.audioDevices()));
   }, [visible, state.preferences.microphone, run]);
   useEffect(() => {
      if (!visible) return;
      let gone = false;
      const fetch = async () => {
         try {
            const result = await api.sources();
            if (!gone) setSources(result);
         } catch {
            /* Main action errors remain visible; source refresh retries. */
         }
      };
      void fetch();
      const timer = window.setInterval(() => {
         if (!document.hidden) void fetch();
      }, 2500);
      return () => {
         gone = true;
         window.clearInterval(timer);
      };
   }, [visible]);
   useEffect(() => {
      if (!pulse) return;
      setPulsing(true);
      const timer = window.setTimeout(() => setPulsing(false), 550);
      return () => window.clearTimeout(timer);
   }, [pulse]);
   useEffect(() => {
      if (!visible || !state.preferences.microphone || active) {
         setMicLevel(0);
         return;
      }
      let stream: MediaStream | undefined;
      let context: AudioContext | undefined;
      let timer: number | undefined;
      let disposed = false;
      void (async () => {
         try {
            const device = state.preferences.microphoneDevice;
            let browserDevice: string | undefined;
            if (device && device !== "default") {
               const native = audioDevices.find((item) => item.id === device);
               if (!native) throw new Error("Microphone preview unavailable. Check the selected device.");
               const permission = await navigator.mediaDevices.getUserMedia({ audio: true });
               permission.getTracks().forEach((item) => item.stop());
               const normalize = (label: string) => label.toLowerCase().trim();
               const matches = (await navigator.mediaDevices.enumerateDevices()).filter(
                  (item) =>
                     item.kind === "audioinput" && !["default", "communications"].includes(item.deviceId) && normalize(item.label) === normalize(native.name)
               );
               if (matches.length !== 1) throw new Error("Preview unavailable for this device. Recording uses the selected microphone.");
               browserDevice = matches[0]?.deviceId;
            }
            const media = await navigator.mediaDevices.getUserMedia({ audio: browserDevice ? { deviceId: { exact: browserDevice } } : true });
            if (disposed) {
               media.getTracks().forEach((track) => track.stop());
               return;
            }
            stream = media;
            context = new AudioContext();
            const analyser = context.createAnalyser();
            analyser.fftSize = 256;
            context.createMediaStreamSource(media).connect(analyser);
            const data = new Uint8Array(analyser.fftSize);
            setMicError("");
            timer = window.setInterval(() => {
               analyser.getByteTimeDomainData(data);
               let sum = 0;
               for (const sample of data) sum += ((sample - 128) / 128) ** 2;
               levelRef.current = Math.min(100, Math.sqrt(sum / data.length) * 230);
               setMicLevel(levelRef.current);
            }, 100);
         } catch (error) {
            if (!disposed) setMicError(error instanceof Error ? error.message : "Microphone unavailable. Check permissions and device.");
         }
      })();
      return () => {
         disposed = true;
         if (timer) window.clearInterval(timer);
         stream?.getTracks().forEach((track) => track.stop());
         void context?.close();
      };
   }, [visible, state.preferences.microphone, state.preferences.microphoneDevice, audioDevices, active]);
   const preferences = (patch: Partial<Preferences>) => {
      writes.current = writes.current.then(async () => {
         await run(async () => {
            const next = await api.savePreferences({ ...latestPreferences.current, ...patch });
            latestPreferences.current = next.preferences;
         });
      });
   };
   const switchKind = (kind: SourceKind) => {
      const first = sources.find((item) => item.kind === kind);
      preferences({ sourceKind: kind, sourceId: first?.id ?? state.preferences.sourceId });
   };
   const save = async () => {
      setSaving(true);
      setPulsing(true);
      await run(() => api.saveClip());
      setSaving(false);
      window.setTimeout(() => setPulsing(false), 550);
   };
   return (
      <div className="recording-page">
         <div className="page-heading">
            <div>
               <h1>Recording</h1>
               <p>Keep the moment. Leave the rest.</p>
            </div>
            <span className="profile-label">
               {state.preferences.quality === "low"
                  ? "Low impact"
                  : state.preferences.quality === "high"
                    ? "High quality"
                    : state.preferences.quality === "custom"
                      ? "Custom"
                      : "Standard"}
               <span> · {state.preferences.clipSeconds}s clips</span>
            </span>
         </div>
         <div className="recording-layout">
            <div className="recording-main">
               <div className="preview-surface">
                  {source?.thumbnail ? (
                     <img src={source.thumbnail} alt={`Preview of ${source.name}`} className="source-preview" />
                  ) : (
                     <Empty
                        icon={<Monitor size={38} />}
                        title={state.preferences.sourceKind === "auto" ? "Waiting for an application" : "Choose what to capture"}
                        detail={
                           state.preferences.sourceKind === "auto"
                              ? "Auto capture will follow a supported game. Your desktop stays private unless fallback is enabled."
                              : "Select a screen or application from the list."
                        }
                     />
                  )}
                  {source?.thumbnail && (
                     <div className="preview-caption">
                        <span className={active ? "preview-dot active" : "preview-dot"} />
                        {source.name}
                        <span className="preview-note">Source preview</span>
                     </div>
                  )}
               </div>
               <div className="recording-bottom">
                  <div className="mixer">
                     <div className="section-top">
                        <h2>Audio</h2>
                        <AudioLines size={16} />
                     </div>
                     <div className="audio-row">
                        <IconButton
                           label={state.preferences.captureMuted ? "Unmute capture audio" : "Mute capture audio"}
                           disabled={!state.preferences.captureAudio}
                           onClick={() => preferences({ captureMuted: !state.preferences.captureMuted })}
                        >
                           {state.preferences.captureMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                        </IconButton>
                        <div className="audio-row-content">
                           <Toggle
                              label="Capture audio"
                              checked={state.preferences.captureAudio}
                              onChange={(value) => preferences({ captureAudio: value })}
                              disabled={active}
                           />
                           <div className="audio-caption">
                              {state.preferences.sourceKind === "screen" ? "Sound from the selected screen" : "Sound from the selected application"}
                           </div>
                           <div className="meter" style={{ "--meter": `${active ? nativeLevels.capture : 0}%` } as React.CSSProperties}>
                              <div className="meter-fill" />
                           </div>
                           <LevelSlider
                              label="Capture audio level"
                              value={state.preferences.captureVolume}
                              disabled={!state.preferences.captureAudio}
                              onCommit={(value) => preferences({ captureVolume: value })}
                           />
                           <span className="meter-caption">
                              {state.preferences.captureAudio
                                 ? state.preferences.captureMuted
                                    ? "Muted in all recorded tracks"
                                    : active
                                      ? "Recording audio"
                                      : "Meter available while recording"
                                 : "Not recorded"}
                           </span>
                        </div>
                     </div>
                     <div className="audio-row">
                        <IconButton
                           label={state.preferences.microphoneMuted ? "Unmute microphone" : "Mute microphone"}
                           disabled={!state.preferences.microphone}
                           onClick={() => preferences({ microphoneMuted: !state.preferences.microphoneMuted })}
                        >
                           {state.preferences.microphoneMuted ? <MicOff size={18} /> : <Mic size={18} />}
                        </IconButton>
                        <div className="audio-row-content">
                           <Toggle
                              label="Microphone"
                              checked={state.preferences.microphone}
                              onChange={(value) => preferences({ microphone: value })}
                              disabled={active}
                           />
                           <div className="meter" style={{ "--meter": `${active ? nativeLevels.microphone : micLevel}%` } as React.CSSProperties}>
                              <div className="meter-fill" />
                           </div>
                           <LevelSlider
                              label="Microphone level"
                              value={state.preferences.microphoneVolume}
                              disabled={!state.preferences.microphone}
                              onCommit={(value) => preferences({ microphoneVolume: value })}
                           />
                           {state.preferences.microphone && (
                              <select
                                 className="mic-select"
                                 aria-label="Microphone device"
                                 disabled={active}
                                 value={state.preferences.microphoneDevice}
                                 onChange={(event) => preferences({ microphoneDevice: event.target.value })}
                              >
                                 <option value="default">System default microphone</option>
                                 {audioDevices
                                    .filter((item) => item.id !== "default")
                                    .map((item) => (
                                       <option key={item.id} value={item.id}>
                                          {item.name}
                                       </option>
                                    ))}
                              </select>
                           )}
                           <span className={`meter-caption ${micError && state.preferences.microphone ? "error-text" : ""}`}>
                              {state.preferences.microphone
                                 ? state.preferences.microphoneMuted
                                    ? "Muted in all recorded tracks"
                                    : active
                                      ? "Master mix and isolated track"
                                      : micError || "Master mix and isolated track"
                                 : "Not recorded"}
                           </span>
                        </div>
                     </div>
                  </div>
                  <div className="capture-actions">
                     <button
                        className={`record-action ${active ? "is-recording" : ""}`}
                        disabled={state.recorder.state === "starting" || !state.recorder.supported || (!active && state.preferences.sourceKind === "auto")}
                        onClick={() => void run(active ? () => api.stopRecording() : () => api.startRecording())}
                     >
                        {active ? <CircleStop size={50} strokeWidth={1.7} /> : <Circle size={50} strokeWidth={1.7} />}
                        <span>{active ? "Stop recording" : "Start recording"}</span>
                        {active && <small>Unsaved history will clear</small>}
                     </button>
                     <button
                        className={`clip-action ${pulsing ? "shortcut-pulse" : ""}`}
                        disabled={!active || state.recorder.availableSeconds < 1 || saving}
                        onClick={() => void save()}
                     >
                        <Clapperboard size={48} strokeWidth={1.65} />
                        <span>{saving ? "Saving…" : "Clip it"}</span>
                        <kbd>{state.preferences.shortcut.replace("CommandOrControl", state.platform === "darwin" ? "⌘" : "Ctrl").replaceAll("+", " + ")}</kbd>
                     </button>
                  </div>
               </div>
            </div>
            <aside className="source-panel">
               <div className="section-top">
                  <h2>Capture source</h2>
                  <IconButton label="Refresh sources" onClick={() => void refresh()} disabled={loading}>
                     <RefreshCw size={15} className={loading ? "spin" : ""} />
                  </IconButton>
               </div>
               <Segmented
                  label="Source type"
                  value={state.preferences.sourceKind}
                  values={[
                     { value: "screen", label: "Screen" },
                     { value: "app", label: "App" },
                     { value: "auto", label: "Auto" },
                  ]}
                  onChange={switchKind}
               />
               {state.preferences.sourceKind === "auto" ? (
                  <div className="auto-source">
                     <WandSparkles size={25} />
                     <h3>Auto capture unavailable</h3>
                     <p>This build supports selecting a screen or application directly. Automatic game selection isn't available yet.</p>
                     <Toggle
                        label="Screen fallback"
                        detail="Record the selected screen when no game is available."
                        checked={state.preferences.desktopFallback}
                        onChange={(value) => preferences({ desktopFallback: value })}
                        disabled
                     />
                     {state.preferences.desktopFallback &&
                        sources
                           .filter((item) => item.kind === "screen")
                           .map((item) => (
                              <button
                                 key={item.id}
                                 className={`source-row ${item.id === state.preferences.sourceId ? "selected" : ""}`}
                                 onClick={() => preferences({ sourceId: item.id })}
                              >
                                 <Monitor size={18} />
                                 <span>{item.name}</span>
                              </button>
                           ))}
                  </div>
               ) : (
                  <div className="source-list">
                     {sources
                        .filter((item) => item.kind === state.preferences.sourceKind)
                        .map((item) => (
                           <button
                              className={`source-row ${item.id === source?.id ? "selected" : ""}`}
                              key={item.id}
                              onClick={() => preferences({ sourceId: item.id })}
                           >
                              {item.kind === "screen" ? <Monitor size={18} /> : <AppWindow size={18} />}
                              <span>{item.name}</span>
                              {item.id === source?.id && <span className="source-selected" />}
                           </button>
                        ))}
                     {sources.filter((item) => item.kind === state.preferences.sourceKind).length === 0 && (
                        <p className="source-empty">
                           {state.preferences.sourceKind === "app"
                              ? "No applications available. Open an application and refresh."
                              : "No screens available. Check capture permissions."}
                        </p>
                     )}
                  </div>
               )}
               <div className="source-footnote">Source changes keep your recent footage.</div>
            </aside>
         </div>
      </div>
   );
}
