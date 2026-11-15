// Drives the pop-up prompt in headless Chromium at the size the shell opens it (560x380), against a
// runner with the fake agent. Run it on this machine: `bun test/web/prompt-ui.ts`.
// It uses the playwright installed globally for bun, and prints "skipped" and exits 0 without one.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { EventsResponse, SessionsResponse, WorkspacesResponse } from "../../src/shared/protocol";
import { loadConfig } from "../../src/runner/config";
import { startServer } from "../../src/runner/server";
import { frameStrip, pauseAll, type FramePage } from "./motion-frames";

// The little of playwright's API this script uses (the package isn't a dependency, so no types).
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  click(selector: string): Promise<void>;
  waitForFunction(fn: () => unknown, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  waitForEvent(event: "close", options?: { timeout?: number }): Promise<unknown>;
  screenshot(options: { path?: string; clip?: { x: number; y: number; width: number; height: number }; fullPage?: boolean }): Promise<Uint8Array>;
  setContent(html: string): Promise<unknown>;
  isClosed(): boolean;
  close(): Promise<void>;
  addInitScript(fn: () => void): Promise<void>;
  route(url: string, handler: (route: { abort(): Promise<void> }) => unknown): Promise<void>;
  unroute(url: string): Promise<void>;
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
}
interface Browser {
  newContext(options: { viewport: { width: number; height: number }; colorScheme: "light" | "dark"; deviceScaleFactor?: number; reducedMotion?: "reduce" | "no-preference" }): Promise<{
    newPage(): Promise<Page>;
    on(event: "request", listener: (request: { url(): string }) => void): void;
  }>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(options: { headless: boolean; args?: string[] }): Promise<Browser> };
}

function skip(why: string): never {
  console.log(`skipped: ${why}`);
  process.exit(0);
}

if (process.env.CI) skip("CI has no browser for this check");
const playwrightPath = join(homedir(), ".bun", "install", "global", "node_modules", "playwright");
let browser: Browser;
/** A second Chromium at two device pixels per CSS pixel. The flag is needed: an emulated deviceScaleFactor alone still snaps borders to whole CSS pixels. */
let dense: Browser;
try {
  const mod = (await import(playwrightPath)) as Playwright & { default?: Playwright };
  const chromium = mod.chromium ?? mod.default!.chromium;
  browser = await chromium.launch({ headless: true });
  dense = await chromium.launch({ headless: true, args: ["--force-device-scale-factor=2"] });
} catch (e) {
  skip(`no browser is available (${playwrightPath}): ${(e as Error).message.split("\n")[0]}`);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
}

// A throwaway config: one workspace whose folder is missing (first, so the default has to skip it)
// and two that exist, so "the chosen one" and "the last used one" differ from "the first".
const dir = mkdtempSync(join(tmpdir(), "intuition-prompt-ui-"));
for (const name of ["alpha", "beta"]) mkdirSync(join(dir, name));
const env = {
  INTUITION_CONFIG: join(dir, "config.json"),
  INTUITION_DATA_DIR: join(dir, "data"),
  INTUITION_PORT: "0",
  INTUITION_FAKE_AGENT: "1",
};
writeFileSync(
  env.INTUITION_CONFIG,
  JSON.stringify({ workspaces: ["gone", "alpha", "beta"].map((name) => ({ name, path: join(dir, name) })) }),
);
const runner = startServer(loadConfig(env));
const shots = join(dir, "screenshots");
mkdirSync(shots);

/** An 8x8 grey PNG in a new folder under a Windows user's temp folder, by its WSL path. Null where there is none. */
function windowsTempPng(): string | null {
  try {
    const users = "/mnt/c/Users";
    const temp = readdirSync(users).map((u) => join(users, u, "AppData", "Local", "Temp")).find((t) => existsSync(t));
    if (!temp) return null;
    mkdirSync(join(temp, "intuition"), { recursive: true });
    const folder = mkdtempSync(join(temp, "intuition", "prompt-ui-"));
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
      const out = Buffer.alloc(body.length + 8);
      out.writeUInt32BE(data.length, 0);
      body.copy(out, 4);
      out.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
      return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(8, 0);
    header.writeUInt32BE(8, 4);
    header.set([8, 0, 0, 0, 0], 8); // 8 bits, greyscale
    const rows = Buffer.alloc(8 * 9, 128);
    for (let y = 0; y < 8; y++) rows[y * 9] = 0; // each row's filter byte
    const file = join(folder, "clip.png");
    writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
    return file;
  } catch {
    return null;
  }
}

const SIZE = { width: 560, height: 380 };
const state = () => ({
  focus: document.activeElement?.id ?? "",
  workspaces: [...document.querySelectorAll<HTMLInputElement>("#workspaces input")].map((r) => ({
    name: r.value,
    disabled: r.disabled,
    checked: r.checked,
  })),
  task: document.querySelector<HTMLTextAreaElement>("#task")!.value,
  status: document.querySelector("#status")!.textContent ?? "",
  link: document.querySelector<HTMLAnchorElement>("#status a")?.getAttribute("href") ?? null,
  clipboardHidden: document.querySelector<HTMLElement>("#clipboard")!.hidden && document.querySelector("#clipboard")!.childNodes.length === 0,
  // No scrollbars: nothing is wider or taller than the window, and no scrollbar takes room from it.
  overflow: [document.documentElement, document.body, document.querySelector("#task")!].some(
    (el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
  ),
  gutter: window.innerWidth - document.documentElement.clientWidth + (window.innerHeight - document.documentElement.clientHeight),
});
const ready = () => document.querySelectorAll("#workspaces input").length > 0;
const sessions = async () => ((await (await fetch(`${runner.url}/api/sessions`)).json()) as SessionsResponse).sessions;
const checkedOf = (s: ReturnType<typeof state>) => s.workspaces.find((w) => w.checked)?.name ?? null;

/** Every URL the pages asked for: none may be on another host (the fonts are the runner's own files). */
const requested: string[] = [];
async function newPage(colorScheme: "light" | "dark", from = browser, reducedMotion: "reduce" | "no-preference" = "no-preference"): Promise<Page> {
  const context = await from.newContext({ viewport: SIZE, colorScheme, reducedMotion, ...(from === dense ? { deviceScaleFactor: 2 } : {}) });
  context.on("request", (r) => requested.push(r.url()));
  return context.newPage();
}
async function open(colorScheme: "light" | "dark", from = browser, reducedMotion: "reduce" | "no-preference" = "no-preference"): Promise<Page> {
  const page = await newPage(colorScheme, from, reducedMotion);
  await page.goto(`${runner.url}/prompt`);
  await page.waitForFunction(ready);
  return page;
}
/** How the page moves: the window's own animation, the workspace mark and where it is against the chosen chip. */
const motion = () => {
  const prompt = getComputedStyle(document.querySelector(".prompt")!);
  const mark = document.querySelector<HTMLElement>(".workspace-mark")!;
  const chip = document.querySelector("#workspaces input:checked + span")!.getBoundingClientRect();
  const at = mark.getBoundingClientRect();
  const clip = document.querySelector<HTMLElement>("#clipboard")!;
  return {
    page: prompt.animationName,
    pageEasing: prompt.animationTimingFunction,
    markTransition: getComputedStyle(mark).transitionProperty + " " + getComputedStyle(mark).transitionTimingFunction,
    markOnChip: Math.abs(at.x - chip.x) <= 1 && Math.abs(at.y - chip.y) <= 1 && Math.abs(at.width - chip.width) <= 1,
    markBehind: getComputedStyle(mark).backgroundColor !== "rgba(0, 0, 0, 0)" && getComputedStyle(document.querySelector("#workspaces input:checked + span")!).backgroundColor === "rgba(0, 0, 0, 0)",
    clip: clip.getAnimations().map((a) => (a as CSSAnimation).animationName),
  };
};
const blank = async () => (await (await browser.newContext({ viewport: { width: 1200, height: 400 }, colorScheme: "light" })).newPage()) as unknown as FramePage;
const TIMES = [0, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350];

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const path = join(shots, `${name}.png`);
  await page.screenshot({ path });
  console.log(`screenshot: ${path}`);
}

try {
  // First visit, light.
  const page = await open("light");
  let s = await page.evaluate(state);
  check("the task box has focus on load", s.focus === "task", s.focus);
  check("the missing workspace is disabled", s.workspaces.find((w) => w.name === "gone")?.disabled === true);
  check("the workspaces that exist can be picked", s.workspaces.filter((w) => !w.disabled).map((w) => w.name).join() === "alpha,beta");
  check("with none used yet, the first that exists is selected", checkedOf(s) === "alpha", String(checkedOf(s)));
  check("the clipboard element is there, empty and hidden", s.clipboardHidden);
  check("no scrollbars at 560x380", !s.overflow && s.gutter === 0, JSON.stringify({ overflow: s.overflow, gutter: s.gutter }));
  await shot(page, "light-empty");
  const fonts = await page.evaluate(() => document.fonts.check('13px "Geist Variable"'));
  check("the interface font is loaded, from the runner's /assets/fonts", fonts && requested.some((u) => new URL(u).pathname === "/assets/fonts/geist-latin.woff2"), requested.join(" "));
  const hairline = () => getComputedStyle(document.querySelector("#workspaces")!).borderBottomWidth;
  check("a hairline is 1px where a CSS pixel is one device pixel", (await page.evaluate(hairline)) === "1px", await page.evaluate(hairline));

  await page.keyboard.press("Enter");
  await Bun.sleep(200);
  check("Enter on an empty task does nothing", (await sessions()).length === 0 && (await page.evaluate(state)).status === "");

  await page.keyboard.press("Alt+1");
  check("Alt+1 can't pick the missing workspace", checkedOf(await page.evaluate(state)) === "alpha");
  let m = await page.evaluate(motion);
  check("the window's contents spring in on the gentle curve, with a fade", m.page === "page-in, fade-in" && m.pageEasing.startsWith("linear("), JSON.stringify(m));
  check("the chosen workspace's background is one mark behind the chips, on the chosen chip", m.markOnChip && m.markBehind, JSON.stringify(m));
  await page.keyboard.press("Alt+3");
  await pauseAll(page as unknown as FramePage);
  m = await page.evaluate(motion);
  check("the mark moves on a transform only, on the bouncy spring", /^transform linear\(/.test(m.markTransition), m.markTransition);
  const markFrames = await frameStrip(page as unknown as FramePage, await blank(), { selector: ".workspace-mark", clip: { x: 0, y: 0, width: 280, height: 56 }, times: TIMES, path: join(shots, "strip-workspace-moving.png"), title: "The workspace mark sliding from alpha to beta (--ease-bouncy), at 2x", zoom: 2 });
  console.log(`screenshot: ${join(shots, "strip-workspace-moving.png")}`);
  check("Alt+3 slides the mark (a transition was running)", markFrames === 1, String(markFrames));
  s = await page.evaluate(state);
  check("Alt+3 picks the third workspace and typing stays in the task box", checkedOf(s) === "beta" && s.focus === "task");
  check("and the mark ends on that chip", (await page.evaluate(motion)).markOnChip);

  await page.keyboard.type("Tidy the notes");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("and list what changed");
  s = await page.evaluate(state);
  check("Shift+Enter is a new line", s.task === "Tidy the notes\nand list what changed" && (await sessions()).length === 0, JSON.stringify(s.task));
  await shot(page, "light-typed");

  // An error: the runner can't be reached. One quiet line, and the task is kept.
  await page.route("**/api/sessions", (route) => route.abort());
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#status")!.dataset.kind === "error");
  s = await page.evaluate(state);
  check("an unreachable runner is one line, and the task is kept", s.status === "the runner is not reachable" && s.task.startsWith("Tidy the notes"), s.status);
  check("no scrollbars with the error line", !s.overflow && s.gutter === 0);
  await shot(page, "light-error");
  await page.unroute("**/api/sessions");

  // Enter starts the session. The window then closes itself, or says Started where it can't.
  const closed = page.waitForEvent("close", { timeout: 5000 }).then(() => true, () => false);
  await page.keyboard.press("Enter");
  await Promise.race([closed, page.waitForFunction(() => document.querySelector("#status a") !== null, undefined, { timeout: 5000 }).catch(() => {})]);
  const list = await sessions();
  check("Enter creates one session", list.length === 1, `${list.length} sessions`);
  check("the session is in the chosen workspace", list[0]?.workspace === "beta" && list[0]?.cwd === join(dir, "beta"), JSON.stringify(list[0]));
  check("the session's title is the task's first line", list[0]?.title === "Tidy the notes", list[0]?.title);
  if (page.isClosed()) {
    check("the window closed itself after the 201", true);
  } else {
    s = await page.evaluate(state);
    check("where the window can't close, it says Started with a link to the session", s.status.startsWith("Started") && s.link === `/?session=${list[0]?.id}`, JSON.stringify(s));
    check("the task box is cleared after the start", s.task === "");
    await shot(page, "light-started");
    await page.close();
  }

  // Second visit, dark: the workspace just used is preselected.
  const again = await open("dark");
  s = await again.evaluate(state);
  const last = ((await (await fetch(`${runner.url}/api/workspaces`)).json()) as WorkspacesResponse).lastUsed;
  check("a second visit preselects the workspace last used", checkedOf(s) === "beta" && last === "beta", `${checkedOf(s)} / ${last}`);
  check("the task box has focus on the second visit", s.focus === "task");
  check("no scrollbars in dark", !s.overflow && s.gutter === 0);
  await shot(again, "dark-empty");
  await again.keyboard.type("A longer task, to see the box with text in the dark theme.");
  await shot(again, "dark-typed");

  // Tab reaches the workspaces.
  await again.keyboard.press("Shift+Tab");
  const focused = await again.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value ?? "");
  check("Tab reaches the workspace row", focused === "beta", focused);
  await shot(again, "dark-workspace-focus");

  // The clipboard attachment. The shell posts its capture while the window opens: here, just before.
  const post = (body: unknown) =>
    fetch(`${runner.url}/api/clipboard`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const clipState = () => {
    const el = document.querySelector<HTMLElement>("#clipboard")!;
    return {
      hidden: el.hidden,
      empty: el.childNodes.length === 0,
      text: el.querySelector(".clip-text")?.textContent ?? null,
      image: el.querySelector("img")?.naturalWidth ?? null,
      remove: el.querySelector("button") !== null,
    };
  };
  const attached = () => !document.querySelector<HTMLElement>("#clipboard")!.hidden;
  const userTexts = async (id: string) =>
    ((await (await fetch(`${runner.url}/api/sessions/${id}/events`)).json()) as EventsResponse).events.flatMap((e) => (e.kind === "user" ? [e] : []));
  /** Types a task, presses Enter and returns the session it started. */
  async function send(p: Page, task: string) {
    const before = (await sessions()).length;
    await p.keyboard.type(task);
    const gone = p.waitForEvent("close", { timeout: 5000 }).then(() => true, () => false);
    await p.keyboard.press("Enter");
    await Promise.race([gone, p.waitForFunction(() => document.querySelector("#status a") !== null, undefined, { timeout: 5000 }).catch(() => {})]);
    const list = await sessions();
    check(`"${task}" starts one session`, list.length === before + 1, `${list.length - before} started`);
    if (!p.isClosed()) await p.close();
    return list.find((x) => x.title === task);
  }
  const COPIED = "const answer = 42;\nconsole.log(answer);\n// a third line";

  // A fresh text capture: shown, and sent after the task.
  await post({ text: COPIED });
  const withText = await open("light");
  await withText.waitForFunction(attached, undefined, { timeout: 3000 }).catch(() => {});
  await pauseAll(withText as unknown as FramePage);
  const arriving = (await withText.evaluate(motion)).clip;
  check("the attachment springs in as it arrives", arriving.includes("pop-in") && arriving.includes("fade-in"), JSON.stringify(arriving));
  const clipFrames = await frameStrip(withText as unknown as FramePage, await blank(), { selector: "#clipboard", clip: { x: 0, y: 250, width: 560, height: 90 }, times: TIMES, path: join(shots, "strip-clipboard-arriving.png"), title: "The clipboard attachment arriving (pop-in on --ease-bouncy)" });
  console.log(`screenshot: ${join(shots, "strip-clipboard-arriving.png")}`);
  check("the strip stepped its spring", clipFrames >= 1, String(clipFrames));
  let c = await withText.evaluate(clipState);
  check("a fresh text capture is shown with its first two lines", !c.hidden && c.text === "const answer = 42;\nconsole.log(answer);", JSON.stringify(c));
  check("the attachment has a remove control", c.remove);
  s = await withText.evaluate(state);
  check("the task box keeps the focus with an attachment", s.focus === "task", s.focus);
  check("no scrollbars with a text attachment", !s.overflow && s.gutter === 0, JSON.stringify({ overflow: s.overflow, gutter: s.gutter }));
  await shot(withText, "light-clipboard-text");
  check(
    "the code font is loaded for the clipboard text, from the runner's /assets/fonts",
    (await withText.evaluate(() => document.fonts.check('12px "Geist Mono Variable"'))) && requested.some((u) => new URL(u).pathname === "/assets/fonts/geist-mono-latin.woff2"),
  );
  const sent = await send(withText, "Explain this code");
  const sentUser = sent ? await userTexts(sent.id) : [];
  check("the session's user event has the task, then the clipboard text under 'Clipboard:'", sentUser[0]?.text === `Explain this code\n\nClipboard:\n${COPIED}`, JSON.stringify(sentUser));

  // Removed with Alt+Backspace: not sent, and the later polls don't bring it back.
  await post({ text: COPIED });
  const removedByKey = await open("dark");
  await removedByKey.waitForFunction(attached, undefined, { timeout: 3000 }).catch(() => {});
  check("the capture is attached again on a new visit", !(await removedByKey.evaluate(clipState)).hidden);
  await shot(removedByKey, "dark-clipboard-text");
  await removedByKey.keyboard.press("Alt+Backspace");
  c = await removedByKey.evaluate(clipState);
  check("Alt+Backspace removes the attachment", c.hidden && c.empty, JSON.stringify(c));
  await Bun.sleep(2300);
  c = await removedByKey.evaluate(clipState);
  s = await removedByKey.evaluate(state);
  check("a removed attachment stays removed after the last poll", c.hidden && c.empty && s.focus === "task", JSON.stringify(c));
  const unsent = await send(removedByKey, "Without the clipboard");
  const unsentUser = unsent ? await userTexts(unsent.id) : [];
  check("a removed attachment is not sent", unsentUser[0]?.text === "Without the clipboard" && unsentUser[0]?.imagePath === undefined, JSON.stringify(unsentUser));

  // Removed with its control.
  await post({ text: COPIED });
  const removedByClick = await open("light");
  await removedByClick.waitForFunction(attached, undefined, { timeout: 3000 }).catch(() => {});
  await removedByClick.click("#clipboard button");
  c = await removedByClick.evaluate(clipState);
  s = await removedByClick.evaluate(state);
  check("the remove control removes the attachment and typing goes on in the task box", c.hidden && c.empty && s.focus === "task", JSON.stringify(c));
  const clicked = await send(removedByClick, "Removed by a click");
  check("removed by its control, it is not sent", (clicked ? await userTexts(clicked.id) : [])[0]?.text === "Removed by a click");

  // A capture that arrives after the page loaded is picked up by a later poll.
  await post({});
  const late = await open("light");
  check("an empty capture attaches nothing", (await late.evaluate(clipState)).hidden);
  await post({ text: "arrived late" });
  await late.waitForFunction(attached, undefined, { timeout: 3000 }).catch(() => {});
  c = await late.evaluate(clipState);
  check("a capture posted after the page loaded is attached by a later poll", !c.hidden && c.text === "arrived late", JSON.stringify(c));
  await late.close();

  // An older capture is not attached. The page's clock is moved on instead of waiting 31 seconds.
  await post({ text: "copied a while ago" });
  const old = await newPage("light");
  await old.addInitScript(() => {
    const real = Date.now.bind(Date);
    Date.now = () => real() + 31_000;
  });
  await old.goto(`${runner.url}/prompt`);
  await old.waitForFunction(ready);
  await Bun.sleep(2300);
  c = await old.evaluate(clipState);
  check("a capture older than 30 seconds is not attached", c.hidden && c.empty, JSON.stringify(c));
  const stale = await send(old, "After an old capture");
  check("an older capture is not sent", (stale ? await userTexts(stale.id) : [])[0]?.text === "After an old capture");

  // An image capture, where this machine has a Windows temp folder to put one in.
  const imageFile = windowsTempPng();
  if (imageFile === null) {
    console.log("skipped: the image attachment (no writable Windows temp folder under /mnt/c)");
  } else {
    try {
      const posted = await post({ imagePath: imageFile });
      check("the runner takes the image capture", posted.status === 200, String(posted.status));
      const withImage = await open("dark");
      await withImage.waitForFunction(() => (document.querySelector<HTMLImageElement>("#clipboard img")?.naturalWidth ?? 0) > 0, undefined, { timeout: 3000 }).catch(() => {});
      c = await withImage.evaluate(clipState);
      s = await withImage.evaluate(state);
      check("a fresh image capture is shown as a thumbnail", !c.hidden && c.image === 8 && c.remove, JSON.stringify(c));
      check("no scrollbars with an image attachment", !s.overflow && s.gutter === 0);
      await shot(withImage, "dark-clipboard-image");
      const imaged = await send(withImage, "What is in the image");
      const imagedUser = imaged ? await userTexts(imaged.id) : [];
      check("an attached image goes as imagePath, apart from the text", imagedUser[0]?.text === "What is in the image" && imagedUser[0]?.imagePath === imageFile, JSON.stringify(imagedUser));
    } finally {
      rmSync(join(imageFile, ".."), { recursive: true, force: true });
    }
  }

  // Two device pixels per CSS pixel, light and dark: hairlines are half a CSS pixel, and still nothing scrolls.
  await post({ text: COPIED });
  for (const scheme of ["light", "dark"] as const) {
    const twice = await open(scheme, dense);
    await twice.waitForFunction(attached, undefined, { timeout: 3000 }).catch(() => {});
    await twice.keyboard.type("Rename the config loader and update its tests");
    s = await twice.evaluate(state);
    const width = await twice.evaluate(() => `${devicePixelRatio} ${getComputedStyle(document.querySelector("#workspaces")!).borderBottomWidth}`);
    check(`at 2x (${scheme}) a hairline is 0.5px and nothing scrolls`, width === "2 0.5px" && !s.overflow && s.gutter === 0, `${width} ${JSON.stringify({ overflow: s.overflow, gutter: s.gutter })}`);
    await shot(twice, `${scheme}-2x`);
    await twice.close();
  }

  const elsewhere = requested.filter((u) => !/^(?:data|blob|about):/.test(u) && new URL(u).hostname !== "127.0.0.1");
  check("no request left 127.0.0.1", requested.length > 0 && elsewhere.length === 0, elsewhere.join(" "));
  // Reduced motion: the window fades in, and nothing grows, slides or bounces.
  const still = await open("light", browser, "reduce");
  m = await still.evaluate(motion);
  check("with prefers-reduced-motion the window only fades in, linear, and the mark doesn't slide", m.page === "fade-in" && m.pageEasing === "linear" && !/[1-9]/.test(await still.evaluate(() => getComputedStyle(document.querySelector(".workspace-mark")!).transitionDuration)), JSON.stringify(m));
  await still.close();
} catch (e) {
  check("the run finished", false, (e as Error).stack ?? String(e));
} finally {
  await browser.close();
  await dense.close();
  await runner.stop();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
