// Drives the dock in headless Chromium: `bun test/web/dock-ui.ts`.
// This machine only: it needs the playwright that is installed globally for bun and its browser,
// and prints a "skipped" line and exits 0 where there is none (and in CI).
// The runner is real, on a free port with temp folders, with the fake agent (INTUITION_FAKE_AGENT=1),
// slowed down so a running session can be seen. The shell is a stand-in: a viewport of the window's
// one size that never changes, and a window.intuitionDock that records each setState call
// (docs/protocol.md, "Dock").
// It measures the island as it is drawn (its clip, found by hit-testing), times the frames of an
// open and a close, and saves screenshots of every state and a strip of frames through the open and
// the close animation, for a person or an agent to look at.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDriver } from "../../src/runner/agent-fake";
import { Store } from "../../src/runner/store";
import { DOCK_SIZES, DOCK_WINDOW, type DockState, dockSizes } from "../../shell/src/dock";
import { testRunner } from "../runner/helpers";
import { RECENT_EVENTS } from "../../src/web/dock-state.js";
import { MARKDOWN_EXPECTED, markdownProblems, seedMarkdown } from "./markdown-sample";
import { assistantEntry, MemoryTranscripts, userEntry } from "./chat-transcripts";

const PLAYWRIGHT = join(homedir(), ".bun", "install", "global", "node_modules", "playwright");
/** Markup that would run if any of it reached the page as HTML. */
const HOSTILE = '<img src=x onerror="window.__xss=1">';
/** The fake agent waits this long between its steps: a turn takes a second or two. */
const STEP_MS = 250;
/** A frame of a 60 Hz screen is 16.7 ms: a worst frame under two of them dropped none in a row. */
const FRAME_LIMIT_MS = 34;
/** What stands in for the desktop behind the clear window, in the screenshots only. */
const DESKTOP = { light: "#dfe3ea", dark: "#1d1f24" };

function skip(why: string): never {
  console.log(`dock-ui: skipped (${why})`);
  process.exit(0);
}

// Playwright isn't a dependency of this project, so it has no types here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function launch(): Promise<Any> {
  if (process.env.CI) skip("CI is set: no browser there");
  if (!existsSync(PLAYWRIGHT)) skip(`no playwright at ${PLAYWRIGHT}`);
  try {
    const playwright: Any = await import(PLAYWRIGHT);
    return await (playwright.chromium ?? playwright.default.chromium).launch();
  } catch (e) {
    skip(`no browser available: ${String((e as Error).message ?? e).split("\n")[0]}`);
  }
}

const passed: string[] = [];
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`failed: ${what}`);
  passed.push(what);
  console.log(`  ok  ${what}`);
}

/** One setState call, as the stand-in saw it. */
interface Call { state: DockState; at: number }
/** The island as drawn: its clip, measured by hit-testing, relative to the island's box (the window). */
interface Shape { left: number; top: number; width: number; height: number }
/**
 * One frame of a recording: how long after the frame before, how tall and wide the island was drawn,
 * and whether its top edge was on the screen's edge (its first row of pixels drawn), or nothing was drawn.
 */
interface Frame { ms: number; height: number; width: number; hung: boolean }

/** An older session full of text that must stay text. */
function seed(dataDir: string): string {
  const store = new Store(dataDir);
  const id = crypto.randomUUID();
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  store.create({ id, claudeSessionId: null, workspace: "work", cwd: "/nowhere", title: HOSTILE, status: "idle", createdAt: at, updatedAt: at, lastSeq: 0 });
  store.append(id, { kind: "user", text: `${HOSTILE}\nsecond line` });
  store.append(id, { kind: "tool_use", toolUseId: "t1", name: "Read", input: { file_path: `/tmp/${HOSTILE}.txt` } });
  store.append(id, { kind: "tool_result", toolUseId: "t1", content: HOSTILE, isError: true });
  store.append(id, { kind: "approval_request", approvalId: "a1", toolUseId: "t2", toolName: HOSTILE, input: { command: `echo ${HOSTILE}` }, reason: `because ${HOSTILE}` });
  store.append(id, { kind: "approval_resolved", approvalId: "a1", decision: "deny" });
  store.append(id, { kind: "assistant_text", text: `Markup stays text: ${HOSTILE}\n\nRun \`bun test\`:\n\n\`\`\`ts\nconst html = '${HOSTILE}';\n\`\`\`` });
  store.append(id, { kind: "result", ok: true, durationMs: 4200, costUsd: 0.031 });
  // Appending set the time to now: put it back three hours, so the sessions started below are newer.
  store.get(id)!.updatedAt = at;
  store.create(store.get(id)!);
  markdownId = seedMarkdown(store);
  // A title and an answer wider than the panel, in another workspace: four hours old, last in the list.
  const urlAt = new Date(Date.now() - 4 * 3_600_000).toISOString();
  const urlId = crypto.randomUUID();
  store.create({ id: urlId, claudeSessionId: null, workspace: "gone", cwd: "/nowhere", title: LONG_TITLE, status: "idle", createdAt: urlAt, updatedAt: urlAt, lastSeq: 0 });
  store.append(urlId, { kind: "user", text: `look at ${LONG_URL}` });
  store.append(urlId, { kind: "tool_use", toolUseId: "u1", name: "WebFetch", input: { url: LONG_URL } });
  store.append(urlId, { kind: "assistant_text", text: `It is ${LONG_URL}, and ${"a".repeat(160)} is one word.\n\n\`\`\`\n${LONG_URL}\n\`\`\`` });
  store.append(urlId, { kind: "result", ok: true, durationMs: 1000 });
  store.get(urlId)!.updatedAt = urlAt;
  store.create(store.get(urlId)!);
  return id;
}
let markdownId = "";
/** A URL longer than the panel is wide, and a title with it. */
const LONG_URL = `https://example.com/${"very-long-path-segment/".repeat(12)}index.html?query=${"x".repeat(60)}`;
const LONG_TITLE = `Read ${LONG_URL}`;

const browser = await launch();
const dir = mkdtempSync(join(tmpdir(), "intuition-dock-ui-"));
const shots = mkdtempSync(join(tmpdir(), "intuition-dock-shots-"));
const hostileId = seed(join(dir, "data"));
const runner = testRunner({ dir, driver: fakeDriver(STEP_MS) });
let failed = false;
/** Every URL the pages asked for: none may be on another host. */
const requested: string[] = [];
const pageErrors: string[] = [];

/** What the page gets before its own scripts: the stand-in bridge, and the test's instruments. */
function instruments(bridge: boolean): void {
  const w = window as Any;
  w.__calls = [];
  // What the shell's preload gives the page: setState and nothing else. The window stays as it is.
  // And onChat, through which the shell grows the island into the chat (D0042): kept, for the test to call as the shell would.
  if (bridge) w.intuitionDock = { setState: (state: string) => void w.__calls.push({ state, at: Date.now() }), onChat: (callback: (id: string | null) => void) => void (w.__onChat = callback) };

  /** The island as drawn. Its box never changes, so its clip is found by asking what is under a point. */
  w.__shape = () => {
    const island = document.getElementById("island")!;
    const box = island.getBoundingClientRect();
    const middle = box.left + box.width / 2;
    const y0 = box.top + 1;
    const on = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y);
      return el !== null && island.contains(el);
    };
    /** The first value past `from`, towards `to`, that is off the island, to a quarter pixel. */
    const edge = (test: (v: number) => boolean, from: number, to: number) => {
      let [a, b] = [from, to];
      while (Math.abs(b - a) > 0.25) {
        const mid = (a + b) / 2;
        if (test(mid)) a = mid;
        else b = mid;
      }
      return Math.round(b * 2) / 2;
    };
    if (!on(middle, y0)) return { left: box.width / 2, top: 0, width: 0, height: 0 };
    const bottom = edge((y) => on(middle, y), y0, box.bottom + 1);
    const right = edge((x) => on(x, y0), middle, box.right + 1);
    const left = edge((x) => on(x, y0), middle, box.left - 1);
    return { left: left - box.left, top: 0, width: right - left, height: bottom - box.top };
  };

  /** Records every frame from now until __stop(): its length, and the island's size in it. */
  w.__record = () => {
    const frames: { ms: number; height: number; width: number; hung: boolean }[] = [];
    const island = document.getElementById("island")!;
    let last = 0;
    let on = true;
    const tick = (now: number) => {
      if (!on) return;
      if (last) {
        const shape = w.__shape();
        // The top edge: the island's first row of pixels, in its middle, is the island.
        const box = island.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + 0.25);
        frames.push({ ms: now - last, height: shape.height, width: shape.width, hung: shape.height === 0 || (top !== null && island.contains(top)) });
      }
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__stop = () => {
      on = false;
      return frames;
    };
  };

  /** Everything that moves for a change of state: the clip's transitions and the content's fades, not the running dot's pulse. */
  w.__moving = () => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);

  /** Holds every animation of a change of state at one moment of it (ms), until __release(). */
  w.__hold = (ms: number) => {
    w.__held = ms;
    if (w.__holding) return;
    w.__holding = true;
    const pin = () => {
      if (!w.__holding) return;
      for (const a of w.__moving()) {
        a.pause();
        a.currentTime = w.__held;
      }
      requestAnimationFrame(pin);
    };
    pin();
  };
  w.__release = () => {
    w.__holding = false;
    for (const a of w.__moving()) a.play();
  };
}

interface Options { bridge?: boolean; scale?: number; reducedMotion?: "reduce" | "no-preference"; notch?: { width: number; height: number } | null }

/** A dock page in a window of the shell's one size, with the stand-in for the bridge. */
async function dock(colorScheme: "light" | "dark", { bridge = true, scale = 2, reducedMotion = "no-preference", notch = null }: Options = {}) {
  /** The most the island covers in each state: out of the notch when the page is given one. */
  const sizes = dockSizes(notch);
  const viewport = bridge ? { ...DOCK_WINDOW } : { width: 1000, height: 700 };
  const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: scale, reducedMotion });
  context.on("request", (r: Any) => requested.push(r.url()));
  const page = await context.newPage();
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  page.on("console", (m: Any) => {
    if (m.type() !== "error") return;
    // theme.js asks GET /api/settings, which the runner has once T-0030 lands; until then a 404
    // there is expected, and theme.js keeps the cached theme. Only that one URL is excused.
    const at = m.location?.()?.url ?? "";
    if (/404/.test(m.text()) && at && new URL(at).pathname === "/api/settings") return;
    pageErrors.push(m.text());
  });
  await page.addInitScript(instruments, bridge);
  const calls = () => page.evaluate(() => (window as Any).__calls) as Promise<Call[]>;
  const lastCall = async () => (await calls()).at(-1)!;
  const text = (selector: string) => page.locator(selector).allTextContents() as Promise<string[]>;
  const shape = () => page.evaluate(() => (window as Any).__shape()) as Promise<Shape>;
  /** Waits until the shell has been told `state` and nothing moves any more. */
  const settle = async (state: DockState) => {
    if (bridge) await page.waitForFunction((s: string) => (window as Any).__calls.at(-1)?.state === s, state);
    await page.waitForFunction((s: string) => document.getElementById("island")!.dataset.state === s && (window as Any).__moving().length === 0, state);
    // The panel may still be growing with its content: two frames in a row of the same shape.
    await page.waitForFunction(() => {
      const w = window as Any;
      const now = JSON.stringify(w.__shape());
      const same = w.__lastShape === now && w.__moving().length === 0;
      w.__lastShape = now;
      return same;
    }, undefined, { polling: 60 });
  };
  /** What is wrong with the island as drawn in a state. Returns the reasons, none when all is well. */
  const wrong = (state: DockState) =>
    page.evaluate(
      ([most, rect, win, view, exact]: [{ width: number; height: number }, { x: number; y: number }, { width: number; height: number } | null, string, boolean]) => {
        const why: string[] = [];
        const root = document.documentElement;
        if (win && (window.innerWidth !== win.width || window.innerHeight !== win.height)) why.push(`the window is ${window.innerWidth}x${window.innerHeight}`);
        if (root.scrollWidth > window.innerWidth || root.scrollHeight > window.innerHeight) why.push(`the page is ${root.scrollWidth}x${root.scrollHeight} and scrolls`);
        if (getComputedStyle(document.body).overflow !== "hidden") why.push("the body may scroll");
        const bg = getComputedStyle(document.body).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)") why.push(`the page's background is ${bg}, not transparent`);
        const island = document.getElementById("island")!;
        const box = island.getBoundingClientRect();
        if (win && (box.left !== 0 || box.top !== 0 || box.width !== win.width || box.height !== win.height)) why.push(`the island's box is at ${box.left},${box.top} ${box.width}x${box.height}, not the window`);
        for (const el of [island, island.firstElementChild!]) {
          const style = getComputedStyle(el);
          if (style.boxShadow !== "none" || style.filter !== "none" || style.backdropFilter !== "none") why.push(`<${el.tagName.toLowerCase()} class="${el.className}"> has a shadow or a filter`);
        }
        // As drawn: hanging from the top, in the middle, and nowhere outside the rectangle the shell takes the mouse in.
        const shape = (window as Any).__shape() as { left: number; top: number; width: number; height: number };
        if (shape.width <= 0 || shape.height <= 0) why.push("nothing is drawn");
        if (shape.width > most.width || shape.height > most.height) why.push(`the island is drawn ${shape.width}x${shape.height}, more than ${most.width}x${most.height}`);
        // To half a pixel: the hit test finds an edge to a quarter pixel, and at the window's own edge (the chat fills it) a half is lost.
        if (exact && (Math.abs(shape.width - most.width) > 0.5 || Math.abs(shape.height - most.height) > 0.5)) why.push(`the island is drawn ${shape.width}x${shape.height}, not ${most.width}x${most.height}`);
        if (Math.abs(shape.left + shape.width / 2 - box.width / 2) > 0.5) why.push(`the island's middle is at ${shape.left + shape.width / 2}, not ${box.width / 2}`);
        if (win && shape.left < rect.x) why.push(`the island starts at ${shape.left}, left of ${rect.x}`);
        // Everything the state shows lies inside what is drawn, except what a scrolling box holds.
        const layer = document.getElementById(view)!;
        if (layer.hidden || layer.hasAttribute("data-off") || layer.classList.contains("leaving")) why.push(`#${view} is not shown`);
        for (const el of [layer, ...layer.querySelectorAll("*")]) {
          if (el.closest(".scroller > *, .sessions > *") || (el as HTMLElement).offsetParent === null) continue;
          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) continue;
          const [l, t, r, bt] = [b.left - box.left - shape.left, b.top - box.top, b.right - box.left - shape.left - shape.width, b.bottom - box.top - shape.height];
          if (l < -0.5 || t < -0.5 || r > 0.5 || bt > 0.5) why.push(`<${el.tagName.toLowerCase()} class="${el.className}"> reaches outside the island by ${Math.max(-l, -t, r, bt).toFixed(1)}px`);
        }
        return why;
      },
      [sizes[state], { x: (DOCK_WINDOW.width - sizes[state].width) / 2, y: 0 }, bridge ? DOCK_WINDOW : null, state === "idle" ? "pill" : state === "peek" ? "peek" : state === "chat" ? "chat" : "panel", state === "peek" || state === "chat" || (notch !== null && state === "idle")] as const,
    ) as Promise<string[]>;
  const fits = async (state: DockState) => {
    const why = await wrong(state);
    const s = await shape();
    check(why.length === 0, `${colorScheme}${notch ? ", out of the notch" : ""}, ${state}: the island is drawn ${s.width}x${s.height}, inside its ${sizes[state].width}x${sizes[state].height} rectangle at the top centre, with its content inside it (${why.join("; ") || "all inside"})`);
    return s;
  };
  /** A screenshot over a stand-in for the desktop. `tall` false: only the top of the window, where the pill and the peek are. */
  const shot = async (name: string, tall = true) => {
    const path = join(shots, `dock-${name}-${colorScheme}.png`);
    // With a notch, the desktop has one: the hardware's black, at the top centre.
    const desktop = notch ? `linear-gradient(black, black) center top / ${notch.width}px ${notch.height}px no-repeat, ${DESKTOP[colorScheme]}` : DESKTOP[colorScheme];
    await page.evaluate((colour: string) => document.documentElement.style.setProperty("background", colour), desktop);
    await page.screenshot({ path, clip: { x: 0, y: 0, width: viewport.width, height: tall ? viewport.height : 72 } });
    await page.evaluate(() => document.documentElement.style.removeProperty("background"));
    console.log(`  screenshot: ${path}`);
    return path;
  };
  const middle = Math.round(viewport.width / 2);
  /** The pointer onto the island, and away from it: out of the window, as it must go from an island that fills it. */
  const hover = () => page.mouse.move(middle, 8);
  const leave = () => page.mouse.move(-40, viewport.height + 40);
  /** The markdown sample through the open dock: the stream scrolled to its top, middle and end. */
  const markdownShots = async () => {
    for (const [name, at] of [["top", 0], ["middle", 0.5], ["end", 1]] as const) {
      await page.evaluate((f: number) => {
        const s = document.getElementById("scroller")!;
        s.scrollTop = (s.scrollHeight - s.clientHeight) * f;
      }, at);
      await page.waitForTimeout(100);
      await shot(`open-markdown-${name}`);
    }
  };
  return { context, page, calls, lastCall, text, shape, settle, fits, shot, hover, leave, middle, markdownShots };
}

type Dock = Awaited<ReturnType<typeof dock>>;

/** Opens the open dock's list of sessions under its head, where the rows are (D0038), unless it is open. */
async function openList(page: Any): Promise<void> {
  if ((await page.locator("#switcher").getAttribute("aria-expanded")) !== "true") await page.locator("#switcher").click();
  await page.locator("#sessions-list").waitFor();
}

/** Records the frames while `act` changes the state and the island settles in `state`. */
async function recorded(d: Dock, state: DockState, act: () => Promise<void>): Promise<Frame[]> {
  await d.page.evaluate(() => (window as Any).__record());
  await d.page.waitForTimeout(100);
  await act();
  await d.settle(state);
  await d.page.waitForTimeout(100);
  return d.page.evaluate(() => (window as Any).__stop()) as Promise<Frame[]>;
}

const worst = (frames: Frame[]) => Math.max(...frames.map((f) => f.ms));

/** Screenshots of one change of state held at each moment in `at` (ms), put side by side in one picture. */
async function strip(d: Dock, name: string, state: DockState, act: () => Promise<void>, at: number[]): Promise<string> {
  const { page } = d;
  await page.evaluate((colour: string) => document.documentElement.style.setProperty("background", colour), DESKTOP.dark);
  await page.evaluate(() => (window as Any).__hold(0));
  await act();
  await page.waitForFunction((s: string) => document.getElementById("island")!.dataset.state === s, state);
  // Held at its first moment while the content loads, so the frames show one move and not two.
  await page.waitForTimeout(500);
  const frames: string[] = [];
  for (const ms of at) {
    await page.evaluate((t: number) => (window as Any).__hold(t), ms);
    await page.waitForTimeout(80);
    frames.push((await page.screenshot()).toString("base64"));
  }
  await page.evaluate(() => (window as Any).__release());
  await d.settle(state);
  await page.evaluate(() => document.documentElement.style.removeProperty("background"));
  // The frames in two rows, each with its moment under it. A blank page: no network, the pictures are data URLs.
  const sheet = await d.context.newPage();
  await sheet.setViewportSize({ width: Math.ceil(at.length / 2) * (DOCK_WINDOW.width + 12) + 12, height: 2 * (DOCK_WINDOW.height + 44) + 12 });
  await sheet.setContent(`<body style="margin:12px;background:#000;color:#bbb;font:14px system-ui;display:flex;flex-wrap:wrap;gap:12px">${frames
    .map((png, i) => `<figure style="margin:0"><img width="${DOCK_WINDOW.width}" height="${DOCK_WINDOW.height}" src="data:image/png;base64,${png}"><figcaption style="height:28px;padding-top:4px">${name}, ${at[i]} ms</figcaption></figure>`)
    .join("")}</body>`);
  const path = join(shots, `dock-strip-${name}.png`);
  await sheet.screenshot({ path });
  await sheet.close();
  console.log(`  frames: ${path} (${at.join(", ")} ms)`);
  return path;
}

try {
  // ================= light: the whole story =================
  const d = await dock("light");
  const { page } = d;
  await page.goto(`${runner.url}/dock`);
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  check((await d.calls()).map((c) => c.state).join(",") === "idle", "on load the page tells the shell 'idle', once");
  check((await page.locator("#pill").getAttribute("data-tone")) === "none" && (await page.locator("#pill-text").isHidden()) && (await page.locator("#pill-dot").getAttribute("data-status")) === null,
    "with nothing going on the pill is a dim dot alone, without words");
  check((await page.locator("#pill").getAttribute("aria-label")) === "intuition", "and is named 'intuition' for a screen reader");
  check((await page.locator("#peek").isHidden()) && (await page.locator("#panel").isHidden()), "nothing replays on load: no peek for the session that finished before the page connected");
  await page.evaluate(() => document.fonts.ready);
  const quiet = await d.fits("idle");
  check(quiet.height <= 16, `with nothing going on the idle pill is ${quiet.height}px tall`);
  check(quiet.width <= 40, `and, with nothing going on, ${quiet.width}px wide: a sliver`);
  await d.shot("idle-nothing", false);

  // ---- a session runs, finishes and peeks ----
  const prompt = "Tell me about docks";
  const first = await runner.startSession(prompt);
  await page.locator("#pill-text", { hasText: "1 running" }).waitFor();
  check((await page.locator("#pill-dot").getAttribute("data-status")) === "running" && (await page.locator("#pill-text").isVisible()), "idle says '1 running' with the running dot while a session runs");
  check((await d.lastCall()).state === "idle", "a running session changes the pill, not the state");
  await d.settle("idle");
  const busy = await d.fits("idle");
  check(busy.width > quiet.width && busy.height <= 24 && busy.height === DOCK_SIZES.idle.height, `the pill is as wide as its words, ${busy.width}px for '1 running', and ${busy.height}px tall: at most 24`);
  await d.shot("idle-running", false);

  await page.locator("#peek-title", { hasText: prompt }).waitFor();
  await d.settle("peek");
  const peekCall = await d.lastCall();
  check(peekCall.state === "peek", "when it finishes the island peeks, and the shell is told 'peek'");
  check((await page.locator("#peek-title").textContent()) === prompt, "the peek shows the session's title");
  check((await page.locator("#peek-body").textContent()) === `You said: ${prompt}`, "and the start of the answer, on the same line");
  check((await page.locator("#peek-label").textContent()) === "done" && (await page.locator("#pill").isHidden()), "it says 'done', in place of the pill");
  const peeked = await d.fits("peek");
  check(peeked.height <= 52, `the peek is ${peeked.height}px tall: at most 52`);
  check(await page.evaluate(() => {
    const tops = [...document.querySelectorAll("#peek > *")].map((el) => el.getBoundingClientRect()).map((r) => Math.round(r.top + r.height / 2));
    return tops.length === 4 && Math.max(...tops) - Math.min(...tops) <= 1;
  }), "its dot, title, words and label are one line");
  await d.shot("peek-finished", false);
  await page.locator("#pill").waitFor({ timeout: 8000 });
  await d.settle("idle");
  const backCall = await d.lastCall();
  check(backCall.state === "idle" && backCall.at - peekCall.at >= 4800 && backCall.at - peekCall.at < 7000, `it returns to idle after about five seconds (${backCall.at - peekCall.at} ms)`);
  check((await page.locator("#pill-text").isHidden()) && (await page.locator("#peek").isHidden()), "and the pill is the quiet dot again");

  // ---- a session that needs approval peeks and stays ----
  const needs = "this one needs approval";
  const waiting = await runner.startSession(needs);
  await page.locator("#peek-title", { hasText: needs }).waitFor();
  await d.settle("peek");
  check((await page.locator("#peek-label").textContent()) === "needs you" && (await page.locator("#peek").getAttribute("data-kind")) === "needs_approval", "a session that needs approval peeks and says 'needs you'");
  check((await page.locator("#peek-body").textContent()) === `Write: ${runner.dir}/work/fake.txt`, "with the tool and its target");
  check((await page.locator("#pill-text").textContent()) === "needs you" && (await page.locator("#pill").getAttribute("data-tone")) === "needs", "and the pill behind it says 'needs you'");
  await d.fits("peek");
  await d.shot("peek-approval", false);
  await page.waitForTimeout(6000);
  check((await page.locator("#peek").isVisible()) && (await d.lastCall()).state === "peek", "six seconds later the peek is still there: it stays until answered or opened");

  // ---- hovering opens ----
  const hoveredAt = Date.now();
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  const openCall = await d.lastCall();
  check(openCall.state === "open" && openCall.at - hoveredAt >= 80, `hovering opens, after a moment's rest on the island (${openCall.at - hoveredAt} ms; the wait is 80)`);
  check((await page.locator('.session-row[aria-current="true"] .row-title').textContent()) === needs, "the session that peeked and needs approval is preselected");
  check((await d.text(".row-title")).join("|") === [needs, prompt, "Markdown sample", HOSTILE, LONG_TITLE].join("|"), "the list has the sessions, newest activity first");
  check((await page.locator('.session-row[aria-current="true"] .row-workspace').textContent()) === "work" && (await d.text(".row-time")).join(",") === "now,now,2h,3h,4h", "each with its workspace and a short relative time");
  check((await page.locator('.session-row[aria-current="true"] .dot').getAttribute("data-status")) === "waiting_approval", "and a status dot");
  const card = page.locator(".approval");
  await card.locator("button", { hasText: "Allow" }).waitFor();
  check((await card.getAttribute("data-state")) === "open" && (await d.text(".approval-actions button")).join(",") === "Allow,Deny", "the open approval is a card with Allow and Deny");
  check((await card.locator(".approval-tool").textContent()) === "Write" && (await card.locator(".approval-path").textContent()) === `${runner.dir}/work/fake.txt`, "that names the tool and the file");
  check((await page.locator("#reply-text").isDisabled()) && (await page.locator("#reply-text").getAttribute("placeholder")) === "Waiting for your answer above." && (await page.locator("#reply-hint").isHidden()),
    "the reply box is off, its placeholder a short hint while it waits, and no line under it");
  check((await page.locator(".panel-head #switcher").isVisible()) && (await page.locator(".panel-head #workspace").count()) === 0 && (await page.locator("#sessions-list").isHidden()), "the panel's head is the session's switch, with the list of sessions closed under it (D0038)");
  check((await page.locator(".panel-head a", { hasText: "New task" }).getAttribute("href")) === "/prompt" && (await page.locator(".panel-head a").getAttribute("target")) === "_blank", "'New task' is a new window on /prompt");
  await d.settle("open");
  const opened = await d.fits("open");
  const panelHeight = await page.locator("#panel").evaluate((el: Element) => el.getBoundingClientRect().height);
  check(opened.height <= DOCK_SIZES.open.height && Math.abs(opened.height - panelHeight) <= 1, `open, the island is as tall as its content: ${opened.height}px for a panel of ${Math.round(panelHeight)}px (at most ${DOCK_SIZES.open.height})`);
  await d.shot("open-approval");

  // ---- the session's actions: a quiet "…" in its head ----
  {
    const heads = await page.locator(".panel-head > :not([hidden])").evaluateAll((els: Element[]) => els.map((el) => el.id || el.className));
    check(heads.join(",") === "switcher,stop quiet small,more,button quiet small new-task,expand", `the head is the session's switch, Stop while it runs, "…", New task and the chat's button (${heads.join(", ")})`);
    check((await page.locator("#switcher #title").textContent()) !== "" && (await page.locator("#switcher .session-agent svg").count()) === 1, "the switch shows the session's title and its agent's glyph");
    await page.locator("#more").click();
    const items = await d.text(".menu:not([hidden]) .menu-item");
    check(items[0] === "Open in chat" && items.slice(-3).join(",") === "Rename,Pin,Archive" && (await page.locator("#more").getAttribute("aria-expanded")) === "true", `"…" opens a small menu: ${items.join(", ")}`);
    await page.locator(".menu").evaluate((el: Element) => Promise.all(el.getAnimations().map((x) => x.finished)));
    await d.shot("open-more");
    await page.locator("#more").click();
    check((await page.locator(".menu:not([hidden])").count()) === 0, "a second press on '…' puts its menu away");
    await page.locator("#more").click();
    await page.locator(".menu:not([hidden])").waitFor();
    const pagesBefore = d.context.pages().length;
    await page.locator(".menu-item", { hasText: "Open in chat" }).click();
    await d.settle("chat");
    check((await d.lastCall()).state === "chat" && d.context.pages().length === pagesBefore, "'Open in chat' grows the island into the chat, and the shell is told 'chat': no new window (D0042)");
    const inChat = page.frameLocator("#chat-frame");
    await inChat.locator("#title", { hasText: needs }).waitFor();
    await inChat.locator(".approval button", { hasText: "Allow" }).waitFor();
    check(true, "the chat shows the same session, with its approval waiting to be answered there");
    check((await page.locator(".menu:not([hidden])").count()) === 0 && (await page.locator("#more").getAttribute("aria-expanded")) === "false", "and the menu is gone");
    // Esc in the chat steps back down to the small dock, on the same session.
    await page.keyboard.press("Escape");
    await d.settle("open");
    check((await d.lastCall()).state === "open" && (await page.locator("#title").textContent()) === needs, "Esc in the chat steps back down to the open dock, on the same session");
    await d.hover();
  }

  // ---- leaving closes; unanswered, the pill says so ----
  const leftAt = Date.now();
  await d.leave();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  const closedCall = await d.lastCall();
  check(closedCall.state === "idle" && closedCall.at - leftAt >= 380, `the pointer leaves and the dock closes, not sooner than 400 ms after (${closedCall.at - leftAt} ms)`);
  check((await page.locator("#pill-text").textContent()) === "needs you" && (await page.locator("#pill-dot").getAttribute("data-status")) === "waiting_approval", "opened but not answered: no peek again, and the pill says 'needs you'");
  const warn = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--warn)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  check((await page.locator("#pill-text").evaluate((el: Element) => getComputedStyle(el).color)) === warn, "in the approval colour");
  await d.fits("idle");
  await d.shot("idle-needs-you", false);

  // ---- Allow in the dock ----
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  check((await page.locator('.session-row[aria-current="true"] .row-title').textContent()) === needs, "opened again, the session that needs approval is preselected");
  await card.locator("button", { hasText: "Allow" }).click();
  await page.locator('.approval[data-state="allow"]').waitFor();
  check((await card.locator(".approval-state").textContent()) === "Allowed" && (await card.locator("button").count()) === 0, "Allow in the dock resolves the approval: the card says Allowed, without buttons");
  await page.locator(".msg.streaming").waitFor();
  check(true, "the turn goes on and its answer streams in");
  await page.locator(".msg.assistant:not(.streaming)", { hasText: "The tool call was allowed." }).waitFor();
  await page.locator(".note", { hasText: "Done" }).waitFor();
  check((await page.locator(".msg.streaming").count()) === 0 && (await page.locator(".msg.assistant").count()) === 1, "the streamed text is replaced by the complete text, once");
  check((await d.text(".tool-row .tool-name")).join(",") === "Write" && (await d.text(".tool-row .tool-line")).join(",") === `${runner.dir}/work/fake.txt`, "the tool call is a one-line row");
  check((await d.lastCall()).state === "open" && (await page.locator("#peek").isHidden()), "no peek while the dock is open: the turn finished and the list shows it");
  check((await page.locator("#pill-text").textContent()) === "intuition", "and the pill no longer says 'needs you'");

  // ---- continuing the session ----
  const box = page.locator("#reply-text");
  await page.locator("#reply-text:not([disabled])").waitFor();
  check((await box.getAttribute("placeholder")) === "Enter to send, Shift+Enter for a new line" && (await page.locator("#reply-hint").isHidden()), "the turn over, the reply box is on, its keys in its placeholder: no hint line");
  await box.click();
  await box.fill("first line");
  await box.press("Shift+Enter");
  check((await box.inputValue()) === "first line\n", "Shift+Enter is a new line and sends nothing");
  const reply = "and what then?";
  await box.fill(reply);
  await box.press("Enter");
  await page.locator(".msg.user", { hasText: reply }).waitFor();
  check(true, "typing a reply and pressing Enter shows the reply");
  await page.locator("#reply-text[disabled]").waitFor();
  check((await box.getAttribute("placeholder")) === "Working. You can reply when this turn ends.", "the box is off, with a hint, while the session runs");
  await page.locator(".msg.streaming").waitFor();
  check(true, "the new answer streams in");
  await page.locator(".msg.assistant:not(.streaming)", { hasText: `You said: ${reply}` }).waitFor();
  await page.locator("#reply-text:not([disabled])").waitFor();
  check((await box.inputValue()) === "" && (await page.evaluate(() => document.activeElement?.id)) === "reply-text", "then the box is empty, on, and has the focus back");
  check((await page.locator(".msg.user").count()) === 2 && (await page.locator(".msg.assistant").count()) === 2, "each message is in the stream once");
  check(await page.evaluate(() => {
    const s = document.getElementById("scroller")!;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 4;
  }), "and the stream is scrolled to the bottom");
  await d.settle("open");
  const grown = await d.fits("open");
  check(grown.height > opened.height - 200 && grown.height <= DOCK_SIZES.open.height, `the island followed its content: ${grown.height}px now`);
  await d.shot("open-replied");

  // ---- an agent's questions: answered in the dock and handed back (D0039) ----
  {
    await box.fill("now ask me something");
    await box.press("Enter");
    const q = page.locator(".approval").last();
    await q.locator(".questions").waitFor();
    check((await q.locator(".approval-tool").textContent()) === "Question" && (await q.locator(".approval-state").textContent()) === "Needs your answer" && (await q.locator(".approval-actions button").allTextContents()).join(",") === "Answer,Skip", "an agent's questions are a card with Answer and Skip");
    check((await q.locator(".question-text").allTextContents()).join("|") === "ColourWhich colour should the button be?|PagesWhich pages should get it?" && (await q.locator("input[type=radio]").count()) === 2 && (await q.locator("input[type=checkbox]").count()) === 3, "each question with its options: one to pick, or several");
    const send = q.locator("button", { hasText: "Answer" });
    check(await send.isDisabled(), "Answer is off until every question has an answer");
    await q.locator(".option", { hasText: "Green" }).click();
    check(await send.isDisabled(), "one answered is not enough");
    await q.locator(".option", { hasText: "Chat" }).click();
    await q.locator(".option", { hasText: "Dock" }).click();
    check(!(await send.isDisabled()), "with both, Answer is on");
    await d.settle("open");
    await d.fits("open");
    await d.shot("open-question");
    await send.click();
    await q.locator(".question-answers").waitFor();
    check((await q.getAttribute("data-state")) === "allow" && (await q.locator(".approval-state").textContent()) === "Answered" && (await q.locator(".question-answers dd").allTextContents()).join("|") === "Green|Chat, Dock" && (await q.locator("button").count()) === 0, "answered, the card shows each answer, without buttons");
    await page.locator(".msg.assistant:not(.streaming)", { hasText: "You answered: Which colour should the button be? Green; Which pages should get it? Chat, Dock" }).waitFor();
    check(true, "and the agent got the answers");
    await d.settle("open");
    await d.shot("open-question-answered");
  }


  // ---- managing a session from the open dock: Stop, and a row's menu (Rename, Pin, Archive) ----
  {
    const slowTitle = "count slowly in the dock";
    const slow = await runner.startSession(slowTitle);
    const slowRow = page.locator(".session-row", { hasText: slowTitle });
    await openList(page);
    await slowRow.click();
    const stop = page.locator(".panel-head .stop");
    await stop.waitFor();
    check((await stop.textContent()) === "Stop", "a running session has Stop in the open dock's head");
    await d.settle("open");
    await d.fits("open");
    await d.shot("open-stop");
    await stop.click();
    await page.locator(".note", { hasText: "Stopped" }).waitFor();
    await stop.waitFor({ state: "hidden" });
    check((await page.locator(".msg.streaming").count()) === 0, "Stop ends the turn: the stream says Stopped, and Stop is gone");
    await openList(page);
    await slowRow.click({ button: "right" });
    const items = () => d.text(".menu:not([hidden]) .menu-item");
    check((await items()).join(",") === "Rename,Pin,Archive", "right-click on a row opens a small menu: Rename, Pin, Archive");
    // The panel grew by the Stopped line: the island follows it first.
    await d.settle("open");
    await d.fits("open");
    await d.shot("open-menu");
    await page.locator(".menu-item", { hasText: "Pin" }).click();
    await page.locator(".row-title.pinned", { hasText: slowTitle }).waitFor();
    check((await d.text(".row-title"))[0] === slowTitle, "Pin puts it at the top of the list, marked");
    await openList(page);
    await slowRow.click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Rename" }).click();
    const input = page.locator(".session-row input.rename");
    check((await input.inputValue()) === slowTitle, "Rename edits the title in its row");
    await d.leave();
    await page.waitForTimeout(900);
    check((await d.lastCall()).state === "open", "and the dock stays open while it is edited, the pointer away");
    await d.hover();
    await input.fill("renamed in the dock");
    await input.press("Enter");
    await page.locator(".row-title", { hasText: "renamed in the dock" }).waitFor();
    const all = async (q = "") => ((await (await runner.get(`/api/sessions${q}`)).json()) as { sessions: { id: string; title: string }[] }).sessions;
    check((await all()).some((x) => x.id === slow.id && x.title === "renamed in the dock"), "Enter saves it in the runner");
    await page.locator(".row-title", { hasText: "renamed in the dock" }).click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Unpin" }).click();
    await page.locator(".row-title.pinned").waitFor({ state: "detached" });
    await page.locator(".row-title", { hasText: "renamed in the dock" }).click({ button: "right" });
    await page.locator(".menu-item", { hasText: "Archive" }).click();
    await page.locator(".row-title", { hasText: "renamed in the dock" }).waitFor({ state: "detached" });
    check((await all("?archived=1")).some((x) => x.id === slow.id), "Archive takes it out of the dock's list, archived in the runner");
    check((await d.lastCall()).state === "open", "and the dock stayed open throughout");
    await openList(page);
    await page.locator(".session-row", { hasText: needs }).click();
    await page.locator('.session-row[aria-current="true"]', { hasText: needs }).waitFor({ state: "attached" });
    // Back where the next part starts: the reply box has the focus.
    await page.locator("#reply-text:not([disabled])").waitFor();
    await box.click();
  }

  // ---- what keeps it open ----
  await d.leave();
  await page.waitForTimeout(900);
  check((await page.locator("#panel").isVisible()) && (await d.lastCall()).state === "open", "the pointer away, the dock stays open while the reply box has the focus");
  await box.fill("half a reply");
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.waitForTimeout(900);
  check((await page.locator("#panel").isVisible()) && (await d.lastCall()).state === "open", "and, the focus gone, while the box has text in it");
  await d.hover();
  await box.fill("");
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.waitForTimeout(900);
  check(await page.locator("#panel").isVisible(), "cleared, it stays open while the pointer is on it");
  await d.leave();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  check(true, "and closes once the box is cleared and the pointer leaves");

  // ---- the pointer held down, a press beside it, Esc, and a pointer that only passes ----
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  await page.mouse.down();
  await d.leave();
  await page.waitForTimeout(900);
  check(await page.locator("#panel").isVisible(), "it stays open while the pointer is held down, even outside");
  await page.mouse.up();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  check(true, "and closes when it is let go there");
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  await page.keyboard.press("Escape");
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  check(true, "Esc closes it, with the pointer still on it");
  await page.mouse.move(d.middle + 3, 9);
  await page.waitForTimeout(400);
  check((await page.locator("#pill").isVisible()) && (await d.lastCall()).state === "idle", "and it stays closed while the pointer has not left the island");
  await d.leave();
  const before = (await d.calls()).length;
  await d.hover();
  await page.waitForTimeout(30);
  await d.leave();
  await page.waitForTimeout(500);
  check((await d.calls()).length === before && (await page.locator("#pill").isVisible()), "a pointer that only brushes past the pill opens nothing");
  // The quiet pill is a dot: the whole idle rectangle is its handle, as it is the shell's.
  await page.mouse.move(d.middle + DOCK_SIZES.idle.width / 2 - 4, 10);
  await page.locator("#panel").waitFor();
  await d.settle("open");
  check(true, "resting anywhere in the idle rectangle opens it, also beside the dot");
  await d.leave();
  await page.locator("#pill").waitFor();
  await d.settle("idle");

  // ---- the motion: the frames of an open and a close ----
  const opening = await recorded(d, "open", d.hover);
  const closing = await recorded(d, "idle", d.leave);
  const heights = opening.map((f) => f.height);
  const final = heights.at(-1)!;
  check(opening.length > 15 && worst(opening) < FRAME_LIMIT_MS, `opening: ${opening.length} frames, the worst ${worst(opening).toFixed(1)} ms (under ${FRAME_LIMIT_MS})`);
  check(closing.length > 15 && worst(closing) < FRAME_LIMIT_MS, `closing: ${closing.length} frames, the worst ${worst(closing).toFixed(1)} ms (under ${FRAME_LIMIT_MS})`);
  console.log(`  worst frame: ${Math.max(worst(opening), worst(closing)).toFixed(1)} ms (open ${worst(opening).toFixed(1)}, close ${worst(closing).toFixed(1)})`);
  const between = heights.filter((h) => h > DOCK_SIZES.idle.height + 1 && h < final - 1).length;
  check(between >= 5, `the island grows through ${between} frames between the pill and its full height: one shape, not a jump`);
  // A spring: past its size a little and back, never more than the bouncy spring's 11% (and never out of the window).
  check(Math.max(...heights) <= Math.min(final * 1.12, DOCK_WINDOW.height) + 0.5 && final <= DOCK_SIZES.open.height + 0.5, `opening, it springs to its size (${final}px) and at most a little past it (the most ${Math.max(...heights)}px), within the window`);
  check(opening.every((f) => f.hung) && closing.every((f) => f.hung), `the top edge stays on the screen's edge in all ${opening.length + closing.length} frames of the open and the close`);
  const closingHeights = closing.map((f) => f.height);
  // The soft spring dips a little under the pill and settles back up: that settle is below the pill's height.
  check(closingHeights.every((h, i) => i === 0 || h <= closingHeights[i - 1]! + 0.5 || h <= DOCK_SIZES.idle.height) && closingHeights.at(-1)! <= DOCK_SIZES.idle.height, "closing, it gathers back on the soft spring: it only shrinks, back to the pill");
  /** How long until the shape first reaches `to` from `from`: the stretch, before any settle. */
  const reach = (frames: Frame[], from: number, to: number) => {
    const moving = frames.findIndex((f) => Math.abs(f.height - from) > 1);
    // At it or past it: a fast frame can step over the size on the way to its overshoot.
    const there = frames.findIndex((f, i) => i >= moving && (to > from ? f.height >= to - 1 : f.height <= to + 1));
    return frames.slice(moving, there + 1).reduce((sum, f) => sum + f.ms, 0);
  };
  const [openMs, closeMs] = [reach(opening, DOCK_SIZES.idle.height, final), reach(closing, final, closingHeights.at(-1)!)];
  check(openMs >= 50 && openMs <= 400 && closeMs >= 100 && closeMs <= 400, `the shape reaches its height in ${Math.round(openMs)} ms opening (the bouncy spring, and the panel's content as it loads) and ${Math.round(closeMs)} ms closing (the softer one): neither slow`);
  check(await page.evaluate(([w, h]: number[]) => window.innerWidth === w && window.innerHeight === h, [DOCK_WINDOW.width, DOCK_WINDOW.height]), `through all of it the window stayed ${DOCK_WINDOW.width}x${DOCK_WINDOW.height}`);

  // ---- a failed session ----
  let failing: unknown;
  const peeking = await recorded(d, "peek", async () => {
    failing = await runner.startSession("please fail");
    await page.locator("#peek-title", { hasText: "please fail" }).waitFor();
  });
  {
    // The peek pops in: wider than its line for a moment and back, hanging from the edge all the while.
    const widths = peeking.map((f) => f.width);
    const most = Math.max(...widths);
    check(worst(peeking) < FRAME_LIMIT_MS && peeking.every((f) => f.hung), `peeking: the worst of ${peeking.length} frames ${worst(peeking).toFixed(1)} ms, the top edge on the screen's edge in every one`);
    check(most > DOCK_SIZES.peek.width + 2 && most <= DOCK_SIZES.peek.width * 1.12 && Math.abs(widths.at(-1)! - DOCK_SIZES.peek.width) <= 1, `the peek pops in a little past its width (the most ${most}px for ${DOCK_SIZES.peek.width}px) and settles`);
  }
  check((await page.locator("#peek-label").textContent()) === "failed" && (await page.locator("#peek-body").textContent()) === "the fake agent failed", "a failed session peeks with the error's message");
  await d.shot("peek-error", false);
  await page.locator("#pill").waitFor({ timeout: 8000 });
  await d.settle("idle");
  check((await page.locator("#pill-text").textContent()) === "failed" && (await page.locator("#pill-text").isVisible()) && (await page.locator("#pill-dot").getAttribute("data-status")) === "error", "and the pill then carries an error mark: the newest finished one failed");
  await d.fits("idle");
  await d.shot("idle-failed", false);
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  check((await page.locator('.session-row[aria-current="true"] .row-title').textContent()) === "please fail", "opened after a peek, the session that peeked last is preselected");
  await page.locator(".error", { hasText: "the fake agent failed" }).waitFor();
  check((await page.locator("#reply-text").isEnabled()) && (await page.locator("#reply-text").getAttribute("placeholder")) === "The last turn failed. A reply tries again.", "its error is in the stream, and a reply may try again");
  void failing;
  void first;

  // ---- untrusted text, and picking another session ----
  await openList(page);
  await page.locator(".session-row", { hasText: "<img" }).click();
  await page.locator(".note", { hasText: "Done · 4.2 s · $0.031" }).waitFor();
  check((await page.locator("#title").textContent()) === HOSTILE && (await page.locator('.session-row[aria-current="true"]').getAttribute("href")) === `/?session=${hostileId}`, "clicking a row selects that session");
  check((await page.locator("body img, body script").count()) === 0 && (await page.evaluate(() => (window as Any).__xss)) === undefined, "markup in a title, a prompt, an answer, a tool call and an approval made no element and ran nothing");
  check((await d.text(".msg.user"))[0] === `${HOSTILE}\nsecond line` && (await d.text(".msg.assistant p"))[0] === `Markup stays text: ${HOSTILE}`, "the user's and the assistant's text are shown as text");
  check((await d.text(".tool-row .tool-line"))[0] === `/tmp/${HOSTILE}.txt` && (await d.text(".tool-row .tool-mark"))[0] === "failed", "a failed tool call is marked on its row");
  check((await page.locator(".approval").getAttribute("data-state")) === "deny" && (await page.locator(".approval button").count()) === 0 && (await page.locator(".approval-tool").textContent()) === HOSTILE, "a decided approval is a quiet card without buttons");
  check((await d.text(".msg.assistant p code"))[0] === "bun test" && (await d.text(".msg.assistant pre.code-block"))[0] === `const html = '${HOSTILE}';`, "inline code and a code block are rendered");
  await d.settle("open");
  const full = await d.fits("open");
  check(full.height >= DOCK_SIZES.open.height - 1 && (await page.evaluate(() => {
    const s = document.getElementById("scroller")!;
    return s.scrollHeight > s.clientHeight;
  })), `a long session fills the island to its ${DOCK_SIZES.open.height}px and the stream scrolls inside it`);
  await d.shot("open-hostile");
  // ---- every markdown construct, in the open dock, light here and dark below ----
  await openList(page);
  await page.locator(".session-row", { hasText: "Markdown sample" }).click();
  await page.locator(".msg.assistant.md", { hasText: "SPRING MEETUP" }).waitFor();
  const mdWrong = (await page.evaluate(markdownProblems, [MARKDOWN_EXPECTED])) as string[];
  check(mdWrong.length === 0, `light: every markdown construct is drawn in the dock, links only to http(s) and mailto, nothing wider than the stream (${mdWrong.join("; ") || "all there"})`);
  check((await page.evaluate(() => (window as Any).__xss)) === undefined && (await d.text(".msg.user"))[0] === "Show me **every** construct", "nothing in it ran, and the user's markdown stays plain text");
  await d.settle("open");
  await d.markdownShots();

  // ---- nothing scrolls sideways: a title and an answer wider than the panel ----
  await openList(page);
  await page.locator(".session-row", { hasText: "very-long-path-segment" }).click();
  await page.locator(".msg.assistant", { hasText: "is one word" }).waitFor();
  // The list open, so its row is laid out too (D0038).
  await openList(page);
  await d.settle("open");
  const sideways = (await page.evaluate(() => {
    const why: string[] = [];
    for (const id of ["sessions", "scroller"]) {
      const el = document.getElementById(id)!;
      if (el.scrollWidth > el.clientWidth) why.push(`#${id} is ${el.scrollWidth}px wide in ${el.clientWidth}px`);
    }
    for (const el of document.querySelectorAll("#panel *")) {
      const x = getComputedStyle(el).overflowX;
      if ((x === "auto" || x === "scroll") && el.scrollWidth > el.clientWidth) why.push(`<${el.tagName.toLowerCase()} class="${el.className}"> scrolls sideways`);
    }
    for (const sel of ['.session-row[aria-current="true"] .row-title', "#title"]) {
      const el = document.querySelector(sel) as HTMLElement;
      const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
      if (getComputedStyle(el).textOverflow !== "ellipsis" || el.scrollWidth <= el.clientWidth || el.getBoundingClientRect().height > line * 1.5) why.push(`${sel} is not one line ending in an ellipsis`);
    }
    return why;
  })) as string[];
  check(sideways.length === 0, `a title and a URL wider than the panel: the list and the stream don't scroll sideways, the title is one line that ends in "…" (${sideways.join("; ") || "none does"})`);
  await d.fits("open");
  await d.shot("open-long-url");

  // ---- the workspace switch ----
  const workspace = page.locator("#workspace");
  check((await workspace.evaluate((el: Element) => el.classList.contains("select") && el.classList.contains("quiet") && el.classList.contains("small"))) && (await d.text("#workspace option")).join(",") === "All workspaces,gone,work",
    "the head has a quiet dropdown: All workspaces, then each workspace with sessions");
  const allTitles = await d.text(".row-title");
  const workTitles = allTitles.filter((t) => t !== LONG_TITLE).join("|");
  await openList(page);
  await workspace.selectOption("work");
  await page.locator(".session-row", { hasText: "very-long-path-segment" }).waitFor({ state: "detached" });
  check((await d.text(".row-title")).join("|") === workTitles && (await page.locator(".row-workspace:not([hidden])").count()) === 0,
    "choosing 'work' lists only its sessions, and the rows no longer name it");
  check((await page.locator('.session-row[aria-current="true"]').count()) === 1 && (await page.locator("#title").textContent()) !== LONG_TITLE, "the session shown from another workspace makes way for one of this one");
  await d.settle("open");
  await d.fits("open");
  await d.shot("open-workspace");
  await d.leave();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  check((await workspace.inputValue()) === "work" && (await d.text(".row-title")).join("|") === workTitles, "closed and opened again, the dock still shows only 'work'");
  await page.reload();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  check((await workspace.inputValue()) === "work" && (await d.text(".row-title")).join("|") === workTitles, "and so after the page is loaded again: the choice is remembered");
  await openList(page);
  await workspace.selectOption("gone");
  await page.locator('.session-row[aria-current="true"]', { hasText: "very-long-path-segment" }).waitFor({ state: "attached" });
  check((await d.text(".row-title")).join("|") === LONG_TITLE, "'gone' lists its one session, and shows it");
  await openList(page);
  await workspace.selectOption("");
  await page.locator(".session-row", { hasText: needs }).waitFor({ state: "attached" });
  check((await d.text(".row-title")).join("|") === allTitles.join("|") && (await page.evaluate(() => localStorage.getItem("intuition.dock.workspace"))) === null, "All workspaces lists them all again, and is remembered as no choice");

  // ---- the agent: a quiet glyph on each row, and the head names it ----
  const codexTitle = "answer this on codex in the dock";
  const codexId = ((await (await runner.post("/api/sessions", { workspace: "work", prompt: codexTitle, agent: "codex" })).json()) as { session: { id: string } }).session.id;
  const codexRow = page.locator(".session-row", { hasText: codexTitle });
  await openList(page);
  await codexRow.click();
  await page.locator(".msg.assistant:not(.streaming)", { hasText: `You said: ${codexTitle}` }).waitFor();
  await page.locator(".note", { hasText: "Done" }).waitFor();
  const codexMark = codexRow.locator(".agent-mark");
  check((await codexMark.getAttribute("data-agent")) === "codex" && (await codexMark.getAttribute("title")) === "Runs on Codex" && (await codexMark.locator("svg").count()) === 1, "a Codex session's row has Codex's glyph, its name only as the tooltip");
  check((await page.locator(".session-row .agent-mark").count()) === (await page.locator(".session-row").count()), "every row has its agent's glyph");
  check((await page.locator("#switcher .session-agent").getAttribute("title")) === "Codex", "the open session's switch has its agent's glyph, named in the tooltip");
  await d.settle("open");
  await d.fits("open");
  await d.shot("open-codex");
  // Gone again, so the dark part below starts from the sessions it expects.
  await openList(page);
  await page.locator(".session-row").filter({ hasNotText: codexTitle }).first().click();
  check((await runner.post(`/api/sessions/${codexId}/delete`, {})).ok, "the Codex session is deleted after its look");
  await page.locator(".session-row", { hasText: codexTitle }).waitFor({ state: "detached" });

  await d.leave();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  check((await d.calls()).every((c, i, all) => i === 0 || c.state !== all[i - 1]!.state), "the shell was told each change of state once, as it happened");
  await d.context.close();

  // ================= dark: the three states again =================
  const k = await dock("dark");
  await k.page.goto(`${runner.url}/dock`);
  await k.page.locator("#pill-text", { hasText: "failed" }).waitFor();
  await k.settle("idle");
  await k.page.evaluate(() => document.fonts.ready);
  await k.shot("idle-failed", false);
  const darkPrompt = "A second look, in the dark";
  await runner.startSession(darkPrompt);
  await k.page.locator("#pill-text", { hasText: "1 running" }).waitFor();
  check((await k.page.locator("#pill-failed").isVisible()) && (await k.page.locator("#pill-dot").getAttribute("data-status")) === "running", "beside '1 running' a red dot still marks that the newest finished one failed");
  await k.settle("idle");
  await k.fits("idle");
  await k.shot("idle-running", false);
  await k.page.locator("#peek-title", { hasText: darkPrompt }).waitFor();
  await k.settle("peek");
  await k.fits("peek");
  await k.shot("peek-finished", false);
  await k.hover();
  await k.page.locator("#panel").waitFor();
  await k.page.locator(".note", { hasText: "Done" }).waitFor();
  await k.settle("open");
  check((await k.page.locator('.session-row[aria-current="true"] .row-title').textContent()) === darkPrompt, "dark: opened from a peek, its session is selected");
  await k.fits("open");
  await k.shot("open");
  const darkCodex = "answer this on codex in the dark dock";
  const darkCodexId = ((await (await runner.post("/api/sessions", { workspace: "work", prompt: darkCodex, agent: "codex" })).json()) as { session: { id: string } }).session.id;
  await openList(k.page);
  await k.page.locator(".session-row", { hasText: darkCodex }).click();
  await k.page.locator('#switcher .session-agent[title="Codex"]').waitFor();
  await k.page.locator(".note", { hasText: "Done" }).waitFor();
  await k.settle("open");
  await k.fits("open");
  await k.shot("open-codex");
  await openList(k.page);
  await k.page.locator(".session-row").filter({ hasNotText: darkCodex }).first().click();
  check((await runner.post(`/api/sessions/${darkCodexId}/delete`, {})).ok, "dark: the Codex session is deleted after its look");
  await k.page.locator(".session-row", { hasText: darkCodex }).waitFor({ state: "detached" });
  await openList(k.page);
  await k.page.locator(".session-row", { hasText: darkPrompt }).click();
  await k.page.locator('#switcher .session-agent[title="Claude Code"]').waitFor();
  await openList(k.page);
  await k.page.locator(".session-row", { hasText: "Markdown sample" }).click();
  await k.page.locator(".msg.assistant.md", { hasText: "SPRING MEETUP" }).waitFor();
  const mdDark = (await k.page.evaluate(markdownProblems, [MARKDOWN_EXPECTED])) as string[];
  check(mdDark.length === 0, `dark: every markdown construct is drawn in the dock (${mdDark.join("; ") || "all there"})`);
  await k.settle("open");
  await k.markdownShots();
  const colours = (p: Any) => p.evaluate(() => [getComputedStyle(document.querySelector(".surface")!).backgroundColor, getComputedStyle(document.body).color]) as Promise<string[]>;
  const darkColours = await colours(k.page);
  await k.page.emulateMedia({ colorScheme: "light" });
  check((await colours(k.page)).join() === darkColours.join() && darkColours[0] === "rgba(18, 18, 24, 0.86)", `the island is the same dark in both schemes (${darkColours.join(" on ")})`);
  // The dock loads theme.js, which sets data-theme on <html>; .dark is on <body>, so it still wins.
  for (const forced of ["light", "dark", "system"]) {
    await k.page.evaluate((t: string) => (window as Any).intuitionTheme.apply(t), forced);
    const now = await colours(k.page);
    check(now.join() === darkColours.join(), `and with the theme forced to ${forced} (${now.join(" on ")})`);
  }
  await k.leave();
  await k.page.locator("#pill").waitFor();
  await k.settle("idle");
  await k.shot("idle-nothing", false);
  await k.context.close();

  // ================= the frames: an open and a close, held at moments along the way =================
  const f = await dock("dark", { scale: 1 });
  await f.page.goto(`${runner.url}/dock`);
  await f.page.locator("#pill").waitFor();
  await f.settle("idle");
  await f.page.evaluate(() => document.fonts.ready);
  const openStrip = await strip(f, "open", "open", f.hover, [0, 40, 80, 120, 160, 200, 240, 280, 320, 360]);
  const closeStrip = await strip(f, "close", "idle", async () => {
    await f.leave();
    await f.page.waitForTimeout(450);
  }, [0, 30, 60, 90, 120, 160, 200, 240, 290, 340]);
  const peekPrompt = "A peek, frame by frame";
  const peekStrip = await strip(f, "peek", "peek", async () => {
    await runner.startSession(peekPrompt);
    await f.page.locator("#peek-title", { hasText: peekPrompt }).waitFor();
  }, [0, 30, 60, 90, 120, 160, 200, 250, 300, 400]);
  check([openStrip, closeStrip, peekStrip].every((path) => readFileSync(path).length > 10_000), "a strip of ten frames through the open, the close and a peek is saved, to be looked at");
  await f.page.locator("#pill").waitFor({ timeout: 8000 });
  await f.settle("idle");
  await f.context.close();

  // ================= reduced motion: a plain fade =================
  const q = await dock("dark", { reducedMotion: "reduce" });
  await q.page.goto(`${runner.url}/dock`);
  await q.page.locator("#pill").waitFor();
  await q.settle("idle");
  await q.page.evaluate(() => (window as Any).__record());
  await q.hover();
  await q.page.locator("#panel").waitFor();
  const fade = await q.page.locator("#panel").evaluate((el: Element) => el.getAnimations().map((a) => (a as CSSAnimation).animationName).join());
  await q.settle("open");
  const still = (await q.page.evaluate(() => (window as Any).__stop())) as Frame[];
  const steps = new Set(still.map((frame) => frame.height));
  const moves = await q.page.locator("#island").evaluate((el: Element) => [el, el.firstElementChild!].map((e) => getComputedStyle(e).transitionProperty + " " + getComputedStyle(e).transitionDuration).join());
  // A step for the shape and one for each time the content under it grew: none of them a frame on the way.
  check(fade === "layer-fade" && moves === "none 0s,none 0s" && steps.size <= 5, `prefers-reduced-motion: no transition on the shape, which changes in steps (${[...steps].join(" then ")}px), and the content fades in plainly (${fade})`);
  await q.context.close();

  // ================= a session from the terminal: its mark, a turn from it, Send anyway, Continue in terminal =================
  {
    const transcripts = new MemoryTranscripts();
    const term = testRunner({ driver: fakeDriver(5), sync: { transcripts, pollMs: 50, idleMs: 400 } });
    const t = await dock("dark");
    try {
      const work = term.config.workspaces.find((w) => w.name === "work")!.path;
      const first = "started in a terminal";
      // Written five minutes ago: imported idle, and not taken as open in a terminal.
      transcripts.write("term-1", work, [userEntry(first), assistantEntry("hello from the terminal")], Date.now() - 5 * 60_000);
      await term.startSession("one of the runner's own");
      await t.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: term.url });
      await t.page.goto(`${term.url}/dock`);
      await t.page.locator("#pill").waitFor();
      await t.settle("idle");
      await t.hover();
      await t.page.locator("#panel").waitFor();
      await t.settle("open");
      const termRow = t.page.locator(".session-row", { hasText: first });
      await openList(t.page);
      await termRow.waitFor();
      check((await t.page.locator(".session-row .terminal-mark:not([hidden])").count()) === 1, "dock: only the session from the terminal has the terminal mark");
      const mark = termRow.locator(".terminal-mark");
      check((await mark.getAttribute("title")) === "started in the terminal" && (await mark.textContent()) === ">_" && (await mark.isVisible()), "a quiet glyph whose tooltip says 'started in the terminal'");
      await openList(t.page);
      await termRow.click();
      await t.page.locator(".msg.assistant", { hasText: "hello from the terminal" }).waitFor();
      await t.page.locator("#more").click();
      const resumeItem = t.page.locator(".menu:not([hidden]) .menu-item", { hasText: "Continue in terminal" });
      check(await resumeItem.isVisible(), "the dock's session head offers 'Continue in terminal' in its \"…\"");
      await resumeItem.click();
      await t.page.locator(".panel-head .session-status", { hasText: "Copied" }).waitFor();
      const copied = await t.page.evaluate(() => navigator.clipboard.readText());
      check(copied === `cd ${work} && claude --resume term-1`, `it copies the command that continues it, and says Copied (${copied})`);
      // A turn arrives from the terminal.
      const typedThere = "typed in the terminal";
      transcripts.write("term-1", work, [userEntry(typedThere)]);
      await t.page.locator(".panel-head .session-status", { hasText: "in terminal" }).waitFor();
      check(true, "a turn arriving from the terminal: the head says 'in terminal'");
      await t.page.locator(".msg.user", { hasText: typedThere }).waitFor();
      check(!(await t.page.locator("#reply-text").isDisabled()) && (await t.page.locator("#reply-text").getAttribute("placeholder")) !== "Working. You can reply when this turn ends.", "the reply box stays on, without the usual running hint");
      await t.settle("open");
      await t.fits("open");
      await t.shot("open-terminal-turn");
      const box = t.page.locator("#reply-text");
      const here = "and this from the dock";
      await box.click();
      await box.fill(here);
      await box.press("Enter");
      const anyway = t.page.locator("#reply-hint button", { hasText: "Send anyway" });
      await anyway.waitFor();
      check((await t.page.locator("#reply-hint").textContent())?.startsWith("It looks open in a terminal.") && (await box.inputValue()) === here, "a reply answered 409 'open in a terminal' says so inline, and the typed text is kept");
      await t.settle("open");
      await t.fits("open");
      await t.shot("open-send-anyway");
      const bodies: unknown[] = [];
      t.page.on("request", (req: Any) => {
        if (req.method() === "POST" && req.url().endsWith("/messages")) bodies.push(req.postDataJSON());
      });
      await anyway.click();
      await t.page.locator(".msg.assistant:not(.streaming)", { hasText: `You said: ${here}` }).waitFor();
      check(JSON.stringify(bodies) === JSON.stringify([{ prompt: here, force: true }]), "'Send anyway' repeats the request with force: true, and it goes through");
      await t.page.waitForFunction(() => document.querySelector(".panel-head .session-status")?.textContent === "");
      check(true, "and the head no longer says 'in terminal'");
    } finally {
      await t.context.close();
      await term.stop();
    }
    // The 409 above was asked for: the browser logs every refused request.
    for (let i = pageErrors.length - 1; i >= 0; i--) if (/409 \(Conflict\)/.test(pageErrors[i]!)) pageErrors.splice(i, 1);
  }

  // ================= the keyboard: typing at once, hotkeys, the session remembered (D0036) =================
  {
    const kb = await dock("dark");
    const { page: p } = kb;
    await p.goto(`${runner.url}/dock`);
    await p.locator("#pill").waitFor();
    // Calm first: a session of an earlier part that finishes now would peek, and the dock rightly opens on news.
    await p.waitForFunction(() => document.getElementById("pill")?.dataset.tone !== "running" && document.getElementById("peek")!.hidden, undefined, { timeout: 30000 });
    await kb.settle("idle");
    const title = () => p.locator("#title").textContent() as Promise<string>;
    await kb.hover();
    await p.locator("#panel").waitFor();
    await kb.settle("open");
    await p.locator("#reply-text:not([disabled])").waitFor();
    check(await p.evaluate(() => document.activeElement?.id === "reply-text"), "opening puts the keyboard in the reply box");
    await p.keyboard.type("typed at once");
    check((await p.locator("#reply-text").inputValue()) === "typed at once", "and what is typed lands there, without a click");
    await p.locator("#reply-text").fill("");
    // A box the dock focused itself does not hold the dock open: leaving still closes it.
    await kb.leave();
    await p.locator("#pill").waitFor({ timeout: 3000 });
    await kb.settle("idle");
    check(true, "a box focused by the dock, with nothing typed, does not keep it open when the pointer leaves");

    await kb.hover();
    await p.locator("#panel").waitFor();
    await kb.settle("open");
    const rowsTitles = await p.locator(".sessions .row-title").allTextContents();
    const first = await title();
    await p.keyboard.press("Alt+ArrowDown");
    await p.waitForFunction((t: string) => document.getElementById("title")?.textContent !== t, first);
    const second = await title();
    check(rowsTitles.indexOf(second) === rowsTitles.indexOf(first) + 1, `Alt+Down shows the next session in the list ('${first}' to '${second}')`);
    check(await p.evaluate(() => document.activeElement?.id === "reply-text" || (document.getElementById("reply-text") as HTMLTextAreaElement).disabled), "and the keyboard stays in the reply box");
    await p.keyboard.press("Alt+ArrowUp");
    await p.waitForFunction((t: string) => document.getElementById("title")?.textContent === t, first);
    check(true, "Alt+Up goes back up");
    await p.keyboard.press("Alt+ArrowDown");
    await p.waitForFunction((t: string) => document.getElementById("title")?.textContent === t, second);
    // ⌘K opens the switch with the keyboard in its find; typing narrows the rows, Enter shows the first.
    await p.keyboard.press("ControlOrMeta+K");
    await p.locator("#sessions-list:not([hidden])").waitFor();
    check(await p.evaluate(() => document.activeElement?.id === "find"), "⌘K opens the switch with the keyboard in its find field");
    await kb.settle("open");
    await p.waitForTimeout(600);
    await kb.shot("open-switch");
    const target = rowsTitles.find((t: string) => t !== second && t.length > 3)!;
    await p.keyboard.type(target.slice(0, Math.min(12, target.length)));
    await p.waitForFunction(() => document.querySelectorAll(".sessions .session-row[data-active]").length === 1);
    const narrowed = await p.locator(".sessions .row-title").allTextContents();
    check(narrowed.includes(target) && narrowed.length <= rowsTitles.length, `typing narrows the switch ('${target}' among ${narrowed.length})`);
    await p.keyboard.press("Enter");
    await p.waitForFunction((t: string) => document.getElementById("title")?.textContent === t && document.getElementById("sessions-list")!.hidden, narrowed[0]!);
    check(await p.evaluate(() => document.activeElement?.id === "reply-text" || (document.getElementById("reply-text") as HTMLTextAreaElement).disabled), "Enter shows it, closes the switch and puts the keyboard back in the reply");
    // ⌘2: the second row of the switch, with it closed.
    const order = await p.locator(".sessions .row-title").allTextContents();
    await p.keyboard.press("ControlOrMeta+2");
    await p.waitForFunction((t: string) => document.getElementById("title")?.textContent === t, order[1]!);
    check(true, `⌘2 shows the second row of the switch ('${order[1]}')`);
    // Esc in the open switch closes the switch, not the dock.
    await p.keyboard.press("ControlOrMeta+K");
    await p.locator("#sessions-list:not([hidden])").waitFor();
    await p.keyboard.press("Escape");
    await p.locator("#sessions-list").waitFor({ state: "hidden" });
    check(await p.evaluate(() => !document.getElementById("panel")!.hidden), "Esc closes the switch and the dock stays open");
    // Another session at work shows as a dot beside the switch; a press shows it (D0040).
    const askTitle = "please ask me which colour";
    const before = await title();
    await runner.startSession(askTitle);
    // A task just started becomes the notch's session at once.
    await p.waitForFunction((t: string) => document.getElementById("title")?.textContent === t, askTitle);
    check(true, "a task just started is shown in the open dock at once");
    // Back on the one before, the new one is a chip beside the switch while it waits.
    await p.locator(".sessions .session-row", { hasText: before }).evaluate((el: HTMLElement) => el.click());
    await p.waitForFunction((t: string) => document.getElementById("title")?.textContent === t, before);
    await p.locator('#live .live-session[aria-label^="please ask me"] .dot[data-status="waiting_approval"]').waitFor();
    check((await p.locator("#live .live-session").first().getAttribute("aria-label"))?.startsWith("please ask me") === true, "a session that waits for the person is a dot beside the switch, first");
    await kb.settle("open");
    await kb.shot("open-live");
    await p.locator('#live .live-session[aria-label^="please ask me"]').click();
    await p.waitForFunction((t: string) => document.getElementById("title")?.textContent === t, askTitle);
    check((await p.locator('#live .live-session[aria-label^="please ask me"]').count()) === 0, "pressing the dot shows that session, and the one shown has no dot of its own");
    await p.locator(".approval button", { hasText: "Skip" }).click();
    await p.waitForFunction(() => document.getElementById("live")!.hidden);
    check(true, "skipped, it is no longer at work and the dots are gone");
    check((await p.locator("#reply-text").inputValue()) === "", "no hotkey typed a character into the box");
    // The one shown when it closes: after a switch to another workspace, one of that workspace's.
    const leftOn = await title();
    await kb.leave();
    await p.locator("#pill").waitFor({ timeout: 3000 });
    await kb.settle("idle");
    await kb.hover();
    await p.locator("#panel").waitFor();
    await kb.settle("open");
    check((await title()) === leftOn, `opened again, the dock shows the session it was left on ('${leftOn}')`);
    // A draft holds the dock open while it has the keyboard; once another window has it, the dock
    // closes as the pointer is away (nothing the person presses reaches it any more), keeping the draft.
    await p.keyboard.type("a draft");
    await kb.leave();
    await p.waitForTimeout(800);
    check((await p.locator("#island").getAttribute("data-state")) === "open", "with a draft and the keyboard, the dock stays open when the pointer leaves");
    // Playwright keeps every page "focused" (its focus emulation): the window losing the keyboard is played here.
    await p.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event("blur"));
    });
    await p.locator("#pill").waitFor({ timeout: 3000 });
    await kb.settle("idle");
    check(true, "once another window has the keyboard, the dock with a draft closes");
    await p.evaluate(() => {
      // @ts-expect-error: back to the document's own hasFocus.
      delete document.hasFocus;
    });
    await kb.hover();
    await p.locator("#panel").waitFor();
    await kb.settle("open");
    check((await p.locator("#reply-text").inputValue()) === "a draft", "and the draft is there when it opens again");
    await p.locator("#reply-text").fill("");
    await kb.leave();
    await p.locator("#pill").waitFor({ timeout: 3000 });
    await kb.context.close();
  }

  // ================= out of a Mac's notch (D0035) =================
  for (const scheme of ["dark", "light"] as const) {
    const notch = { width: 179, height: 32 };
    const n = await dock(scheme, { notch });
    await n.page.goto(`${runner.url}/dock?notch=${notch.width}x${notch.height}`);
    await n.page.locator("#pill").waitFor();
    await n.page.evaluate(() => document.fonts.ready);
    await n.settle("idle");
    const black = await n.page.evaluate(() => [getComputedStyle(document.getElementById("island")!).backgroundColor, getComputedStyle(document.querySelector("#island > .surface")!).backgroundColor]);
    check(black.every((c: string) => c === "rgb(0, 0, 0)"), `${scheme}, out of the notch: the island is the notch's opaque black (${black.join(", ")})`);
    if ((await n.page.locator("#pill").getAttribute("data-tone")) === "none") {
      const quiet = await n.shape();
      check(quiet.width === notch.width && quiet.height === notch.height, `${scheme}, out of the notch, nothing going on: the island is the notch itself, ${quiet.width}x${quiet.height}`);
      await n.shot("notch-idle-nothing", false);
    }
    // The open and the close out of the notch, frame by frame, to be looked at.
    if (scheme === "dark") {
      await strip(n, "notch-open", "open", n.hover, [0, 40, 80, 120, 160, 200, 240, 280, 320, 360]);
      await strip(n, "notch-close", "idle", async () => {
        await n.leave();
        await n.page.waitForTimeout(450);
      }, [0, 30, 60, 90, 120, 160, 200, 240, 290, 340]);
    }
    const title = `Out of the notch, ${scheme}`;
    await runner.startSession(title);
    await n.page.locator("#pill-text", { hasText: "running" }).waitFor();
    await n.settle("idle");
    await n.fits("idle");
    // The dot in the left wing, the words in the right one: nothing under the notch, which hides it.
    const wings = await n.page.evaluate((w: number) => {
      const mid = window.innerWidth / 2;
      const dot = document.getElementById("pill-dot")!.getBoundingClientRect();
      const words = document.getElementById("pill-text")!.getBoundingClientRect();
      return { left: dot.right <= mid - w / 2, right: words.left >= mid + w / 2 };
    }, notch.width);
    check(wings.left && wings.right, `${scheme}, out of the notch, something running: the dot is left of the notch and the words right of it (${JSON.stringify(wings)})`);
    await n.shot("notch-idle-running", false);
    await n.page.locator("#peek-title", { hasText: title }).waitFor();
    await n.settle("peek");
    await n.fits("peek");
    const peekTop = await n.page.evaluate(() => document.getElementById("peek")!.getBoundingClientRect().top);
    check(peekTop >= notch.height, `${scheme}, out of the notch: the peek's line starts below the notch's band, at ${peekTop}px`);
    await n.shot("notch-peek", false);
    await n.hover();
    await n.page.locator("#panel").waitFor();
    await n.settle("open");
    await n.fits("open");
    const headTop = await n.page.evaluate(() => document.querySelector(".panel-head")!.getBoundingClientRect().top);
    check(headTop >= notch.height, `${scheme}, out of the notch: the open panel starts below the notch's band, at ${headTop}px`);
    await n.shot("notch-open");
    await n.leave();
    await n.page.locator("#pill").waitFor();
    await n.settle("idle");
    await n.context.close();
  }

  // ================= the chat: the notch grown large, one click away (D0042) =================
  {
    // A session longer than the open dock draws (its last RECENT_EVENTS): the chat has all of it.
    const longTitle = "turn 1 of a long one";
    const long = await runner.startSession(longTitle);
    const api = async (path: string, body?: unknown) => (await fetch(`${runner.url}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json() as Promise<Any>;
    const status = async () => ((await api("/api/sessions")).sessions as { id: string; status: string }[]).find((s) => s.id === long.id)?.status;
    const turnEnds = async () => {
      for (let i = 0; i < 100 && (await status()) !== "idle"; i++) await new Promise((r) => setTimeout(r, 100));
    };
    await turnEnds();
    for (let turn = 2; ((await api(`/api/sessions/${long.id}/events`)).events as unknown[]).length <= RECENT_EVENTS + 4; turn++) {
      await api(`/api/sessions/${long.id}/messages`, { prompt: `turn ${turn} of a long one` });
      await turnEnds();
    }
    const total = ((await api(`/api/sessions/${long.id}/events`)).events as { kind: string }[]);
    const users = total.filter((e) => e.kind === "user").length;
    check(total.length > RECENT_EVENTS, `a session of ${total.length} events, ${users} of them the person's: more than the open dock draws (${RECENT_EVENTS})`);

    for (const [scheme, notch] of [["dark", { width: 179, height: 32 }], ["light", { width: 179, height: 32 }], ["dark", null]] as const) {
      const where = `${scheme}, ${notch ? "out of the notch" : "without a notch"}`;
      const c = await dock(scheme, { notch });
      const { page: p } = c;
      await p.goto(`${runner.url}/dock${notch ? `?notch=${notch.width}x${notch.height}` : ""}`);
      await p.locator("#pill").waitFor();
      await p.evaluate(() => document.fonts.ready);
      await c.settle("idle");
      // The chat's page is loaded and laid out from the start, out of sight: nothing of it is seen or reached.
      await p.waitForFunction(() => ((document.getElementById("chat-frame") as HTMLIFrameElement).contentWindow as Any)?.holmEmbed !== undefined);
      check(await p.evaluate(() => {
        const chat = document.getElementById("chat")!;
        return chat.inert && getComputedStyle(chat).visibility === "hidden" && chat.getBoundingClientRect().height > 400;
      }), `${where}: the chat's page is loaded from the start, laid out at its size, out of sight and inert`);

      // ---- one click: on the idle notch, before the hover has opened anything ----
      const top = Math.max(4, Math.floor((notch?.height ?? DOCK_SIZES.idle.height) / 2));
      const clickedAt = Date.now();
      await p.mouse.click(c.middle, top);
      await c.settle("chat");
      const states = (await c.calls()).map((x) => x.state);
      check(states.at(-1) === "chat" && Date.now() - clickedAt < 2000, `${where}: one click on the notch grows it into the chat (${states.slice(-3).join(" → ")})`);
      const grown = await c.fits("chat");
      check(Math.abs(grown.width - DOCK_SIZES.chat.width) <= 0.5 && Math.abs(grown.height - DOCK_SIZES.chat.height) <= 0.5, `${where}: the chat is the island grown to ${grown.width}x${grown.height}, the window's whole size`);
      const frame = p.frameLocator("#chat-frame");
      check(await p.evaluate(() => document.activeElement?.id === "chat-frame"), `${where}: the keyboard is in the chat`);
      // The colour: the notch's own black (or the dock's dark glass) shows through the chat's page.
      const through = await p.evaluate(() => {
        const doc = (document.getElementById("chat-frame") as HTMLIFrameElement).contentDocument!;
        return [getComputedStyle(doc.body).backgroundColor, getComputedStyle(doc.querySelector(".sidebar")!).backgroundColor, getComputedStyle(doc.documentElement).colorScheme];
      });
      check(through[0] === "rgba(0, 0, 0, 0)" && through[1] === "rgba(0, 0, 0, 0)" && through[2] === "dark", `${where}: the chat's page draws no ground of its own (${through.join(", ")})`);
      if (notch) {
        const frameTop = await p.evaluate(() => document.getElementById("chat-frame")!.getBoundingClientRect().top);
        check(frameTop >= notch.height, `${where}: the chat starts below the notch's band, at ${frameTop}px`);
      }

      // ---- what the chat view gives: the sessions, grouped and searchable, the whole conversation ----
      await frame.locator(".session-title", { hasText: longTitle }).click();
      await frame.locator("#title", { hasText: longTitle }).waitFor();
      await frame.locator(".msg.user", { hasText: "turn 1 of a long one" }).first().waitFor();
      const shownUsers = await frame.locator(".msg.user").count();
      check(shownUsers === users, `${where}: the chat shows the whole conversation, all ${shownUsers} of the person's messages, from the first`);
      check((await frame.locator(".group-head:not([hidden])").count()) >= 2 && (await frame.locator("#search").isVisible()) && (await frame.locator("#reply-text").isVisible()),
        `${where}: with the sessions grouped by workspace, the search, and the reply box`);
      await frame.locator("#scroller").evaluate((el: Element) => (el.scrollTop = el.scrollHeight));
      await p.waitForTimeout(150);
      await c.shot(notch ? "chat-notch" : "chat");
      await frame.locator("#search").fill("turn");
      check((await frame.locator(".session-title").allTextContents()).join("|") === longTitle, `${where}: the search finds a session by a word of its title (${(await frame.locator(".session-title").allTextContents()).join(" | ")})`);
      await frame.locator("#search").fill("");
      // A link that would leave the page opens a window of the shell, never inside the island.
      check((await frame.locator("a.new-task").getAttribute("target")) === "_blank" && (await frame.locator("a.settings-link").getAttribute("target")) === "_blank", `${where}: New task and Settings open as windows, not inside the island`);

      // ---- Esc steps down, one step at a time ----
      await frame.locator("#reply-text").focus();
      await p.keyboard.press("Escape");
      await c.settle("open");
      check((await c.lastCall()).state === "open" && (await p.locator("#title").textContent()) === longTitle, `${where}: Esc steps back down to the open dock, on the session the chat showed`);
      const dockUsers = await p.locator("#stream .msg.user").count();
      check(dockUsers < users, `${where}: which draws only the newest of it (${dockUsers} of ${users} messages)`);
      await c.fits("open");
      // Stepped down, the pointer is where the chat was, off the small dock: it stays until Esc, not closing under the person's eyes.
      await p.mouse.move(c.middle, DOCK_SIZES.open.height + 120);
      await p.waitForTimeout(700);
      check((await c.lastCall()).state === "open", `${where}: the open dock stays after stepping down, with the pointer below it`);
      await p.keyboard.press("Escape");
      await c.settle("idle");
      check((await c.lastCall()).state === "idle", `${where}: a second Esc closes it`);

      // ---- from the open dock: its head, or the notch's band over it ----
      await c.hover();
      await p.locator("#panel").waitFor();
      await c.settle("open");
      await p.mouse.click(c.middle, notch ? Math.floor(notch.height / 2) : 4);
      await c.settle("chat");
      check((await c.lastCall()).state === "chat", `${where}: a click on the ${notch ? "notch's band" : "head"} of the open dock grows it into the chat`);
      // The collapse button inside the chat steps down too, and the head's button grows it again.
      await frame.locator("#collapse").click();
      await c.settle("open");
      check((await c.lastCall()).state === "open", `${where}: the chat's own button steps back down`);
      await p.locator("#expand").click();
      await c.settle("chat");
      check((await c.lastCall()).state === "chat", `${where}: the head's button grows it into the chat again`);

      // ---- the motion, both ways: never outside the chat's rectangle, always hanging from the top, no blank frame ----
      await p.keyboard.press("Escape");
      await c.settle("open");
      const up = await recorded(c, "chat", () => p.locator("#expand").click());
      const down = await recorded(c, "open", () => p.keyboard.press("Escape"));
      for (const [name, frames] of [["growing into the chat", up], ["stepping back down", down]] as const) {
        const outside = frames.filter((f) => f.width > DOCK_SIZES.chat.width + 0.5 || f.height > DOCK_SIZES.chat.height + 0.5);
        const blank = frames.filter((f) => f.height === 0 || f.width === 0);
        const loose = frames.filter((f) => !f.hung);
        check(outside.length === 0 && blank.length === 0 && loose.length === 0, `${where}, ${name}: ${frames.length} frames, every one inside the chat's rectangle, drawn, and hanging from the top edge (worst frame ${worst(frames).toFixed(1)} ms)`);
      }
      const heights = up.map((f) => f.height);
      const widths = up.map((f) => f.width);
      const firstTall = heights.findIndex((h) => h >= DOCK_SIZES.chat.height * 0.9);
      const firstWide = widths.findIndex((w) => w >= DOCK_SIZES.chat.width * 0.9);
      check(firstTall >= 0 && firstWide >= 0 && firstTall <= firstWide, `${where}: growing, it reaches its height before its width: down first, then out (frame ${firstTall} and ${firstWide})`);

      // ---- the shell's Open chat (tray, links): straight from idle, on a session ----
      await p.keyboard.press("Escape");
      await c.settle("idle");
      await p.evaluate((id: string) => (window as Any).__onChat(id), first.id);
      await c.settle("chat");
      await frame.locator("#title", { hasText: prompt }).waitFor();
      check((await c.lastCall()).state === "chat", `${where}: the shell's Open chat grows it from idle, on the session it names`);
      // A press beside it, where the window lets the click through to the app below (here: the page around a smaller test window is the island's) is the shell's.
      await p.keyboard.press("Escape");
      await c.settle("open");
      await p.keyboard.press("Escape");
      await c.settle("idle");
      if (scheme === "dark" && notch) {
        // Frame by frame, to be looked at: the open dock growing into the chat, and back down.
        await c.hover();
        await c.settle("open");
        await strip(c, "chat-open", "chat", () => p.locator("#expand").click(), [0, 40, 80, 120, 160, 200, 260, 320, 400, 520]);
        await strip(c, "chat-close", "open", () => p.keyboard.press("Escape"), [0, 40, 80, 120, 160, 200, 260, 320, 400, 520]);
        await p.keyboard.press("Escape");
        await c.settle("idle");
      }
      await c.context.close();
    }
  }

  // ================= a normal browser: no bridge =================
  const b = await dock("light", { bridge: false, scale: 1 });
  await b.page.goto(`${runner.url}/dock`);
  await b.page.locator("#pill").waitFor();
  await b.settle("idle");
  const islandBox = () => b.page.locator("#island").evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  }) as Promise<number[]>;
  check((await islandBox()).join() === [(1000 - DOCK_WINDOW.width) / 2, 0, DOCK_WINDOW.width, DOCK_WINDOW.height].join(), "without the bridge the island's box hangs from the top of the page, in the middle");
  await b.fits("idle");
  await b.page.mouse.move(500, 10);
  await b.page.locator("#panel").waitFor();
  await b.settle("open");
  await b.fits("open");
  check(true, "and opens on hover just the same");
  // A press beside the open dock: here the page around the island; in the shell, the clear part of the window under a short panel.
  const draft = b.page.locator("#reply-text");
  await b.page.locator("#reply-text:not([disabled])").waitFor();
  await draft.fill("a draft that stays");
  await b.page.waitForTimeout(600);
  const pressedAt = Date.now();
  await b.page.mouse.click(900, 650);
  await b.page.locator('#island[data-state="idle"]').waitFor();
  check(Date.now() - pressedAt < 380, "a press beside the open dock closes it at once, even with text in the box");
  await b.settle("idle");
  await b.page.mouse.move(500, 10);
  await b.page.locator("#panel").waitFor();
  await b.settle("open");
  check((await draft.inputValue()) === "a draft that stays", "and the draft is still there when it opens again");
  await draft.fill("");
  await b.page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await b.page.mouse.move(900, 650);
  await b.page.locator("#pill").waitFor();
  await b.settle("idle");
  check(true, "and closes when the pointer leaves the island");
  await b.shot("browser", false);
  await b.context.close();

  const elsewhere = requested.filter((u) => !/^(?:data|blob|about):/.test(u) && new URL(u).hostname !== "127.0.0.1");
  check(requested.length > 0 && elsewhere.length === 0, `no request left 127.0.0.1 (${elsewhere.join(" ") || "none did"})`);
  check(pageErrors.length === 0, `the page logged no errors (${pageErrors.join(" | ") || "none"})`);
  console.log(`dock-ui: passed (${passed.length} checks)`);
} catch (e) {
  failed = true;
  console.error(`dock-ui: FAILED. ${(e as Error).message}`);
} finally {
  await browser.close();
  await runner.stop();
}
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
