// The dock window's preload script, bundled as its own file (dock-preload.cjs). It runs in the
// page's sandboxed process before the page, and gives the page two functions and nothing else:
// window.holmDock.setState(state), onChat(callback), which the shell calls to grow the
// island into the chat (the tray's "Open chat", a link to the chat view: D0042), and
// onChatKey(callback), for the chat's hotkey (D0046), which the page takes as "into the chat, or out
// of it". The main process decides whether to take a setState; onChat hands the page a session id or
// null, onChatKey nothing at all.
import { contextBridge, ipcRenderer } from "electron";
import { DOCK_CHANNEL, DOCK_CHAT_CHANNEL, DOCK_CHAT_KEY_CHANNEL } from "./dock";

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
  onChatKey: (callback: unknown): void => {
    if (typeof callback !== "function") return;
    ipcRenderer.on(DOCK_CHAT_KEY_CHANNEL, () => callback());
  },
});
