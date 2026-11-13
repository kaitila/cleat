// Runs the Windows shell's self-test from WSL: `bun src/shell/selftest-run.ts`.
// This machine only: it needs Windows, so it is skipped in CI and where there is no /mnt/c.
// It installs the shell, starts a stub runner, runs electron.exe --self-test and checks every field it wrote.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dockBounds, type DockState } from "../../shell/src/dock";
import type { Area } from "../../shell/src/geometry";
import type { SelfTestResult } from "../../shell/src/result";
import { HOST, type ClipboardPostRequest } from "../shared/protocol";
import { electron, install } from "./install";
import { desktopLocked, hasWindows, shellPaths, toWindows, toWsl } from "./paths";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PAGE = "<!doctype html><meta charset=utf-8><title>intuition self-test</title><p>self-test</p>";

/**
 * The stub's dock page: clear, and it calls setState as the real page does. In a browser the bridge is
 * absent and the call is skipped. The self-test asks for the other states through the same function.
 */
const DOCK_PAGE = `<!doctype html><meta charset=utf-8><title>intuition self-test dock</title>
<style>html, body { margin: 0; background: transparent; }</style>
<script>window.intuitionDock?.setState("idle");</script>`;

/** The session the dock's link opens in the self-test. The shell's self-test names the same one. */
export const STUB_SESSION = "self-test-session";

/** What the stub runner received from the shell. */
export interface Seen {
  posts: ClipboardPostRequest[];
}

/** Just enough of the runner for the shell: /health, the three pages, and POST /api/clipboard, which it records. */
export function stubRunner() {
  const posts: ClipboardPostRequest[] = [];
  const server = Bun.serve({
    hostname: HOST,
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") return Response.json({ ok: true, version: "self-test" });
      if (req.method === "GET" && (path === "/" || path === "/prompt")) return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (req.method === "GET" && path === "/dock") return new Response(DOCK_PAGE, { headers: { "content-type": "text/html" } });
      if (req.method === "POST" && path === "/api/clipboard") {
        const body = (await req.json()) as ClipboardPostRequest;
        posts.push(body);
        return Response.json({ capturedAt: new Date().toISOString(), ...body });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  return { url: `http://${HOST}:${server.port}`, posts, stop: () => server.stop(true) };
}

function isArea(value: unknown): value is Area {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((k) => typeof o[k] === "number" && Number.isFinite(o[k]));
}

/** What is wrong with a self-test result, given what the stub runner received. Empty when all is well. */
export function problems(r: Partial<SelfTestResult>, seen: Seen, runnerUrl: string, readImage: (windowsPath: string) => Uint8Array | null): string[] {
  const bad: string[] = [...(r.errors ?? []).map((e) => `the shell reported: ${e}`)];
  const { posts } = seen;
  const need = (ok: unknown, what: string) => {
    if (!ok) bad.push(what);
  };
  need(r.hotkeyRegistered, "the global hotkey did not register");
  need(r.trayCreated, "the tray icon was not created");
  need(r.textCaptured, "the text clipboard was not captured");
  need(r.textPosted, "the text capture was not posted");
  need(posts.some((p) => typeof p.text === "string" && p.text.startsWith("intuition self-test ") && p.imagePath === undefined), "the stub runner did not receive the text");
  need(r.imageCaptured, "the image clipboard was not captured");
  need(r.imagePosted, "the image capture was not posted");
  need(r.imagePath && posts.some((p) => p.imagePath === r.imagePath && p.text === undefined), "the stub runner did not receive the image's path");
  need(r.imagePath && /^[A-Za-z]:\\.*\\intuition\\clip-[\d-]+\.png$/.test(r.imagePath), `the image path is not <temp>\\intuition\\clip-<time>.png: ${r.imagePath}`);
  const image = r.imagePath ? readImage(r.imagePath) : null;
  need(image, "the saved image does not exist under /mnt/c");
  need(image && PNG.every((b, i) => image[i] === b), "the saved image does not start with the PNG signature");
  need(r.notificationsSupported, "notifications are not supported");
  need(r.popupCreated, "the pop-up was not created");
  need(r.popupWidth === 560 && r.popupHeight === 380, `the pop-up is ${r.popupWidth}x${r.popupHeight}, not 560x380`);
  need(r.popupUrl === `${runnerUrl}/prompt`, `the pop-up loaded ${r.popupUrl}, not ${runnerUrl}/prompt`);
  need(r.popupVisible, "the pop-up was not shown");
  need(r.popupCentred, "the pop-up was not centred on the display under the cursor");
  need(r.foreignNavigationRefused, "a navigation to another origin was not refused");
  need(r.foreignWindowRefused, "a new window on another origin was not refused");
  need(r.pageClosedPopup, "window.close() from the page did not close the pop-up");
  need(r.noWindowWithoutRunner, "a window opened although no runner answered");
  need(r.clipboardRestored, "the clipboard was not put back");
  // Start on login is read and reported, whichever it is. Nothing here sets it.
  need(r.loginItemRead && typeof r.openAtLogin === "boolean", `start on login could not be read: ${JSON.stringify(r.openAtLogin)}`);

  need(r.dockOffNoWindow, 'a dock window was created although "dock" is false');
  need(r.dockCreated, "the dock window was not created");
  need(r.dockUrl === `${runnerUrl}/dock`, `the dock loaded ${r.dockUrl}, not ${runnerUrl}/dock`);
  need(r.dockVisible, "the dock was not shown");
  need(r.dockBridge === "object:setState:undefined:undefined", `the page sees more or less than intuitionDock.setState: ${r.dockBridge}`);
  // The same pure function the shell uses, run here on the display the shell reported.
  const display = isArea(r.primaryDisplay) && r.primaryDisplay.width > 0 && r.primaryDisplay.height > 0 ? r.primaryDisplay : null;
  need(display, `the primary display's bounds are ${JSON.stringify(r.primaryDisplay)}`);
  const at = (bounds: unknown, state: DockState, when: string) => {
    const want = display ? dockBounds(display, state) : null;
    need(want && isArea(bounds) && bounds.x === want.x && bounds.y === want.y && bounds.width === want.width && bounds.height === want.height,
      `${when}, the dock is at ${JSON.stringify(bounds)}, not the ${state} bounds at the top centre of the primary display, ${JSON.stringify(want)}`);
  };
  at(r.dockIdleBounds, "idle", "at first");
  need(r.dockIdleFocusable === false, "the dock is focusable in idle");
  need(r.dockIdleFocused === false, "the dock took the focus when it was shown");
  at(r.dockOpenBounds, "open", 'after setState("open")');
  need(r.dockOpenFocusable === true, "the dock is not focusable in open");
  need(r.dockOtherValueIgnored, "setState with a value that is not a state changed the dock");
  at(r.dockBackBounds, "idle", 'after setState("idle")');
  need(r.dockBackFocusable === false, "the dock is still focusable back in idle");
  need(r.dockForeignOriginIgnored, "setState from a page on another origin changed the dock");
  need(r.dockOpenedChatUrl === `${runnerUrl}/?session=${STUB_SESSION}`, `the dock's link to a session opened ${r.dockOpenedChatUrl}, not ${runnerUrl}/?session=${STUB_SESSION}`);
  need(r.dockOpenedPromptUrl === `${runnerUrl}/prompt`, `the dock's link to /prompt opened ${r.dockOpenedPromptUrl}, not the pop-up on ${runnerUrl}/prompt`);
  need(r.dockOtherWindowRefused, "another new window from the dock was not refused");
  need(r.dockHiddenWithoutRunner, "the dock was not hidden when the runner stopped answering (or hid at the first missed check)");
  need(r.dockShownAgain, "the dock did not load and show again when the runner answered");
  return bad;
}

/** Returns the exit code. */
export async function selfTestRun(): Promise<number> {
  if (process.env.CI || !hasWindows()) {
    console.log(`skipped: the shell's self-test needs Windows (${process.env.CI ? "CI is set" : "there is no /mnt/c"})`);
    return 0;
  }
  const paths = shellPaths();
  await install(paths);
  const resultFile = join(paths.home, "self-test-result.json");
  rmSync(resultFile, { force: true });
  const runner = stubRunner();
  let result: Partial<SelfTestResult> = {};
  let imageFile: string | null = null;
  try {
    const shell = electron(paths, ["--self-test", toWindows(resultFile), "--runner-url", runner.url]);
    const timer = setTimeout(() => shell.kill(), 60_000);
    await shell.exited;
    clearTimeout(timer);
    if (!existsSync(resultFile)) {
      console.error("FAILED: the shell wrote no result file");
      return 1;
    }
    result = JSON.parse(readFileSync(resultFile, "utf8"));
    const bad = problems(result, runner, runner.url, (windowsPath) => {
      imageFile = toWsl(windowsPath);
      return imageFile.startsWith("/mnt/c/") && existsSync(imageFile) ? readFileSync(imageFile) : null;
    });
    console.log(JSON.stringify(result, null, 2));
    if (bad.length) {
      for (const b of bad) console.error(`FAILED: ${b}`);
      if (bad.some((b) => b.includes("clipboard")) && desktopLocked()) {
        console.error("note: Windows is showing its lock screen (LogonUI.exe is running). Nothing can write or read the clipboard behind it: unlock the desktop and run this again.");
      }
      return 1;
    }
    console.log(`start on login is ${result.openAtLogin ? "on" : "off"} on this machine (read, not changed)`);
    console.log("the shell's self-test passed");
    return 0;
  } finally {
    await runner.stop();
    rmSync(resultFile, { force: true });
    if (imageFile) rmSync(imageFile, { force: true });
  }
}

if (import.meta.main) process.exit(await selfTestRun());
