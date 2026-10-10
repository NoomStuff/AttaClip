import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clapperboard, Folder, LoaderCircle, Mic, Monitor, Share2, Video } from "lucide-react";
import type { AppState, CaptureSource, Preferences, RecordingCapabilities } from "../../shared/types";
import { api, Button, Field, Segmented, Select, Toggle } from "./ui";
import type { Run } from "./ui";
import { customQualityError, CustomQualityControls, QualityPicker, ShortcutInput } from "./Settings";
import { portalScreenId, sourceChoices } from "../../shared/capture-policy";

const steps = ["Capture", "Audio", "Clips", "Quality", "Sharing", "Ready"];
export function Onboarding({ state, run }: { state: AppState; run: Run }) {
   const [step, setStep] = useState(0);
   const [draft, setDraft] = useState(state.preferences);
   const [sources, setSources] = useState<CaptureSource[]>([]);
   const [busy, setBusy] = useState(false);
   const [micPermission, setMicPermission] = useState("");
   const [audioDevices, setAudioDevices] = useState<{ id: string; name: string }[]>([]);
   const [capabilities, setCapabilities] = useState<RecordingCapabilities | null>(null);
   const qualityChosen = useRef(false);
   useEffect(() => {
      if (capabilities) return;
      let disposed = false;
      void api
         .recordingCapabilities()
         .then((result) => {
            if (disposed) return;
            setCapabilities(result);
            if (!qualityChosen.current && result.supported) setDraft((current) => ({ ...current, quality: result.recommended }));
         })
         .catch((failure: unknown) => {
            if (!disposed)
               setCapabilities({
                  supported: false,
                  hardwareEncoders: [],
                  recommended: "standard",
                  message: failure instanceof Error ? failure.message : "The recorder could not initialize.",
               });
         });
      return () => {
         disposed = true;
      };
   }, [step, capabilities]);
   useEffect(() => {
      if (step === 1 && draft.microphone) void run(async () => setAudioDevices(await api.audioDevices()));
   }, [step, draft.microphone, run]);
   const source = sources.find((item) => item.id === draft.sourceId);
   const portal = sources.some((item) => item.id === portalScreenId);
   useEffect(() => {
      void run(async () => {
         const choices = await api.sources();
         setSources(choices);
         setDraft((current) => (current.sourceId ? current : { ...current, sourceId: choices.find((item) => item.kind === "screen")?.id ?? "" }));
      });
   }, [run]);
   const change = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setDraft((current) => ({ ...current, [key]: value }));
   const microphone = async (enabled: boolean) => {
      change("microphone", enabled);
      if (!enabled) return;
      try {
         const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
         stream.getTracks().forEach((track) => track.stop());
         setMicPermission("Microphone permission granted.");
      } catch {
         setMicPermission("Microphone access is unavailable. You can allow it later in system settings.");
      }
   };
   const choose = () =>
      void run(async () => {
         const folder = await api.chooseFolder();
         if (folder) change("collection", folder);
      });
   const finish = async () => {
      setBusy(true);
      const next = { ...draft, setupComplete: true };
      if (await run(() => api.savePreferences(next))) {
         if (next.autoRecord) await run(() => api.startRecording());
      }
      setBusy(false);
   };
   return (
      <div className="onboarding-backdrop">
         <div className="onboarding">
            <aside className="onboarding-sidebar">
               <div className="setup-brand">
                  <Clapperboard size={30} />
                  <span>AttaClip</span>
               </div>
               <div className="setup-intro">
                  <h1>
                     Your moments.
                     <br />
                     Your files.
                  </h1>
                  <p>A few choices, then you're ready to clip.</p>
               </div>
               <ol className="setup-steps">
                  {steps.map((name, index) => (
                     <li key={name} className={step === index ? "current" : step > index ? "complete" : ""}>
                        <span>{step > index ? <Check size={13} /> : index + 1}</span>
                        {name}
                     </li>
                  ))}
               </ol>
               <div className="setup-privacy">
                  <Folder size={16} />
                  <span>Saved locally. Nothing uploaded.</span>
               </div>
            </aside>
            <div className="onboarding-main">
               <div className="onboarding-body">
                  {step === 0 && (
                     <>
                        <div className="setup-icon">
                           <Monitor size={25} />
                        </div>
                        <h2>What would you like to capture?</h2>
                        <p>
                           {portal
                              ? capabilities?.applicationBackend === "xwayland"
                                 ? "Choose a screen through the system picker, or capture an XWayland application. Native Wayland apps are unavailable."
                                 : "Choose a screen in the system picker when recording starts. Application and Auto capture are unavailable in this Wayland session."
                              : "Start with a screen, choose an application, or follow a game automatically. You can switch later."}
                        </p>
                        <Segmented
                           label="Setup capture source"
                           value={draft.sourceKind}
                           values={sourceChoices(sources, capabilities)}
                           onChange={(kind) => {
                              change("sourceKind", kind);
                              change("sourceId", sources.find((item) => item.kind === kind)?.id ?? draft.sourceId);
                           }}
                        />
                        {draft.sourceKind !== "auto" ? (
                           <>
                              <div className="setup-source-list">
                                 {sources
                                    .filter((item) => item.kind === draft.sourceKind)
                                    .map((item) => (
                                       <button
                                          key={item.id}
                                          onClick={() => change("sourceId", item.id)}
                                          className={item.id === draft.sourceId ? "selected" : ""}
                                       >
                                          <Monitor size={17} />
                                          <span>{item.name}</span>
                                          {item.id === draft.sourceId && <Check size={17} />}
                                       </button>
                                    ))}
                                 {sources.filter((item) => item.kind === draft.sourceKind).length === 0 && (
                                    <p>No sources available. Check capture permissions, or choose a screen.</p>
                                 )}
                              </div>
                              {source?.thumbnail && <img className="setup-preview" src={source.thumbnail} alt={`Preview of ${source.name}`} />}
                           </>
                        ) : (
                           <>
                              <p className="setup-auto-detail">Follow the active game. Recording waits when no game is found.</p>
                              <Toggle
                                 label="Screen fallback"
                                 detail="Record a screen when no game is found. Off by default."
                                 checked={draft.desktopFallback}
                                 onChange={(value) => change("desktopFallback", value)}
                              />
                              {draft.desktopFallback && (
                                 <Select label="Fallback screen" value={draft.sourceId} onChange={(value) => change("sourceId", value)}>
                                    {sources
                                       .filter((item) => item.kind === "screen")
                                       .map((item) => (
                                          <option value={item.id} key={item.id}>
                                             {item.name}
                                          </option>
                                       ))}
                                 </Select>
                              )}
                           </>
                        )}
                     </>
                  )}
                  {step === 1 && (
                     <>
                        <div className="setup-icon">
                           <Mic size={25} />
                        </div>
                        <h2>Choose your sound</h2>
                        <p>The master mix is ready for sharing. Individual sources stay separate in your original clip.</p>
                        <Toggle
                           label="Capture audio"
                           detail="Desktop audio for a screen, application audio for an app."
                           checked={draft.captureAudio}
                           onChange={(value) => change("captureAudio", value)}
                        />
                        <Toggle
                           label="Microphone"
                           detail="Include your voice. Off until you enable it."
                           checked={draft.microphone}
                           onChange={(value) => void microphone(value)}
                        />
                        {draft.microphone && (
                           <Field label="Microphone">
                              <Select label="Setup microphone device" value={draft.microphoneDevice} onChange={(value) => change("microphoneDevice", value)}>
                                 <option value="default">System default</option>
                                 {audioDevices
                                    .filter((item) => item.id !== "default")
                                    .map((item) => (
                                       <option key={item.id} value={item.id}>
                                          {item.name}
                                       </option>
                                    ))}
                              </Select>
                           </Field>
                        )}
                        {micPermission && <p className="permission-note">{micPermission}</p>}
                        <p className="setup-secondary">You can check your microphone meter on the Recording page.</p>
                     </>
                  )}
                  {step === 2 && (
                     <>
                        <div className="setup-icon">
                           <Clapperboard size={25} />
                        </div>
                        <h2>Save it with a shortcut</h2>
                        <p>AttaClip keeps recent footage while recording. Press your shortcut to save the moment.</p>
                        <Field label="Clip length">
                           <div className="number-unit">
                              <input
                                 type="number"
                                 aria-label="Setup clip length in seconds"
                                 value={draft.clipSeconds}
                                 min={5}
                                 max={1800}
                                 onChange={(event) => change("clipSeconds", Number(event.target.value))}
                              />
                              <span>seconds</span>
                           </div>
                        </Field>
                        <Field label="Clip shortcut">
                           <ShortcutInput value={draft.shortcut} onChange={(value) => change("shortcut", value)} />
                        </Field>
                        <Field label="Collection folder" detail="Your clips save here. Existing supported videos also appear in the Library.">
                           <Button onClick={choose}>
                              <Folder size={15} />
                              Choose folder
                           </Button>
                        </Field>
                        <div className="setup-folder" title={draft.collection}>
                           {draft.collection}
                        </div>
                     </>
                  )}
                  {step === 3 && (
                     <>
                        <div className="setup-icon">
                           <Video size={25} />
                        </div>
                        <h2>Find your balance</h2>
                        <p>Choose how much detail to keep.</p>
                        <QualityPicker
                           value={draft.quality}
                           {...(capabilities?.supported ? { recommended: capabilities.recommended } : {})}
                           onChange={(value) => {
                              qualityChosen.current = true;
                              change("quality", value);
                           }}
                        />
                        {draft.quality === "custom" && (
                           <CustomQualityControls value={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
                        )}
                        {customQualityError(draft) && <p className="permission-note">{customQualityError(draft)}</p>}
                        {capabilities?.message && <p className="permission-note">{capabilities.message}</p>}
                        {capabilities?.supported && !capabilities.hardwareEncoders.length && draft.quality !== "custom" && (
                           <Toggle
                              label="Allow software encoding"
                              detail="Uses your CPU to record. Low reduces the cost."
                              checked={draft.allowSoftwareEncoder}
                              onChange={(value) => change("allowSoftwareEncoder", value)}
                           />
                        )}
                        <div className="setup-secondary">
                           {capabilities?.hardwareEncoders.length
                              ? "Hardware encoding is available. If recording affects your game, try Low."
                              : "If recording affects your game, try Low."}
                        </div>
                     </>
                  )}
                  {step === 4 && (
                     <>
                        <div className="setup-icon">
                           <Share2 size={25} />
                        </div>
                        <h2>Small enough to send</h2>
                        <p>A shareable is a smaller copy of your clip. Your original is always preserved.</p>
                        <Field label="Default maximum size">
                           <div className="number-unit">
                              <input
                                 aria-label="Setup maximum shareable size in MB"
                                 type="number"
                                 min={1}
                                 max={2000}
                                 value={draft.shareSizeMB}
                                 onChange={(event) => change("shareSizeMB", Number(event.target.value))}
                              />
                              <span>MB</span>
                           </div>
                        </Field>
                        <div className="size-presets">
                           {[10, 20, 50, 100].map((size) => (
                              <button key={size} className={draft.shareSizeMB === size ? "selected" : ""} onClick={() => change("shareSizeMB", size)}>
                                 {size} MB
                              </button>
                           ))}
                        </div>
                        <Toggle
                           label="Automatically create shareables"
                           detail="Uses extra resources after each clip saves. Otherwise create them when you need them."
                           checked={draft.autoShare}
                           onChange={(value) => change("autoShare", value)}
                        />
                     </>
                  )}
                  {step === 5 && (
                     <>
                        <div className="setup-icon ready-icon">
                           <Check size={27} />
                        </div>
                        <h2>You're ready to clip</h2>
                        <p>Recording is in your control. Close the window to keep AttaClip in the tray.</p>
                        <div className="setup-summary">
                           <span>
                              <Monitor size={17} />
                              {source?.name ?? (draft.sourceKind === "auto" ? "Auto game capture" : "Selected source")}
                           </span>
                           <span>
                              <Clapperboard size={17} />
                              {draft.clipSeconds} seconds · {draft.quality}
                           </span>
                           <span>
                              <Share2 size={17} />
                              {draft.shareSizeMB} MB shareables
                           </span>
                        </div>
                        <Toggle label="Start with your computer" checked={draft.startWithOS} onChange={(value) => change("startWithOS", value)} />
                        <Toggle
                           label="Start recording when AttaClip opens"
                           detail="Applies when launched manually, too."
                           checked={draft.autoRecord}
                           onChange={(value) => change("autoRecord", value)}
                        />
                     </>
                  )}
               </div>
               <footer className="onboarding-actions">
                  {step > 0 ? (
                     <Button className="quiet" onClick={() => setStep(step - 1)} disabled={busy}>
                        <ArrowLeft size={16} />
                        Back
                     </Button>
                  ) : (
                     <span />
                  )}
                  <span className="setup-step-number">
                     {step + 1} of {steps.length}
                  </span>
                  {step === steps.length - 1 ? (
                     <Button className="primary" busy={busy} onClick={() => void finish()}>
                        {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
                        {draft.autoRecord ? "Start recording" : "Open AttaClip"}
                     </Button>
                  ) : (
                     <Button className="primary" disabled={step === 3 && Boolean(customQualityError(draft))} onClick={() => setStep(step + 1)}>
                        Continue
                        <ArrowRight size={16} />
                     </Button>
                  )}
               </footer>
            </div>
         </div>
      </div>
   );
}
