import { useEffect, useRef, useState } from "react";
import {
   AudioLines,
   Bell,
   Check,
   ChevronRight,
   Download,
   Folder,
   FolderOpen,
   Keyboard,
   LoaderCircle,
   Power,
   RefreshCw,
   Settings2,
   Share2,
   SlidersHorizontal,
   Video,
} from "lucide-react";
import type { AppState, Preferences } from "../../shared/types";
import { previewFilename, validFilenameTemplate } from "../../shared/filename";
import type { Ask } from "./App";
import { api, Button, Field, LevelSlider, Select, Toggle } from "./ui";
import type { Run } from "./ui";

const sections = [
   { id: "recording", label: "Recording", icon: Video },
   { id: "audio", label: "Audio", icon: AudioLines },
   { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
   { id: "collection", label: "Collection", icon: Folder },
   { id: "sharing", label: "Sharing", icon: Share2 },
   { id: "notifications", label: "Notifications", icon: Bell },
   { id: "general", label: "App & updates", icon: Settings2 },
] as const;
type Section = (typeof sections)[number]["id"];
function FilenameEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
   const input = useRef<HTMLInputElement>(null);
   useEffect(() => {
      if (input.current && document.activeElement !== input.current && input.current.value !== value) input.current.value = value;
   }, [value]);
   const insert = (token: string) => {
      const element = input.current;
      if (!element) return;
      element.focus();
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? start;
      if (!document.execCommand("insertText", false, token)) {
         element.setRangeText(token, start, end, "end");
         onChange(element.value);
      }
   };
   return (
      <div className="filename-editor">
         <label htmlFor="filename-pattern">Name pattern</label>
         <input
            id="filename-pattern"
            ref={input}
            defaultValue={value}
            onInput={(event) => onChange(event.currentTarget.value)}
            maxLength={160}
            spellCheck={false}
         />
         <div className="filename-tokens">
            {[
               { token: "{source}", name: "Application" },
               { token: "{date}", name: "Date" },
               { token: "{time}", name: "Time" },
            ].map((item) => (
               <button key={item.token} title={item.token} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(item.token)}>
                  {item.name}
                  <span>{item.token}</span>
               </button>
            ))}
         </div>
      </div>
   );
}
export function ShortcutInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
   const [editing, setEditing] = useState(false);
   return (
      <button
         className={`shortcut-input ${editing ? "editing" : ""}`}
         onClick={() => setEditing(true)}
         onBlur={() => setEditing(false)}
         onKeyDown={(event) => {
            if (!editing) return;
            event.preventDefault();
            if (event.key === "Escape") {
               setEditing(false);
               return;
            }
            if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;
            const parts = [
               event.ctrlKey && "Control",
               event.metaKey && "Command",
               event.altKey && "Alt",
               event.shiftKey && "Shift",
               event.code.startsWith("Key")
                  ? event.code.slice(3)
                  : event.code.startsWith("Digit")
                    ? event.code.slice(5)
                    : event.key === " "
                      ? "Space"
                      : event.key,
            ].filter(Boolean);
            onChange(parts.join("+"));
            setEditing(false);
         }}
         aria-label="Clip shortcut"
      >
         {editing ? "Press a shortcut…" : value.replace("CommandOrControl", navigator.platform.includes("Mac") ? "⌘" : "Ctrl").replaceAll("+", " + ")}
      </button>
   );
}
export function QualityPicker({
   value,
   onChange,
   recommended,
}: {
   value: Preferences["quality"];
   onChange: (value: Preferences["quality"]) => void;
   recommended?: "low" | "standard";
}) {
   return (
      <div className="quality-options">
         {(
            [
               { value: "low", title: "Low", detail: "720p · 30 fps", note: "Less impact" },
               { value: "standard", title: "Standard", detail: "1080p · 60 fps", note: "A balanced starting point" },
               { value: "high", title: "High", detail: "1440p · 60 fps", note: "More detail" },
               { value: "custom", title: "Custom", detail: "Your settings", note: "Choose resolution and detail" },
            ] as const
         ).map((item) => (
            <button
               key={item.value}
               className={`quality-option ${value === item.value ? "selected" : ""}`}
               onClick={() => onChange(item.value)}
               aria-pressed={value === item.value}
            >
               <span className="quality-dot">{value === item.value && <Check size={12} />}</span>
               <strong>{item.title}</strong>
               <span>{item.detail}</span>
               <small>{item.value === recommended ? "Recommended for this device" : item.note}</small>
            </button>
         ))}
      </div>
   );
}
const resolutions = [
   { name: "720p", width: 1280, height: 720 },
   { name: "1080p", width: 1920, height: 1080 },
   { name: "1440p", width: 2560, height: 1440 },
   { name: "4K", width: 3840, height: 2160 },
] as const;
export function customQualityError(value: Preferences): string {
   if (value.quality !== "custom") return "";
   if (!Number.isInteger(value.customWidth) || value.customWidth < 64 || value.customWidth > 7680 || value.customWidth % 2 !== 0)
      return "Width must be an even number between 64 and 7680.";
   if (!Number.isInteger(value.customHeight) || value.customHeight < 64 || value.customHeight > 4320 || value.customHeight % 2 !== 0)
      return "Height must be an even number between 64 and 4320.";
   if (!Number.isInteger(value.customFPS) || value.customFPS < 1 || value.customFPS > 120) return "Frame rate must be between 1 and 120 fps.";
   return "";
}
export function CustomQualityControls({ value, onChange }: { value: Preferences; onChange: (patch: Partial<Preferences>) => void }) {
   const resolution = resolutions.find((item) => item.width === value.customWidth && item.height === value.customHeight);
   return (
      <div className="custom-quality">
         <Field label="Resolution">
            <Select
               label="Custom recording resolution"
               value={resolution?.name ?? "custom"}
               onChange={(name) => {
                  const selected = resolutions.find((item) => item.name === name);
                  if (selected) onChange({ customWidth: selected.width, customHeight: selected.height });
               }}
            >
               {resolutions.map((item) => (
                  <option key={item.name} value={item.name}>
                     {item.name} · {item.width} × {item.height}
                  </option>
               ))}
               {!resolution && (
                  <option value="custom">
                     {value.customWidth} × {value.customHeight}
                  </option>
               )}
            </Select>
         </Field>
         <Field label="Frame rate">
            <Select label="Custom recording frame rate" value={String(value.customFPS)} onChange={(fps) => onChange({ customFPS: Number(fps) })}>
               {[30, 60, 120].map((fps) => (
                  <option key={fps} value={fps}>
                     {fps} fps
                  </option>
               ))}
               {![30, 60, 120].includes(value.customFPS) && <option value={value.customFPS}>{value.customFPS} fps</option>}
            </Select>
         </Field>
         <details className="quality-advanced">
            <summary>Advanced</summary>
            <Field label="Dimensions" detail="Even numbers, in pixels.">
               <div className="custom-dimensions">
                  <input
                     aria-label="Custom recording width"
                     type="number"
                     min={64}
                     max={7680}
                     step={2}
                     value={value.customWidth}
                     onChange={(event) => onChange({ customWidth: Number(event.target.value) })}
                  />
                  <span>×</span>
                  <input
                     aria-label="Custom recording height"
                     type="number"
                     min={64}
                     max={4320}
                     step={2}
                     value={value.customHeight}
                     onChange={(event) => onChange({ customHeight: Number(event.target.value) })}
                  />
               </div>
            </Field>
            <Field label="Frame rate">
               <div className="number-unit">
                  <input
                     aria-label="Custom recording FPS"
                     type="number"
                     min={1}
                     max={120}
                     value={value.customFPS}
                     onChange={(event) => onChange({ customFPS: Number(event.target.value) })}
                  />
                  <span>fps</span>
               </div>
            </Field>
            <Field label="Compression" detail="Lower values keep more detail and use more space.">
               <div className="compression-slider">
                  <div>
                     <span>More detail</span>
                     <output>{value.customCQ}</output>
                     <span>Smaller files</span>
                  </div>
                  <input
                     aria-label="Custom recording compression"
                     type="range"
                     min={12}
                     max={35}
                     step={1}
                     value={value.customCQ}
                     onChange={(event) => onChange({ customCQ: Number(event.target.value) })}
                  />
               </div>
            </Field>
            <Toggle
               label="Allow software encoding"
               detail="Uses your CPU if no supported hardware encoder is available."
               checked={value.allowSoftwareEncoder}
               onChange={(enabled) => onChange({ allowSoftwareEncoder: enabled })}
            />
         </details>
      </div>
   );
}
export function Settings({ state, run, ask }: { state: AppState; run: Run; ask: Ask }) {
   const [section, setSection] = useState<Section>("recording");
   const [draft, setDraft] = useState(state.preferences);
   const [baseline, setBaseline] = useState(JSON.stringify(state.preferences));
   const [saving, setSaving] = useState(false);
   const [saved, setSaved] = useState(false);
   const [audioDevices, setAudioDevices] = useState<{ id: string; name: string }[]>([]);
   useEffect(() => {
      if (section === "audio") void run(async () => setAudioDevices(await api.audioDevices()));
   }, [section, run]);
   const serialized = JSON.stringify(state.preferences);
   useEffect(() => {
      setDraft(JSON.parse(serialized) as Preferences);
      setBaseline(serialized);
   }, [serialized]);
   const dirty = JSON.stringify(draft) !== baseline;
   const recording = ["recording", "waiting", "starting"].includes(state.recorder.state);
   const captureSettings = section === "recording" || section === "audio";
   const collectionSettings = section === "collection";
   const pendingWork = state.recorder.pendingSaves > 0 || state.jobs.some((job) => job.state === "running" || job.state === "queued");
   const locked = (recording && (captureSettings || collectionSettings)) || (collectionSettings && pendingWork);
   const qualityError = customQualityError(draft);
   const filenameError =
      draft.filenamePreset === "custom" && !validFilenameTemplate(draft.filenameTemplate)
         ? draft.filenameTemplate.trim()
            ? "Use supported fields and leave out folder paths."
            : "Enter a filename pattern."
         : "";
   const change = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      setSaved(false);
      setDraft((current) => ({ ...current, [key]: value }));
   };
   const switchSection = async (id: Section) => {
      if (dirty && !(await ask({ title: "Discard these changes?", detail: "Your saved settings will stay unchanged.", confirm: "Discard changes" }))) return;
      setDraft(state.preferences);
      setBaseline(serialized);
      setSection(id);
   };
   const apply = async () => {
      setSaving(true);
      if (await run(() => api.savePreferences(draft))) {
         setBaseline(JSON.stringify(draft));
         setSaved(true);
         window.setTimeout(() => setSaved(false), 2500);
      }
      setSaving(false);
   };
   const chooseFolder = async () => {
      await run(async () => {
         const path = await api.chooseFolder();
         if (path) change("collection", path);
      });
   };
   const title = sections.find((item) => item.id === section)?.label;
   return (
      <div className="settings-page">
         <aside className="settings-sidebar">
            <h1>Settings</h1>
            {sections.map((item) => (
               <button key={item.id} className={`sidebar-item ${section === item.id ? "selected" : ""}`} onClick={() => void switchSection(item.id)}>
                  <item.icon size={17} />
                  {item.label}
               </button>
            ))}
            <div className="settings-sidebar-bottom">
               <span>AttaClip {state.version}</span>
               <span>Local files. Yours to keep.</span>
            </div>
         </aside>
         <div className="settings-main">
            <header className="settings-heading">
               <h1>{title}</h1>
            </header>
            <div className="settings-scroll">
               <div className="settings-body">
                  {section === "recording" && (
                     <>
                        <h2>Recording quality</h2>
                        <p className="section-description">
                           Hardware encoding is selected when available. Profiles are a starting point; check performance with your games.
                        </p>
                        <QualityPicker value={draft.quality} onChange={(value) => change("quality", value)} />
                        {draft.quality === "custom" && (
                           <CustomQualityControls
                              value={draft}
                              onChange={(patch) => {
                                 setSaved(false);
                                 setDraft((current) => ({ ...current, ...patch }));
                              }}
                           />
                        )}
                        {draft.quality !== "custom" && (
                           <details className="quality-advanced">
                              <summary>Advanced</summary>
                              <Toggle
                                 label="Allow software encoding"
                                 detail="Uses your CPU if no supported hardware encoder is available."
                                 checked={draft.allowSoftwareEncoder}
                                 onChange={(value) => change("allowSoftwareEncoder", value)}
                              />
                           </details>
                        )}
                        <div className="settings-divider" />
                        <Field label="Clip length" detail="How much recent footage the clip shortcut saves.">
                           <div className="number-unit">
                              <input
                                 type="number"
                                 min={5}
                                 max={1800}
                                 value={draft.clipSeconds}
                                 aria-label="Clip length in seconds"
                                 onChange={(event) => change("clipSeconds", Number(event.target.value))}
                              />
                              <span>seconds</span>
                           </div>
                        </Field>
                        <Toggle
                           checked={draft.avoidOverlap}
                           onChange={(value) => change("avoidOverlap", value)}
                           label="Reduce overlap between clips"
                           detail="Starts near the previous saved moment. A small overlap may remain."
                        />
                        <div className="settings-note">
                           <SlidersHorizontal size={17} />
                           <span>Changing recording settings requires stopping capture. Switching sources on the Recording page keeps your history.</span>
                        </div>
                     </>
                  )}
                  {section === "audio" && (
                     <>
                        <h2>Recorded audio</h2>
                        <p className="section-description">Each enabled source is recorded separately and included in the master mix.</p>
                        <Toggle
                           label="Capture audio"
                           detail="Desktop sound for Screen, application sound for App."
                           checked={draft.captureAudio}
                           onChange={(value) => change("captureAudio", value)}
                        />
                        <Toggle
                           label="Microphone"
                           detail="Include your voice in the master mix and a separate track."
                           checked={draft.microphone}
                           onChange={(value) => change("microphone", value)}
                        />
                        <Field label="Capture audio level">
                           <LevelSlider
                              label="Settings capture audio level"
                              value={draft.captureVolume}
                              disabled={!draft.captureAudio}
                              onCommit={(value) => change("captureVolume", value)}
                           />
                        </Field>
                        <Toggle
                           label="Mute capture audio"
                           detail="Silences the source in the master mix and isolated track."
                           checked={draft.captureMuted}
                           onChange={(value) => change("captureMuted", value)}
                           disabled={!draft.captureAudio}
                        />
                        <Field label="Microphone level">
                           <LevelSlider
                              label="Settings microphone level"
                              value={draft.microphoneVolume}
                              disabled={!draft.microphone}
                              onCommit={(value) => change("microphoneVolume", value)}
                           />
                        </Field>
                        <Toggle
                           label="Mute microphone"
                           checked={draft.microphoneMuted}
                           onChange={(value) => change("microphoneMuted", value)}
                           disabled={!draft.microphone}
                        />
                        <Field label="Microphone device" detail="Choose the microphone used by the recorder. Changes apply after you stop recording.">
                           <Select value={draft.microphoneDevice} onChange={(value) => change("microphoneDevice", value)} label="Microphone device">
                              <option value="default">System default</option>
                              {audioDevices
                                 .filter((item) => item.id !== "default")
                                 .map((item) => (
                                    <option key={item.id} value={item.id}>
                                       {item.name}
                                    </option>
                                 ))}
                              {draft.microphoneDevice !== "default" && !audioDevices.some((item) => item.id === draft.microphoneDevice) && (
                                 <option value={draft.microphoneDevice}>Selected device unavailable</option>
                              )}
                           </Select>
                        </Field>
                        <div className="settings-note">
                           <AudioLines size={18} />
                           <span>The master mix plays by default. Individual tracks can be selected when reviewing an original clip.</span>
                        </div>
                     </>
                  )}
                  {section === "shortcuts" && (
                     <>
                        <h2>Save a moment</h2>
                        <p className="section-description">Your shortcut works while AttaClip is in the tray. Choose a combination your game doesn't use.</p>
                        <Field label="Clip shortcut" detail="Click the control, then press your new shortcut.">
                           <ShortcutInput value={draft.shortcut} onChange={(value) => change("shortcut", value)} />
                        </Field>
                     </>
                  )}
                  {section === "collection" && (
                     <>
                        <h2>Your collection folder</h2>
                        <p className="section-description">
                           Supported videos in this folder appear in the Library. Choosing another folder leaves the previous one untouched.
                        </p>
                        <div className="folder-picker">
                           <Folder size={22} />
                           <span title={draft.collection}>{draft.collection}</span>
                           <Button onClick={() => void chooseFolder()}>Choose folder</Button>
                        </div>
                        <Button className="quiet reveal-folder" onClick={() => void run(() => api.reveal(draft.collection))}>
                           <FolderOpen size={15} />
                           Show in file manager
                        </Button>
                        <div className="settings-divider" />
                        <h2>New recordings</h2>
                        <Field label="Folder layout" detail="Only affects future clips. Existing files aren't reorganized.">
                           <Select
                              label="Folder layout"
                              value={draft.folderLayout}
                              onChange={(value) => change("folderLayout", value as Preferences["folderLayout"])}
                           >
                              <option value="flat">Single folder</option>
                              <option value="application">Application folders</option>
                           </Select>
                        </Field>
                        <Field label="Filename" detail="Separate from the folder layout.">
                           <Select
                              label="Filename preset"
                              value={draft.filenamePreset}
                              onChange={(value) => change("filenamePreset", value as Preferences["filenamePreset"])}
                           >
                              <option value="source-date">Application + date</option>
                              <option value="date-source">Date + application</option>
                              <option value="custom">Custom</option>
                           </Select>
                        </Field>
                        {draft.filenamePreset === "custom" && (
                           <FilenameEditor value={draft.filenameTemplate} onChange={(value) => change("filenameTemplate", value)} />
                        )}
                        <div className="filename-preview">
                           <span>{filenameError ? "Check pattern" : "Example"}</span>
                           {filenameError ? (
                              <span className="filename-error">{filenameError}</span>
                           ) : (
                              <code>{previewFilename(draft, "Desktop", new Date("2026-10-08T19:42:10Z"))}</code>
                           )}
                        </div>
                        <p className="section-description">
                           Shareables are kept in a separate folder beneath this collection. Categories organize clips without moving them.
                        </p>
                     </>
                  )}
                  {section === "sharing" && (
                     <>
                        <h2>A smaller copy, ready to send</h2>
                        <p className="section-description">Your original stays untouched. Shareables keep the full clip and use the master audio mix.</p>
                        <Field label="Default maximum size" detail="Used for manual and automatic creation. You can override it for an individual clip.">
                           <div className="number-unit">
                              <input
                                 type="number"
                                 min={1}
                                 max={2000}
                                 value={draft.shareSizeMB}
                                 aria-label="Default shareable size in MB"
                                 onChange={(event) => change("shareSizeMB", Number(event.target.value))}
                              />
                              <span>MB</span>
                           </div>
                        </Field>
                        <div className="size-presets">
                           {[10, 20, 50, 100].map((size) => (
                              <button className={draft.shareSizeMB === size ? "selected" : ""} key={size} onClick={() => change("shareSizeMB", size)}>
                                 {size} MB
                              </button>
                           ))}
                        </div>
                        <Toggle
                           label="Automatically create shareables"
                           detail="Create a copy after each clip saves. Compression uses extra resources during recording."
                           checked={draft.autoShare}
                           onChange={(value) => change("autoShare", value)}
                        />
                        <div className="settings-note">
                           <Share2 size={18} />
                           <span>Sharing uses local files. Nothing is uploaded by AttaClip.</span>
                        </div>
                     </>
                  )}
                  {section === "notifications" && (
                     <>
                        <h2>Clip feedback</h2>
                        <Field label="Show notifications">
                           <Select
                              label="Notification visibility"
                              value={draft.notifications}
                              onChange={(value) => change("notifications", value as Preferences["notifications"])}
                           >
                              <option value="everywhere">Everywhere</option>
                              <option value="outside-fullscreen">Outside fullscreen</option>
                              <option value="off">Off</option>
                           </Select>
                        </Field>
                        <Toggle
                           checked={draft.sound}
                           onChange={(value) => change("sound", value)}
                           label="Play a sound when a clip saves"
                           detail="Independent of visual notifications."
                        />
                        <p className="section-description">Recording problems remain visible in the status bar even when notifications are off.</p>
                     </>
                  )}
                  {section === "general" && (
                     <>
                        <h2>Startup</h2>
                        <Toggle label="Start with your computer" checked={draft.startWithOS} onChange={(value) => change("startWithOS", value)} />
                        <Toggle
                           label="Start recording when AttaClip opens"
                           detail="Uses your saved source. Application capture waits if its target is unavailable."
                           checked={draft.autoRecord}
                           onChange={(value) => change("autoRecord", value)}
                        />
                        <div className="settings-divider" />
                        <h2>Updates</h2>
                        <div className="update-panel">
                           <div>
                              <strong>AttaClip {state.version}</strong>
                              <span>{state.update.message || "Check for a newer version."}</span>
                           </div>
                           {state.update.state === "ready" || state.update.state === "available" ? (
                              <Button className="primary" onClick={() => void run(() => api.installUpdate())}>
                                 <Download size={16} />
                                 {state.update.state === "ready" ? "Restart to update" : "View release"}
                              </Button>
                           ) : (
                              <Button busy={["checking", "downloading"].includes(state.update.state)} onClick={() => void run(() => api.checkUpdate())}>
                                 <RefreshCw size={15} />
                                 {state.update.state === "downloading" ? `${Math.round(state.update.progress)}%` : "Check for updates"}
                              </Button>
                           )}
                        </div>
                        <p className="section-description">
                           Installing an update asks you to stop recording and finish pending work. It never restarts capture silently.
                        </p>
                        <div className="settings-divider" />
                        <h2>Privacy</h2>
                        <p className="section-description">
                           Your videos stay on this computer. No automatic uploads or telemetry. Local logs help explain errors.
                        </p>
                        <Button className="quiet" onClick={() => void run(() => api.exit())}>
                           <Power size={15} />
                           Exit AttaClip
                           <ChevronRight size={13} />
                        </Button>
                     </>
                  )}
               </div>
            </div>
            <footer className="settings-actions">
               <span>
                  {qualityError ||
                     filenameError ||
                     (locked
                        ? recording
                           ? "Stop recording before applying. Unsaved history will clear."
                           : "Finish pending work before changing the collection."
                        : dirty
                          ? "You have unsaved changes."
                          : saved
                            ? "Settings saved"
                            : "Changes apply when you save.")}
               </span>
               <Button
                  onClick={() => {
                     setDraft(state.preferences);
                     setBaseline(serialized);
                  }}
                  disabled={!dirty}
               >
                  Reset changes
               </Button>
               <Button
                  className="primary"
                  disabled={!dirty || locked || Boolean(qualityError) || Boolean(filenameError)}
                  busy={saving}
                  onClick={() => void apply()}
               >
                  {saved ? <Check size={16} /> : saving ? <LoaderCircle size={16} className="spin" /> : null}Apply
               </Button>
            </footer>
         </div>
      </div>
   );
}
