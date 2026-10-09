import { useMemo, useRef, useState } from "react";
import {
   AppWindow,
   Check,
   ChevronDown,
   Clapperboard,
   Folder,
   FolderOpen,
   Grid2X2,
   LoaderCircle,
   MoreHorizontal,
   Pencil,
   Plus,
   Search,
   Share2,
   Tag,
   Trash2,
   X,
} from "lucide-react";
import type { AppState, Clip } from "../../shared/types";
import type { Ask } from "./App";
import { age, api, Button, Empty, folderName, formatSize, formatTime, IconButton, Menu, MenuItem } from "./ui";
import type { Run } from "./ui";

export function Library({
   state,
   run,
   ask,
   openClip,
   openSettings,
}: {
   state: AppState;
   run: Run;
   ask: Ask;
   openClip: (clip: Clip) => void;
   openSettings: () => void;
}) {
   const [query, setQuery] = useState("");
   const [filter, setFilter] = useState("all");
   const [order, setOrder] = useState("newest");
   const [categoryClip, setCategoryClip] = useState<Clip | null>(null);
   const categoryEdit = useRef<{ clip: Clip; persisted: string[]; pending: Promise<void> } | null>(null);
   const openCategories = (clip: Clip) => {
      categoryEdit.current = { clip, persisted: clip.categories, pending: Promise.resolve() };
      setCategoryClip(clip);
   };
   const closeCategories = () => {
      categoryEdit.current = null;
      setCategoryClip(null);
   };
   const sources = useMemo(() => [...new Set(state.clips.map((item) => item.source))].filter(Boolean).sort(), [state.clips]);
   const folders = useMemo(
      () => [...new Set(state.clips.map((item) => item.relativePath.replaceAll("\\", "/").split("/").slice(0, -1).join("/")))].filter(Boolean).sort(),
      [state.clips]
   );
   const clips = useMemo(
      () =>
         state.clips
            .filter(
               (item) =>
                  (!query || `${item.name} ${item.source}`.toLowerCase().includes(query.toLowerCase())) &&
                  (filter === "all" ||
                     (filter.startsWith("category:") && item.categories.includes(filter.slice(9))) ||
                     (filter.startsWith("source:") && item.source === filter.slice(7)) ||
                     (filter.startsWith("folder:") && item.relativePath.replaceAll("\\", "/").startsWith(`${filter.slice(7)}/`)))
            )
            .sort((a, b) => (order === "name" ? a.name.localeCompare(b.name) : order === "oldest" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt)),
      [state.clips, query, filter, order]
   );
   const selectedCategory = state.categories.find((item) => `category:${item.id}` === filter);
   const heading = filter === "all" ? "All clips" : (selectedCategory?.name ?? filter.slice(filter.indexOf(":") + 1));
   const createCategory = async () => {
      const name = await ask({
         title: "New category",
         detail: "Group clips without moving their files. A clip can belong to several categories.",
         confirm: "Create",
         initial: "",
      });
      if (typeof name === "string" && name) await run(() => api.category("create", { name, color: "#b197fc" }));
   };
   const removeCategory = async (id: string, name: string) => {
      if (
         await ask({
            title: `Delete ${name}?`,
            detail: "Only the category is removed. Your clips and shareables stay where they are.",
            confirm: "Delete category",
            danger: true,
         })
      ) {
         if (await run(() => api.category("delete", { id }))) setFilter("all");
      }
   };
   const rename = async (clip: Clip) => {
      const name = await ask({ title: "Rename clip", detail: "Change the name of this clip in your collection.", confirm: "Rename", initial: clip.name });
      if (typeof name === "string" && name) await run(() => api.renameClip(clip.id, name));
   };
   const remove = async (clip: Clip) => {
      // The main process owns confirmation and trashing, so every entry point gets one prompt.
      await run(() => api.deleteClip(clip.id));
   };
   const assign = (id: string) => {
      const edit = categoryEdit.current;
      if (!edit) return;
      const ids = edit.clip.categories.includes(id) ? edit.clip.categories.filter((item) => item !== id) : [...edit.clip.categories, id];
      edit.clip = { ...edit.clip, categories: ids };
      setCategoryClip(edit.clip);
      // Keep accepted selections ordered even if the dialog closes before disk writes finish.
      edit.pending = edit.pending.then(async () => {
         if (await run(() => api.category("assign", { clipId: edit.clip.id, categoryIds: ids }))) {
            edit.persisted = ids;
         } else if (categoryEdit.current === edit && edit.clip.categories === ids) {
            edit.clip = { ...edit.clip, categories: edit.persisted };
            setCategoryClip(edit.clip);
         }
      });
   };
   return (
      <div className="library-page">
         <aside className="library-sidebar">
            <div className="collection-home">
               <Folder size={20} />
               <div>
                  <span className="collection-label">Collection</span>
                  <button title={state.preferences.collection} onClick={() => void run(() => api.reveal(state.preferences.collection))}>
                     {folderName(state.preferences.collection)}
                  </button>
               </div>
               <Menu label="Collection actions" trigger={<MoreHorizontal size={17} />}>
                  <MenuItem onClick={() => void run(() => api.reveal(state.preferences.collection))}>
                     <FolderOpen size={15} />
                     Show in file manager
                  </MenuItem>
                  <MenuItem onClick={openSettings}>
                     <Folder size={15} />
                     Choose folder in settings
                  </MenuItem>
                  <MenuItem onClick={() => void run(() => api.refresh())}>
                     <Grid2X2 size={15} />
                     Refresh collection
                  </MenuItem>
               </Menu>
            </div>
            <div className="sidebar-scroll">
               <button className={`sidebar-item ${filter === "all" ? "selected" : ""}`} onClick={() => setFilter("all")}>
                  <Grid2X2 size={17} />
                  All clips<span className="count">{state.clips.length}</span>
               </button>
               <div className="sidebar-group-title">
                  Categories
                  <IconButton label="New category" onClick={() => void createCategory()}>
                     <Plus size={14} />
                  </IconButton>
               </div>
               {state.categories.map((item) => (
                  <div className="category-item" key={item.id}>
                     <button className={`sidebar-item ${filter === `category:${item.id}` ? "selected" : ""}`} onClick={() => setFilter(`category:${item.id}`)}>
                        <Tag size={16} style={{ color: item.color }} />
                        {item.name}
                        <span className="count">{state.clips.filter((clip) => clip.categories.includes(item.id)).length}</span>
                     </button>
                     <Menu label={`Actions for ${item.name}`} trigger={<MoreHorizontal size={14} />}>
                        <MenuItem danger onClick={() => void removeCategory(item.id, item.name)}>
                           <Trash2 size={14} />
                           Delete category
                        </MenuItem>
                     </Menu>
                  </div>
               ))}
               {!state.categories.length && (
                  <button className="sidebar-item new-category" onClick={() => void createCategory()}>
                     <Plus size={16} />
                     New category
                  </button>
               )}
               {sources.length > 0 && (
                  <>
                     <div className="sidebar-group-title">Applications</div>
                     {sources.map((source) => (
                        <button
                           key={source}
                           className={`sidebar-item ${filter === `source:${source}` ? "selected" : ""}`}
                           onClick={() => setFilter(`source:${source}`)}
                        >
                           <AppWindow size={16} />
                           {source}
                        </button>
                     ))}
                  </>
               )}
               {folders.length > 0 && (
                  <>
                     <div className="sidebar-group-title">Folders</div>
                     {folders.map((folder) => (
                        <button
                           key={folder}
                           className={`sidebar-item ${filter === `folder:${folder}` ? "selected" : ""}`}
                           onClick={() => setFilter(`folder:${folder}`)}
                           title={folder}
                        >
                           <Folder size={16} />
                           {folder}
                        </button>
                     ))}
                  </>
               )}
            </div>
            <div className="sidebar-bottom">
               {state.clips.length} {state.clips.length === 1 ? "clip" : "clips"} · {formatSize(state.clips.reduce((sum, item) => sum + item.size, 0))}
            </div>
         </aside>
         <div className="library-content">
            <header className="library-heading">
               <div>
                  <h1>{heading}</h1>
                  <p>
                     {clips.length} {clips.length === 1 ? "moment" : "moments"} saved
                  </p>
               </div>
               <div className="library-tools">
                  <div className="search-input">
                     <Search size={16} />
                     <input aria-label="Search clips" placeholder="Search clips" value={query} onChange={(event) => setQuery(event.target.value)} />
                     {query && (
                        <IconButton label="Clear search" onClick={() => setQuery("")}>
                           <X size={13} />
                        </IconButton>
                     )}
                  </div>
                  <div className="sort-control">
                     <select value={order} onChange={(event) => setOrder(event.target.value)} aria-label="Sort clips">
                        <option value="newest">Newest first</option>
                        <option value="oldest">Oldest first</option>
                        <option value="name">Name</option>
                     </select>
                     <ChevronDown size={13} />
                  </div>
               </div>
            </header>
            <div className="library-scroll">
               {clips.length ? (
                  <div className="clip-grid">
                     {clips.map((clip) => {
                        const job = state.jobs.find(
                           (item) => item.clipId === clip.id && item.kind === "shareable" && ["running", "queued"].includes(item.state)
                        );
                        const shareable = clip.shareables.at(-1);
                        return (
                           <article className="clip-card" key={clip.id}>
                              <button className="clip-open" onClick={() => openClip(clip)} aria-label={`Open ${clip.name}`}>
                                 <div className="clip-thumbnail">
                                    {clip.thumbnail ? (
                                       <img src={clip.thumbnail} alt="" loading="lazy" />
                                    ) : (
                                       <div className="thumbnail-fallback">
                                          <Clapperboard size={34} />
                                       </div>
                                    )}
                                    <span className="duration">{formatTime(clip.duration)}</span>
                                    {shareable && (
                                       <span className="copy-indicator" title={`${clip.shareables.length} shareable${clip.shareables.length === 1 ? "" : "s"}`}>
                                          <Share2 size={12} />
                                       </span>
                                    )}
                                    {job && (
                                       <div className="thumbnail-progress">
                                          <span style={{ width: `${job.progress * 100}%` }} />
                                       </div>
                                    )}
                                 </div>
                                 <div className="clip-card-info">
                                    <h3 title={clip.name}>{clip.name}</h3>
                                    <p>
                                       <span>{clip.source || "Video"}</span>
                                       <span>·</span>
                                       <span>{age(clip.createdAt)}</span>
                                    </p>
                                 </div>
                              </button>
                              <div className="card-menu">
                                 <Menu label={`Actions for ${clip.name}`} trigger={<MoreHorizontal size={17} />}>
                                    <MenuItem onClick={() => openClip(clip)}>
                                       <Clapperboard size={15} />
                                       Open clip
                                    </MenuItem>
                                    <MenuItem disabled={!!job} onClick={() => void run(() => api.createShareable(clip.id))}>
                                       <Share2 size={15} />
                                       {job ? "Creating shareable…" : "Create shareable"}
                                    </MenuItem>
                                    {shareable && (
                                       <MenuItem onClick={() => void run(() => api.reveal(shareable.path))}>
                                          <FolderOpen size={15} />
                                          Reveal shareable
                                       </MenuItem>
                                    )}
                                    <MenuItem onClick={() => openCategories(clip)}>
                                       <Tag size={15} />
                                       Categories
                                    </MenuItem>
                                    <MenuItem onClick={() => void rename(clip)}>
                                       <Pencil size={15} />
                                       Rename
                                    </MenuItem>
                                    <MenuItem onClick={() => void run(() => api.reveal(clip.path))}>
                                       <Folder size={15} />
                                       Reveal original
                                    </MenuItem>
                                    <div className="menu-separator" />
                                    <MenuItem danger onClick={() => void remove(clip)}>
                                       <Trash2 size={15} />
                                       Delete clip
                                    </MenuItem>
                                 </Menu>
                              </div>
                              {job && (
                                 <div className="card-job">
                                    <LoaderCircle size={12} className="spin" />
                                    <span>{job.state === "queued" ? "Queued" : "Creating shareable"}</span>
                                    <span className="tabular">{Math.round(job.progress * 100)}%</span>
                                    <IconButton label="Cancel shareable" onClick={() => void run(() => api.cancelJob(job.id))}>
                                       <X size={12} />
                                    </IconButton>
                                 </div>
                              )}
                           </article>
                        );
                     })}
                  </div>
               ) : (
                  <Empty
                     icon={<FolderOpen size={38} />}
                     title={query ? "No matching clips" : filter !== "all" ? "No clips here yet" : "Your moments live here"}
                     detail={
                        query
                           ? "Try another name or application."
                           : filter !== "all"
                             ? "Choose a different filter, or add a clip to this category."
                             : "Save a clip while recording, or put supported videos into your collection folder."
                     }
                  >
                     {filter !== "all" && (
                        <Button
                           onClick={() => {
                              setFilter("all");
                              setQuery("");
                           }}
                        >
                           Show all clips
                        </Button>
                     )}
                     {filter === "all" && !query && (
                        <Button onClick={() => void run(() => api.reveal(state.preferences.collection))}>
                           <FolderOpen size={16} />
                           Open collection folder
                        </Button>
                     )}
                  </Empty>
               )}
            </div>
         </div>
         {categoryClip && (
            <div className="modal-backdrop" onClick={closeCategories}>
               <div
                  className="dialog category-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Clip categories"
                  onClick={(event) => event.stopPropagation()}
               >
                  <IconButton label="Close categories" className="dialog-close" onClick={closeCategories}>
                     <X size={17} />
                  </IconButton>
                  <h2>Categories</h2>
                  <p>{categoryClip.name}</p>
                  {state.categories.length ? (
                     state.categories.map((item) => (
                        <button key={item.id} className="category-option" onClick={() => void assign(item.id)}>
                           <Tag size={17} style={{ color: item.color }} />
                           {item.name}
                           {categoryClip.categories.includes(item.id) && <Check size={17} />}
                        </button>
                     ))
                  ) : (
                     <p>Create a category in the Library sidebar first.</p>
                  )}
                  <Button className="primary" onClick={closeCategories}>
                     Done
                  </Button>
               </div>
            </div>
         )}
      </div>
   );
}
