import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent, DesktopAPI } from "../shared/types";
const api: DesktopAPI = {
   state: () => ipcRenderer.invoke("state"),
   sources: () => ipcRenderer.invoke("sources"),
   previewSource: (sourceId) => ipcRenderer.invoke("preview-source", sourceId),
   audioDevices: () => ipcRenderer.invoke("audio-devices"),
   savePreferences: (value) => ipcRenderer.invoke("preferences", value),
   chooseFolder: () => ipcRenderer.invoke("choose-folder"),
   startRecording: () => ipcRenderer.invoke("record-start"),
   stopRecording: () => ipcRenderer.invoke("record-stop"),
   saveClip: () => ipcRenderer.invoke("record-save"),
   createShareable: (id, target) => ipcRenderer.invoke("share", id, target),
   cancelJob: (id) => ipcRenderer.invoke("cancel-job", id),
   renameClip: (id, name) => ipcRenderer.invoke("rename", id, name),
   deleteClip: (id, shareId) => ipcRenderer.invoke("delete", id, shareId),
   category: (action, value) => ipcRenderer.invoke("category", action, value),
   reveal: (path) => ipcRenderer.invoke("reveal", path),
   openInAttaCut: (id) => ipcRenderer.invoke("attacut", id),
   dragFile: (path) => ipcRenderer.send("drag", path),
   playback: (path, track) => ipcRenderer.invoke("playback", path, track),
   refresh: () => ipcRenderer.invoke("refresh"),
   checkUpdate: () => ipcRenderer.invoke("update-check"),
   installUpdate: () => ipcRenderer.invoke("update-install"),
   window: (action) => ipcRenderer.send("window", action),
   exit: () => ipcRenderer.invoke("exit"),
   onEvent: (listener) => {
      const handler = (_: Electron.IpcRendererEvent, event: AppEvent) => listener(event);
      ipcRenderer.on("app-event", handler);
      return () => {
         ipcRenderer.removeListener("app-event", handler);
      };
   },
};
contextBridge.exposeInMainWorld("attaClip", api);
