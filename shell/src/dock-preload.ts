// The dock window's preload script, bundled as its own file (dock-preload.cjs). It runs in the
// page's sandboxed process before the page, and gives the page one function and nothing else:
// window.intuitionDock.setState(state). The main process decides whether to take the call.
import { contextBridge, ipcRenderer } from "electron";
import { DOCK_CHANNEL } from "./dock";

contextBridge.exposeInMainWorld("intuitionDock", {
  setState: (state: unknown): void => {
    ipcRenderer.send(DOCK_CHANNEL, state);
  },
});
