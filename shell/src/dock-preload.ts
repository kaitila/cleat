// The dock window's preload script, bundled as its own file (dock-preload.cjs). It runs in the
// page's sandboxed process before the page, and gives the page two functions and nothing else:
// window.holmDock.setState(state), and onChat(callback), which the shell calls to grow the
// island into the chat (the tray's "Open chat", a link to the chat view: D0042). The main process
// decides whether to take a setState; onChat hands the page a session id or null, nothing else.
import { contextBridge, ipcRenderer } from "electron";
import { DOCK_CHANNEL, DOCK_CHAT_CHANNEL } from "./dock";

contextBridge.exposeInMainWorld("holmDock", {
  setState: (state: unknown): void => {
    ipcRenderer.send(DOCK_CHANNEL, state);
  },
  onChat: (callback: unknown): void => {
    if (typeof callback !== "function") return;
    ipcRenderer.on(DOCK_CHAT_CHANNEL, (_event, session: unknown) => {
      callback(typeof session === "string" && session ? session : null);
    });
  },
});
