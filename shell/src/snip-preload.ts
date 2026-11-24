// The snip overlay windows' preload script, bundled as its own file (snip-preload.cjs). It runs in
// the page's sandboxed process before the page and gives it three functions and nothing else:
// window.holmSnip.getCapture(), crop(rect) and close(). The main process decides whether to
// answer, and checks everything the page sends.
import { contextBridge, ipcRenderer } from "electron";
import { SNIP_CAPTURE, SNIP_CLOSE, SNIP_CROP } from "./snip";

contextBridge.exposeInMainWorld("holmSnip", {
  getCapture: (): Promise<string | null> => ipcRenderer.invoke(SNIP_CAPTURE),
  crop: async (rect: unknown): Promise<string> => {
    const answer = (await ipcRenderer.invoke(SNIP_CROP, rect)) as { path?: string; error?: string };
    if (typeof answer?.path !== "string") throw new Error(answer?.error ?? "the snip was not saved");
    return answer.path;
  },
  close: (): void => {
    ipcRenderer.send(SNIP_CLOSE);
  },
});
