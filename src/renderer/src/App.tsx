import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Check, Clapperboard, Film, Folder, LoaderCircle, Minus, Monitor, Settings2, Square, Video, X } from "lucide-react";
import type { AppState, Clip } from "../../shared/types";
import { api, describeError, Dialog, formatTime, IconButton } from "./ui";
import type { DialogRequest, Run } from "./ui";
import { Recording } from "./Recording";
import { Library } from "./Library";
import { Viewer } from "./Viewer";
import { Settings } from "./Settings";
import { Onboarding } from "./Onboarding";

type Page = "recording" | "library" | "viewer" | "settings";
export type Ask = (request: Omit<DialogRequest, "resolve">) => Promise<string | boolean | null>;
export function App() {
   const [state, setState] = useState<AppState | null>(null);
   const [page, setPage] = useState<Page>("recording");
   const [windowVisible, setWindowVisible] = useState(!document.hidden);
   useEffect(() => {
      const update = () => setWindowVisible(!document.hidden);
      document.addEventListener("visibilitychange", update);
      return () => document.removeEventListener("visibilitychange", update);
   }, []);
   const [selected, setSelected] = useState<string | null>(null);
   const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
   const [dialog, setDialog] = useState<DialogRequest | null>(null);
   const [clipPulse, setClipPulse] = useState(0);
   const [elapsed, setElapsed] = useState(0);
   const run: Run = useCallback(async (action) => {
      try {
         await action();
         return true;
      } catch (error) {
         setNotice({ message: describeError(error), error: true });
         return false;
      }
   }, []);
   const ask: Ask = useCallback((request) => new Promise((resolve) => setDialog({ ...request, resolve })), []);
   useEffect(() => {
      void run(async () => {
         const loaded = await api.state();
         setState(loaded);
         setWindowVisible(loaded.windowVisible);
      });
      return api.onEvent((event) => {
         if (event.state) {
            setState(event.state);
            setWindowVisible(event.state.windowVisible);
         }
         if (event.type === "visibility" && event.visible !== undefined) setWindowVisible(event.visible);
         if (event.type === "clip-action") setClipPulse((value) => value + 1);
         if (event.message) setNotice({ message: event.message, error: event.error ?? false });
      });
   }, [run]);
   useEffect(() => {
      if (!notice || notice.error) return;
      const timer = window.setTimeout(() => setNotice(null), 5000);
      return () => window.clearTimeout(timer);
   }, [notice]);
   useEffect(() => {
      const started = state?.recorder.startedAt;
      const update = () => setElapsed(started ? Math.max(0, (Date.now() - started) / 1000) : 0);
      update();
      const timer = window.setInterval(update, 1000);
      return () => window.clearInterval(timer);
   }, [state?.recorder.startedAt]);
   const clip = state?.clips.find((item) => item.id === selected) ?? (selected === null ? state?.clips[0] : undefined);
   const openClip = (value: Clip) => {
      setSelected(value.id);
      setPage("viewer");
   };
   const pages = [
      { id: "recording", title: "Recording", icon: Video },
      { id: "library", title: "Library", icon: Folder },
      { id: "viewer", title: "Clip viewer", icon: Film },
   ] as const;
   const recorder = state?.recorder;
   const active = recorder?.state === "recording";
   const status = active
      ? recorder?.message || "Recording"
      : recorder?.state === "waiting"
        ? recorder?.message || "Waiting for application"
        : recorder?.state === "starting"
          ? "Starting recording"
          : recorder?.state === "error"
            ? "Recording stopped"
            : "Not recording";
   const captureName =
      recorder?.sourceName || (state?.preferences.sourceKind === "screen" ? "Screen" : state?.preferences.sourceKind === "auto" ? "Auto" : "Application");
   return (
      <div className="app-shell">
         <header className="titlebar">
            <div className="wordmark">
               <Clapperboard size={17} />
               <span>AttaClip</span>
            </div>
            <div className="titlebar-drag" />
            <span className="window-page">
               {page === "viewer" ? "Clip viewer" : page[0]?.toUpperCase()}
               {page === "viewer" ? "" : page.slice(1)}
            </span>
            {state?.platform !== "darwin" && (
               <div className="window-controls">
                  <IconButton label="Minimize" onClick={() => api.window("minimize")}>
                     <Minus size={15} />
                  </IconButton>
                  <IconButton label="Maximize" onClick={() => api.window("maximize")}>
                     <Square size={12} />
                  </IconButton>
                  <IconButton label="Close to tray" className="window-close" onClick={() => api.window("close")}>
                     <X size={16} />
                  </IconButton>
               </div>
            )}
         </header>
         <nav className="rail" aria-label="Main navigation">
            <div className="rail-main">
               {pages.map((item) => (
                  <button
                     key={item.id}
                     title={item.title}
                     aria-label={item.title}
                     aria-current={page === item.id ? "page" : undefined}
                     className={`rail-button ${page === item.id ? "selected" : ""}`}
                     onClick={() => setPage(item.id)}
                  >
                     <item.icon size={23} strokeWidth={1.65} />
                     <span>{item.title}</span>
                  </button>
               ))}
            </div>
            <button
               title="Settings"
               aria-label="Settings"
               aria-current={page === "settings" ? "page" : undefined}
               className={`rail-button ${page === "settings" ? "selected" : ""}`}
               onClick={() => setPage("settings")}
            >
               <Settings2 size={23} strokeWidth={1.65} />
               <span>Settings</span>
            </button>
         </nav>
         <main className="workspace">
            {state ? (
               <>
                  <section className="page" hidden={page !== "recording"}>
                     <Recording state={state} visible={page === "recording" && windowVisible} run={run} pulse={clipPulse} />
                  </section>
                  <section className="page" hidden={page !== "library"}>
                     <Library state={state} run={run} ask={ask} openClip={openClip} openSettings={() => setPage("settings")} />
                  </section>
                  <section className="page" hidden={page !== "viewer"}>
                     <Viewer state={state} clip={clip} visible={page === "viewer" && windowVisible} run={run} openLibrary={() => setPage("library")} />
                  </section>
                  <section className="page" hidden={page !== "settings"}>
                     <Settings state={state} run={run} ask={ask} />
                  </section>
               </>
            ) : (
               <div className="loading-app">
                  <LoaderCircle size={30} className="spin" />
                  <p>Opening your collection…</p>
               </div>
            )}
         </main>
         <footer className={`status-strip ${recorder?.state === "error" ? "has-error" : ""}`}>
            <div className="status-primary">
               {recorder?.state === "starting" ? (
                  <LoaderCircle size={12} className="spin" />
               ) : recorder?.state === "error" ? (
                  <AlertCircle size={13} />
               ) : (
                  <span className={`status-dot ${active ? "recording" : ""}`} />
               )}
               <span>{status}</span>
               {active && (
                  <>
                     <span className="status-divider" />
                     <span className="tabular">{formatTime(elapsed)}</span>
                     <span className="status-secondary">{Math.floor(recorder.availableSeconds)}s available</span>
                  </>
               )}
            </div>
            <div className="status-right">
               {recorder && !active && recorder.message && (
                  <span className="status-message" title={recorder.message}>
                     {recorder.message}
                  </span>
               )}
               {active && (
                  <span className="status-secondary">
                     <Monitor size={12} />
                     {captureName}
                  </span>
               )}
               {recorder && recorder.pendingSaves > 0 && (
                  <span>
                     <LoaderCircle size={12} className="spin" />
                     Saving {recorder.pendingSaves > 1 ? `${recorder.pendingSaves} clips` : "clip"}
                  </span>
               )}
               {state?.jobs.some((job) => job.kind === "shareable" && ["running", "queued"].includes(job.state)) && (
                  <span>
                     <LoaderCircle size={12} className="spin" />
                     Creating shareable
                  </span>
               )}
            </div>
         </footer>
         {notice && (
            <div className={`toast ${notice.error ? "error" : ""}`} role={notice.error ? "alert" : "status"}>
               {notice.error ? <AlertCircle size={18} /> : <Check size={18} />}
               <span>{notice.message}</span>
               <IconButton label="Dismiss" onClick={() => setNotice(null)}>
                  <X size={15} />
               </IconButton>
            </div>
         )}
         {dialog && <Dialog key={dialog.title} request={dialog} close={() => setDialog(null)} />}
         {state && !state.preferences.setupComplete && <Onboarding state={state} run={run} />}
      </div>
   );
}
