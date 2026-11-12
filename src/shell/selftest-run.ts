// Runs the Windows shell's self-test from WSL: `bun src/shell/selftest-run.ts`.
// This machine only: it needs Windows, so it is skipped in CI and where there is no /mnt/c.
// It installs the shell, starts a stub runner, runs electron.exe --self-test and checks every field it wrote.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SelfTestResult } from "../../shell/src/result";
import { HOST, type ClipboardPostRequest } from "../shared/protocol";
import { electron, install } from "./install";
import { hasWindows, shellPaths, toWindows, toWsl } from "./paths";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PAGE = "<!doctype html><meta charset=utf-8><title>intuition self-test</title><p>self-test</p>";

/** Just enough of the runner for the shell: /health, the two pages, and POST /api/clipboard, which it records. */
export function stubRunner() {
  const posts: ClipboardPostRequest[] = [];
  const server = Bun.serve({
    hostname: HOST,
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") return Response.json({ ok: true, version: "self-test" });
      if (req.method === "GET" && (path === "/" || path === "/prompt")) return new Response(PAGE, { headers: { "content-type": "text/html" } });
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

/** What is wrong with a self-test result, given what the stub runner received. Empty when all is well. */
export function problems(r: Partial<SelfTestResult>, posts: ClipboardPostRequest[], runnerUrl: string, readImage: (windowsPath: string) => Uint8Array | null): string[] {
  const bad: string[] = [...(r.errors ?? []).map((e) => `the shell reported: ${e}`)];
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
    const bad = problems(result, runner.posts, runner.url, (windowsPath) => {
      imageFile = toWsl(windowsPath);
      return imageFile.startsWith("/mnt/c/") && existsSync(imageFile) ? readFileSync(imageFile) : null;
    });
    console.log(JSON.stringify(result, null, 2));
    if (bad.length) {
      for (const b of bad) console.error(`FAILED: ${b}`);
      return 1;
    }
    console.log("the shell's self-test passed");
    return 0;
  } finally {
    await runner.stop();
    rmSync(resultFile, { force: true });
    if (imageFile) rmSync(imageFile, { force: true });
  }
}

if (import.meta.main) process.exit(await selfTestRun());
