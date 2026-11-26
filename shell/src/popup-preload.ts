// The pop-up window's preload script, bundled as its own file (popup-preload.cjs). It runs in the
// page's sandboxed process before the page and gives it one function and nothing else:
// window.cleatPopup.fit(height), the height its content needs (D0056). The main process takes it only
// from the pop-up's own main frame on the runner's origin, and clamps it to the window's range.
import { contextBridge, ipcRenderer } from "electron";
import { POPUP_FIT } from "./popup";

contextBridge.exposeInMainWorld("cleatPopup", {
  fit: (height: unknown): void => {
    if (typeof height === "number" && Number.isFinite(height)) ipcRenderer.send(POPUP_FIT, height);
  },
});
