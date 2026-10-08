import { useEffect, useRef, useState } from "react";
import {
   ArrowLeft,
   Check,
   ChevronDown,
   Clapperboard,
   ExternalLink,
   Film,
   FolderOpen,
   Grip,
   LoaderCircle,
   Maximize,
   MoreHorizontal,
   Pause,
   Play,
   Share2,
   Trash2,
   Volume2,
   VolumeX,
} from "lucide-react";
import type { AppState, Clip } from "../../shared/types";
import { api, Button, describeError, Empty, formatSize, formatTime, IconButton, Menu, MenuItem, Segmented } from "./ui";
import type { Run } from "./ui";

export function Viewer({
   state,
   clip,
   visible,
   run,
   openLibrary,
}: {
   state: AppState;
   clip: Clip | undefined;
   visible: boolean;
   run: Run;
   openLibrary: () => void;
}) {
   const [version, setVersion] = useState<"original" | "shareable">("original");
   const [shareId, setShareId] = useState("");
   const [url, setUrl] = useState("");
   const [loading, setLoading] = useState(false);
   const [playing, setPlaying] = useState(false);
   const [time, setTime] = useState(0);
   const [duration, setDuration] = useState(0);
   const [volume, setVolume] = useState(1);
   const [track, setTrack] = useState(-1);
   const [target, setTarget] = useState(state.preferences.shareSizeMB);
   const [override, setOverride] = useState(false);
   const [mediaError, setMediaError] = useState("");
   const video = useRef<HTMLVideoElement>(null);
   const player = useRef<HTMLDivElement>(null);
   const seek = useRef(0);
   const switching = useRef(false);
   const currentUrl = useRef("");
   const resume = useRef(false);
   const previousClip = useRef<string | undefined>(undefined);
   const shareable = clip?.shareables.find((item) => item.id === shareId) ?? clip?.shareables.at(-1);
   const path = version === "shareable" ? shareable?.path : clip?.path;
   const job = state.jobs.find((item) => item.clipId === clip?.id && item.kind === "shareable" && ["queued", "running"].includes(item.state));
   useEffect(() => {
      if (previousClip.current !== clip?.id) {
         previousClip.current = clip?.id;
         seek.current = 0;
         resume.current = false;
         setTime(0);
         setVersion("original");
         setTrack(-1);
         setShareId("");
         setOverride(false);
         setTarget(state.preferences.shareSizeMB);
      }
   }, [clip?.id, state.preferences.shareSizeMB]);
   useEffect(() => {
      if (!visible) {
         video.current?.pause();
         resume.current = false;
         return;
      }
      if (!path) {
         setUrl("");
         return;
      }
      let disposed = false;
      switching.current = true;
      setLoading(true);
      setMediaError("");
      void (async () => {
         try {
            const result = await api.playback(path, version === "original" && track >= 0 ? track : undefined);
            if (!disposed) {
               if (currentUrl.current === result) switching.current = false;
               currentUrl.current = result;
               setUrl(result);
            }
         } catch (error) {
            if (!disposed) {
               setUrl("");
               setMediaError(describeError(error));
            }
         } finally {
            if (!disposed) setLoading(false);
         }
      })();
      return () => {
         disposed = true;
      };
   }, [path, track, version, visible]);
   const changeVersion = (next: "original" | "shareable") => {
      seek.current = video.current?.currentTime ?? time;
      resume.current = !video.current?.paused;
      setVersion(next);
   };
   const changeTrack = (value: number) => {
      seek.current = video.current?.currentTime ?? time;
      resume.current = !video.current?.paused;
      setTrack(value);
   };
   const toggle = () => {
      if (!video.current) return;
      if (video.current.paused) void run(() => video.current!.play());
      else video.current.pause();
   };
   useEffect(() => {
      if (!visible) return;
      const key = (event: KeyboardEvent) => {
         const element = event.target as HTMLElement;
         if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(element.tagName)) return;
         if (event.code === "Space") {
            event.preventDefault();
            if (video.current?.paused) void video.current.play().catch(() => undefined);
            else video.current?.pause();
         }
         if (event.code === "ArrowRight" && video.current) video.current.currentTime = Math.min(video.current.duration, video.current.currentTime + 5);
         if (event.code === "ArrowLeft" && video.current) video.current.currentTime = Math.max(0, video.current.currentTime - 5);
      };
      window.addEventListener("keydown", key);
      return () => window.removeEventListener("keydown", key);
   }, [visible]);
   const create = () => {
      if (clip) void run(() => api.createShareable(clip.id, override ? target : undefined));
   };
   const remove = async () => {
      if (!clip || !shareable) return;
      await run(async () => {
         await api.deleteClip(clip.id, shareable.id);
         const latest = await api.state();
         if (!latest.clips.find((item) => item.id === clip.id)?.shareables.some((item) => item.id === shareable.id)) setVersion("original");
      });
   };
   if (!clip)
      return (
         <Empty icon={<Film size={40} />} title="Open a moment" detail="Choose a clip from the Library to watch it and create a shareable.">
            <Button onClick={openLibrary}>
               <FolderOpen size={16} />
               Go to Library
            </Button>
         </Empty>
      );
   return (
      <div className="viewer-page">
         <aside className="viewer-sidebar">
            <button className="back-link" onClick={openLibrary}>
               <ArrowLeft size={16} />
               Library
            </button>
            <div className="viewer-title">
               <span className="source-label">{clip.source || "Video"}</span>
               <h1>{clip.name}</h1>
               <span className="muted">{new Date(clip.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
            </div>
            <Segmented
               label="Clip version"
               value={version}
               onChange={changeVersion}
               values={[
                  { value: "original", label: "Original" },
                  { value: "shareable", label: "Shareable" },
               ]}
            />
            <div className="version-info">
               {version === "original" ? (
                  <>
                     <div>
                        <span>File size</span>
                        <strong>{formatSize(clip.size)}</strong>
                     </div>
                     <div>
                        <span>Resolution</span>
                        <strong>
                           {clip.width} × {clip.height}
                        </strong>
                     </div>
                     <div>
                        <span>Duration</span>
                        <strong>{formatTime(clip.duration)}</strong>
                     </div>
                     <div>
                        <span>Audio tracks</span>
                        <strong>{clip.tracks.length || "None"}</strong>
                     </div>
                  </>
               ) : shareable ? (
                  <>
                     {clip.shareables.length > 1 && (
                        <div className="select-wrap version-select">
                           <select
                              aria-label="Choose shareable"
                              value={shareable.id}
                              onChange={(event) => {
                                 seek.current = video.current?.currentTime ?? time;
                                 setShareId(event.target.value);
                              }}
                           >
                              {clip.shareables.map((item) => (
                                 <option key={item.id} value={item.id}>
                                    {item.targetMB} MB target · {formatSize(item.size)}
                                 </option>
                              ))}
                           </select>
                           <ChevronDown size={14} />
                        </div>
                     )}
                     <div>
                        <span>File size</span>
                        <strong>{formatSize(shareable.size)}</strong>
                     </div>
                     <div>
                        <span>Size target</span>
                        <strong>{shareable.targetMB} MB</strong>
                     </div>
                     <div>
                        <span>Ready to share</span>
                        <Check size={15} className="success-text" />
                     </div>
                  </>
               ) : (
                  <p className="muted">No shareable yet. Create a smaller copy without changing your original.</p>
               )}
               {path && (
                  <button
                     className="drag-file"
                     draggable
                     onDragStart={(event) => {
                        event.preventDefault();
                        api.dragFile(path);
                     }}
                     onClick={() => void run(() => api.reveal(path))}
                  >
                     <Grip size={17} />
                     <span>Drag file into another app</span>
                     <ExternalLink size={13} />
                  </button>
               )}
            </div>
            <div className="viewer-sidebar-bottom">
               {job ? (
                  <div className="export-progress">
                     <div>
                        <LoaderCircle size={15} className="spin" />
                        <span>{job.state === "queued" ? "Waiting to create" : "Creating shareable"}</span>
                        <strong>{Math.round(job.progress * 100)}%</strong>
                     </div>
                     <progress max={1} value={job.progress} />
                     <Button onClick={() => void run(() => api.cancelJob(job.id))}>Cancel</Button>
                  </div>
               ) : (
                  <>
                     <div className="share-target">
                        <button onClick={() => setOverride(!override)}>
                           Size target{" "}
                           <span>
                              {override ? target : state.preferences.shareSizeMB} MB <ChevronDown size={12} />
                           </span>
                        </button>
                        {override && (
                           <div className="target-override">
                              <input
                                 type="number"
                                 min={1}
                                 max={2000}
                                 value={target}
                                 aria-label="Shareable size target in MB"
                                 onChange={(event) => setTarget(Math.max(1, Math.min(2000, Number(event.target.value))))}
                              />
                              <span>MB</span>
                              <button onClick={() => setOverride(false)}>Use default</button>
                           </div>
                        )}
                     </div>
                     <Button className="primary wide" onClick={create}>
                        <Share2 size={17} />
                        {clip.shareables.length ? "Create another shareable" : "Create shareable"}
                     </Button>
                  </>
               )}
               {path && (
                  <div className="reveal-row">
                     <Button className="wide" onClick={() => void run(() => api.reveal(path))}>
                        <FolderOpen size={16} />
                        Show file
                     </Button>
                     {version === "shareable" && shareable && (
                        <Menu label="Shareable actions" trigger={<MoreHorizontal size={17} />}>
                           <MenuItem danger onClick={() => void remove()}>
                              <Trash2 size={14} />
                              Delete shareable
                           </MenuItem>
                        </Menu>
                     )}
                  </div>
               )}
               <Button className="quiet wide" onClick={() => void run(() => api.openInAttaCut(clip.id))}>
                  <Clapperboard size={17} />
                  Open in AttaCut
                  <ExternalLink size={13} />
               </Button>
            </div>
         </aside>
         <div className="viewer-main" ref={player}>
            <div className="video-stage">
               {loading && (
                  <div className="video-loading">
                     <LoaderCircle size={30} className="spin" />
                     <span>Preparing playback</span>
                  </div>
               )}
               {url ? (
                  <video
                     ref={video}
                     src={url}
                     poster={clip.thumbnail || undefined}
                     onLoadedMetadata={(event) => {
                        const media = event.currentTarget;
                        setDuration(media.duration);
                        media.currentTime = Math.min(seek.current, media.duration || 0);
                        switching.current = false;
                        media.volume = volume;
                        if (resume.current) void media.play().catch(() => undefined);
                     }}
                     onTimeUpdate={(event) => {
                        if (switching.current) return;
                        setTime(event.currentTarget.currentTime);
                        seek.current = event.currentTarget.currentTime;
                     }}
                     onPlay={() => setPlaying(true)}
                     onPause={() => setPlaying(false)}
                     onError={() => setMediaError("This video could not be played. Try opening it in AttaCut or another player.")}
                     onClick={toggle}
                  />
               ) : (
                  !loading && (
                     <Empty
                        icon={<Share2 size={38} />}
                        title={mediaError ? "Playback unavailable" : "Make it shareable"}
                        detail={mediaError || "Create a smaller copy, then compare it here."}
                     >
                        {!mediaError && (
                           <Button className="primary" onClick={create} disabled={!!job}>
                              Create shareable
                           </Button>
                        )}
                     </Empty>
                  )
               )}
               {mediaError && url && (
                  <div className="playback-error" role="alert">
                     {mediaError}
                  </div>
               )}
            </div>
            <div className="player-controls">
               <input
                  className="seek-slider"
                  type="range"
                  aria-label="Playback position"
                  min={0}
                  max={duration || clip.duration || 1}
                  step={0.05}
                  value={Math.min(time, duration || clip.duration)}
                  onChange={(event) => {
                     const next = Number(event.target.value);
                     if (video.current) video.current.currentTime = next;
                     setTime(next);
                     seek.current = next;
                  }}
                  disabled={!url}
                  style={{ "--progress": `${duration ? (time / duration) * 100 : 0}%` } as React.CSSProperties}
               />
               <div className="player-control-row">
                  <IconButton label={playing ? "Pause" : "Play"} disabled={!url} onClick={toggle}>
                     {playing ? <Pause size={21} fill="currentColor" /> : <Play size={21} fill="currentColor" />}
                  </IconButton>
                  <span className="player-time tabular">
                     {formatTime(time)} <span>/ {formatTime(duration || clip.duration)}</span>
                  </span>
                  <div className="volume-control">
                     <IconButton
                        label={volume > 0 ? "Mute playback" : "Unmute playback"}
                        onClick={() => {
                           const next = volume > 0 ? 0 : 1;
                           setVolume(next);
                           if (video.current) video.current.volume = next;
                        }}
                     >
                        {volume > 0 ? <Volume2 size={18} /> : <VolumeX size={18} />}
                     </IconButton>
                     <input
                        type="range"
                        aria-label="Playback volume"
                        min={0}
                        max={1}
                        step={0.01}
                        value={volume}
                        onChange={(event) => {
                           const next = Number(event.target.value);
                           setVolume(next);
                           if (video.current) video.current.volume = next;
                        }}
                     />
                  </div>
                  <div className="player-spacer" />
                  {version === "original" && clip.tracks.length > 1 && (
                     <div className="audio-select select-wrap">
                        <select aria-label="Audio track" value={track} onChange={(event) => changeTrack(Number(event.target.value))}>
                           {clip.tracks.map((item, ordinal) => (
                              <option value={ordinal === 0 ? -1 : item.index} key={item.index}>
                                 {item.title || `Track ${item.index + 1}`}
                              </option>
                           ))}
                        </select>
                        <ChevronDown size={13} />
                     </div>
                  )}
                  <IconButton
                     label="Fullscreen"
                     disabled={!url}
                     onClick={() => void run(() => (document.fullscreenElement ? document.exitFullscreen() : player.current!.requestFullscreen()))}
                  >
                     <Maximize size={18} />
                  </IconButton>
               </div>
            </div>
         </div>
      </div>
   );
}
