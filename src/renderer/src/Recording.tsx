import { useEffect, useRef, useState } from "react";
import { AppWindow, AudioLines, Clapperboard, Circle, CircleStop, Mic, MicOff, Monitor, RefreshCw, Volume2, VolumeX, WandSparkles } from "lucide-react";
import type { AppState, AudioLevels, CaptureSource, GameCandidate, Preferences, SourceKind } from "../../shared/types";
import { api, Button, Empty, IconButton, LevelSlider, Segmented, Select, Toggle } from "./ui";
import type { Run } from "./ui";
import { useSourcePreview } from "./useSourcePreview";
import { AdditionalAudio } from "./AdditionalAudio";

export function Recording({ state, visible, run, pulse }: { state: AppState; visible: boolean; run: Run; pulse: number }) {
   const [sources, setSources] = useState<CaptureSource[]>([]);
   const [games, setGames] = useState<GameCandidate[]>([]);
   const [addingGame, setAddingGame] = useState(false);
   const [newGameId, setNewGameId] = useState("");
   const [loading, setLoading] = useState(false);
   const [saving, setSaving] = useState(false);
   const [pulsing, setPulsing] = useState(false);
   const [micLevel, setMicLevel] = useState(0);
   const [nativeLevels, setNativeLevels] = useState<AudioLevels>({ capture: 0, microphone: 0 });
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
         if (event.type === "audio-levels" && event.levels) {
            const levels = event.levels;
            setNativeLevels((previous) => ({ ...levels, additional: { ...previous.additional, ...levels.additional } }));
         }
      });
   }, [visible, active]);
   const source =
      state.preferences.sourceKind === "auto"
         ? sources.find((item) => item.id === state.recorder.sourceId)
         : (sources.find((item) => item.id === state.preferences.sourceId) ??
           (!state.preferences.sourceId && state.preferences.sourceKind === "screen" ? sources.find((item) => item.kind === "screen") : undefined));
   const preview = useSourcePreview(source?.id, visible && state.preferences.setupComplete);
   const refresh = async () => {
      setLoading(true);
      await run(async () => setSources(await api.sources()));
      setLoading(false);
   };
   useEffect(() => {
      if (!visible || state.preferences.sourceKind !== "auto" || !state.recorder.supported) return;
      let disposed = false;
      const update = async () => {
         try {
            const candidates = await api.games();
            if (!disposed) setGames(candidates);
         } catch {
            /* The recorder reports connection failures separately. */
         }
      };
      void update();
      const timer = window.setInterval(() => void update(), 2000);
      return () => {
         disposed = true;
         window.clearInterval(timer);
      };
   }, [visible, state.preferences.sourceKind, state.preferences.customGames, state.recorder.supported]);
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
      }, 10000);
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
   const preferences = (patch: Partial<Preferences> | ((current: Preferences) => Partial<Preferences>)) => {
      writes.current = writes.current.then(async () => {
         await run(async () => {
            const next = await api.savePreferences({
               ...latestPreferences.current,
               ...(typeof patch === "function" ? patch(latestPreferences.current) : patch),
            });
            latestPreferences.current = next.preferences;
         });
      });
   };
   const switchKind = (kind: SourceKind) => {
      const first = sources.find((item) => item.kind === (kind === "auto" ? "screen" : kind));
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
                  {source ? (
                     <>
                        <video
                           ref={preview.video}
                           muted
                           autoPlay
                           playsInline
                           aria-label={`Live preview of ${source.name}`}
                           className={`source-preview preview-stream ${preview.status === "live" ? "ready" : ""}`}
                        />
                        {preview.status !== "live" && (
                           <div className="preview-message">
                              {preview.status === "error" ? (
                                 <>
                                    <Monitor size={30} />
                                    <h3>Preview unavailable</h3>
                                    <p>{preview.error}</p>
                                    <Button onClick={preview.retry}>
                                       <RefreshCw size={14} />
                                       Retry preview
                                    </Button>
                                 </>
                              ) : (
                                 <>
                                    <Monitor size={30} />
                                    <p>Opening preview…</p>
                                 </>
                              )}
                           </div>
                        )}
                     </>
                  ) : (
                     <Empty
                        icon={<Monitor size={38} />}
                        title={state.preferences.sourceKind === "auto" ? "Waiting for game" : "Choose what to capture"}
                        detail={
                           state.preferences.sourceKind === "auto"
                              ? "Auto capture will follow a supported game. Your desktop stays private unless fallback is enabled."
                              : "Select a screen or application from the list."
                        }
                     />
                  )}
                  {source && (
                     <div className="preview-caption">
                        <span className={preview.status === "live" ? "preview-dot live" : "preview-dot"} />
                        {source.name}
                        <span className="preview-note">{preview.status === "live" ? "Live preview" : "Preview"}</span>
                     </div>
                  )}
               </div>
               <div className="recording-bottom">
                  <div className="mixer">
                     <div className="mixer-scroll">
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
                        <AdditionalAudio
                           preferences={state.preferences}
                           active={active || state.recorder.state === "starting"}
                           visible={visible}
                           levels={nativeLevels.additional ?? {}}
                           save={preferences}
                           run={run}
                        />
                     </div>
                  </div>
                  <div className="capture-actions">
                     <button
                        className={`record-action ${active ? "is-recording" : ""}`}
                        disabled={state.recorder.state === "starting" || !state.recorder.supported}
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
                     <h3>{state.recorder.sourceName && active ? state.recorder.sourceName : "Follow the active game"}</h3>
                     <p>Games are detected locally. Switching to another app keeps your game selected.</p>
                     {games
                        .filter((game) => game.gameName)
                        .map((game) => (
                           <div className={`source-row ${game.id === state.recorder.sourceId ? "selected" : ""}`} key={game.id}>
                              <AppWindow size={18} />
                              <span>{game.gameName}</span>
                              {game.id === state.recorder.sourceId && <span className="source-selected" />}
                           </div>
                        ))}
                     <Button className="quiet" onClick={() => setAddingGame(!addingGame)}>
                        Add game
                     </Button>
                     {addingGame && (
                        <div className="field-stack">
                           <Select label="Running application" value={newGameId} onChange={setNewGameId}>
                              <option value="">Choose an application</option>
                              {games.map((game) => (
                                 <option key={game.id} value={game.id}>
                                    {game.name}
                                 </option>
                              ))}
                           </Select>
                           <Button
                              disabled={!games.some((game) => game.id === newGameId)}
                              onClick={() => {
                                 const game = games.find((item) => item.id === newGameId);
                                 if (!game) return;
                                 preferences({
                                    customGames: [
                                       ...state.preferences.customGames.filter((item) => item.executable !== game.executable),
                                       { name: game.name, executable: game.executable },
                                    ],
                                 });
                                 setAddingGame(false);
                              }}
                           >
                              Add selected game
                           </Button>
                        </div>
                     )}
                     {state.preferences.customGames.map((game) => (
                        <div className="source-row" key={game.executable}>
                           <span title={game.executable}>{game.name}</span>
                           <Button
                              className="quiet"
                              onClick={() => preferences({ customGames: state.preferences.customGames.filter((item) => item.executable !== game.executable) })}
                           >
                              Remove
                           </Button>
                        </div>
                     ))}
                     <Toggle
                        label="Screen fallback"
                        detail="Record the selected screen when no game is available."
                        checked={state.preferences.desktopFallback}
                        onChange={(value) => preferences({ desktopFallback: value })}
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
