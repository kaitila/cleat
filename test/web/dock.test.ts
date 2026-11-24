// The dock: its files are served by the runner, its pure logic (what the pill says, the peek queue,
// when it may close) does what the page relies on, its sizes are the shell's, and its sources keep
// the rule a reader can't see on the page: untrusted text never becomes markup.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCK_SIZES as SHELL_SIZES, DOCK_STATES, DOCK_WINDOW as SHELL_WINDOW, dockSizes as shellDockSizes, islandRect as shellIslandRect, NOTCH_WING as SHELL_WING } from "../../shell/src/dock";
import { dockUrl } from "../../shell/src/origin";
import {
  CLOSE_MS,
  DOCK_SIZES,
  DOCK_WINDOW,
  OPEN_MS,
  PEEK_MAX,
  PEEK_MS,
  QUIET_HEIGHT,
  RECENT_EVENTS,
  asPeek,
  dockSizes,
  dockWorkspaces,
  enqueue,
  inWorkspace,
  islandRect,
  islandSize,
  mayClose,
  nextPeek,
  NOTCH_WING,
  onIsland,
  parseNotch,
  peekLabel,
  peekOver,
  peekStatus,
  pillOf,
  preselect,
  SESSION_KEY,
  dockKey,
  dockOrder,
  liveOthers,
  savedSession,
  saveSession,
  stepSession,
  recentEvents,
  savedWorkspace,
  saveWorkspace,
  WORKSPACE_KEY,
  type Peek,
} from "../../src/web/dock-state.js";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const source = (file: string) => readFileSync(join(WEB, file), "utf8");
const noComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 13, 12, 0) - minutesAgo * 60_000).toISOString();
const session = (id: string, status: string, minutesAgo = 0) => ({ id, status, updatedAt: at(minutesAgo) });
const peek = (sessionId: string, kind: Peek["kind"] = "finished", body = "body"): Peek => ({ kind, sessionId, title: `title ${sessionId}`, body });

describe("served by the runner", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("/dock is the dock page and loads its stylesheets and module from /assets", async () => {
    const res = await runner.get("/dock");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const asset of ["/assets/base.css", "/assets/dock.css", "/assets/dock.js"]) expect(html).toContain(asset);
    for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) expect(url).toMatch(/^\/(?!\/)/);
  });

  test("the modules and the stylesheet are served with their types", async () => {
    for (const file of ["dock.js", "dock-state.js", "chat-format.js"]) {
      const res = await runner.get(`/assets/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
    }
    const css = await runner.get("/assets/dock.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  test("every module the dock imports is one the runner serves", async () => {
    const imports = (file: string) => [...source(file).matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!);
    expect(imports("dock.js")).toEqual(["chat-format.js", "chat-manage.js", "markdown.js", "questions.js", "agent.js", "keys.js", "dock-state.js"]);
    expect(imports("dock-state.js")).toEqual(["chat-format.js", "keys.js"]);
    for (const file of [...imports("dock.js"), ...imports("dock-state.js")]) expect((await runner.get(`/assets/${file}`)).status).toBe(200);
  });

  test("the page passes the port's guard like every route: another origin is refused", async () => {
    const res = await fetch(`${runner.url}/dock`, { headers: { origin: "https://example.com" } });
    expect(res.status).toBe(403);
  });
});

describe("the contract with the shell", () => {
  test("the page's window and island sizes are the shell's", () => {
    expect(Object.keys(DOCK_SIZES)).toEqual([...DOCK_STATES]);
    expect(DOCK_SIZES).toEqual(SHELL_SIZES);
    expect(DOCK_WINDOW).toEqual({ ...SHELL_WINDOW });
    expect(DOCK_WINDOW).toEqual({ width: 460, height: 480 });
    expect(DOCK_SIZES).toEqual({ idle: { width: 128, height: 22 }, peek: { width: 380, height: 40 }, open: { width: 460, height: 480 } });
    // The owner's limits: a pill of at most 24, a peek of at most 52, and nothing larger than the window.
    expect(DOCK_SIZES.idle.height).toBeLessThanOrEqual(24);
    expect(QUIET_HEIGHT).toBeLessThan(DOCK_SIZES.idle.height);
    expect(DOCK_SIZES.peek.height).toBeLessThanOrEqual(52);
    for (const state of DOCK_STATES) {
      expect(DOCK_SIZES[state].width).toBeLessThanOrEqual(DOCK_WINDOW.width);
      expect(DOCK_SIZES[state].height).toBeLessThanOrEqual(DOCK_WINDOW.height);
      expect(islandRect(state)).toEqual(shellIslandRect(state));
    }
  });

  test("out of a notch, the page's sizes and rectangles are the shell's, and it reads the notch from the address the shell gives", () => {
    const notch = { width: 179, height: 38 };
    expect(NOTCH_WING).toBe(SHELL_WING);
    expect(parseNotch(new URL(dockUrl("http://127.0.0.1:4777", notch)).search)).toEqual(notch);
    expect(parseNotch("")).toBeNull();
    for (const bad of ["?notch=179", "?notch=179x", "?notch=x38", "?notch=9x38", "?notch=179x8", "?notch=179x99", "?notch=1790x38", "?notch=179.5x38", "?notch=<b>x38"]) expect(parseNotch(bad)).toBeNull();
    expect(dockSizes(null)).toEqual(DOCK_SIZES);
    expect(dockSizes(notch)).toEqual(shellDockSizes(notch));
    for (const state of DOCK_STATES) {
      expect(islandRect(state, notch)).toEqual(shellIslandRect(state, { ...notch, x: 666.5 }));
      expect(dockSizes(notch)[state].width).toBeLessThanOrEqual(DOCK_WINDOW.width);
      expect(dockSizes(notch)[state].height).toBeLessThanOrEqual(DOCK_WINDOW.height);
    }
  });

  test("out of a notch: idle is the notch with nothing going on and the notch with its wings otherwise; peek below the notch's band; the notch is the idle handle", () => {
    const notch = { width: 179, height: 38 };
    expect(islandSize("idle", { pill: 30, quiet: true }, notch)).toEqual(notch);
    expect(islandSize("idle", { pill: 30 }, notch)).toEqual({ width: 179 + 2 * NOTCH_WING, height: 38 });
    expect(islandSize("peek", {}, notch)).toEqual({ width: 380, height: 78 });
    expect(islandSize("open", { panel: 0 }, notch)).toEqual({ width: 460, height: 78 });
    const wings = { width: 179 + 2 * NOTCH_WING, height: 38 };
    expect(onIsland("idle", wings, 0, 20, notch)).toBe(true);
    // On a wing: over the menu bar, where the shell lets the mouse through, so not the island.
    expect(onIsland("idle", wings, 89.5 + NOTCH_WING / 2, 20, notch)).toBe(false);
    expect(onIsland("peek", { width: 380, height: 78 }, 0, 70, notch)).toBe(true);
  });

  test("the island is drawn no larger than its state's rectangle: idle as wide as its words, open as tall as its content", () => {
    expect(islandSize("idle", { pill: 90.2 })).toEqual({ width: 91, height: 22 });
    expect(islandSize("idle", { pill: 500 })).toEqual({ width: 128, height: 22 });
    // Nothing going on: shorter still, and never narrower than it is tall.
    expect(islandSize("idle", { pill: 31, quiet: true })).toEqual({ width: 31, height: QUIET_HEIGHT });
    expect(islandSize("idle", { pill: 0, quiet: true })).toEqual({ width: QUIET_HEIGHT, height: QUIET_HEIGHT });
    expect(islandSize("idle")).toEqual({ width: 22, height: 22 });
    expect(islandSize("peek", { pill: 5, panel: 5 })).toEqual({ width: 380, height: 40 });
    expect(islandSize("open", { panel: 353.4 })).toEqual({ width: 460, height: 354 });
    expect(islandSize("open", { panel: 2000 })).toEqual({ width: 460, height: 480 });
    // Before the panel has a height (or with one that is not a number) it is at least a peek tall.
    expect(islandSize("open", { panel: 0 })).toEqual({ width: 460, height: 40 });
    expect(islandSize("open", { panel: Number.NaN })).toEqual({ width: 460, height: 40 });
  });

  test("the pointer is on the island where it is drawn, and, closed, anywhere in the rectangle the shell takes the mouse in", () => {
    const dot = { width: 31, height: 16 };
    expect(onIsland("idle", dot, 0, 5)).toBe(true);
    // Beside and below the dot, still in the idle rectangle (128x22): the handle.
    expect(onIsland("idle", dot, 60, 20)).toBe(true);
    expect(onIsland("idle", dot, 65, 5)).toBe(false);
    expect(onIsland("idle", dot, 0, 22)).toBe(false);
    expect(onIsland("idle", dot, 0, -1)).toBe(false);
    expect(onIsland("peek", { width: 380, height: 40 }, -190, 39)).toBe(true);
    expect(onIsland("peek", { width: 380, height: 40 }, 0, 40)).toBe(false);
    // Open, only what is drawn: under a short panel the window is clear, and a press there puts the dock away.
    const short = { width: 460, height: 354 };
    expect(onIsland("open", short, 0, 353)).toBe(true);
    expect(onIsland("open", short, 0, 354)).toBe(false);
    expect(onIsland("open", short, 231, 10)).toBe(false);
  });

  test("opening waits for the pointer to rest: about 80 ms", () => {
    expect(OPEN_MS).toBeGreaterThanOrEqual(60);
    expect(OPEN_MS).toBeLessThanOrEqual(120);
  });

  test("a change of state animates the island's own size (its clip) and the content's opacity, transform and clearing blur, and nothing else", () => {
    const css = noComments(source("dock.css"));
    // Every transition names what it moves: the island's size as drawn, which only its clip reads, and its opacity.
    const transitions = [...css.matchAll(/transition:([^;}]*)/g)].map((m) => m[1]!.trim());
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) for (const part of t.split(/,(?![^(]*\))/)) expect(part.trim()).toMatch(/^(--island-w|--island-h|opacity) /);
    // The two sizes are registered lengths, read by the clip-path alone, and inherited by nothing.
    for (const name of ["--island-w", "--island-h"]) expect(css).toMatch(new RegExp(`@property ${name} \\{ syntax: "<length>"; inherits: false;`));
    for (const [, prop] of css.matchAll(/([\w-]+)\s*:[^;{}]*var\(--island-[wh]\)/g)) expect(prop).toBe("clip-path");
    // Every easing and duration of a transition or an animation is a motion token (docs/design.md, "Motion").
    for (const [, value] of css.matchAll(/(?:transition|animation(?:-duration|-timing-function|-delay)?):([^;}]*)/g)) {
      expect(value!.replace(/var\(--(?:ease|ease-gentle|ease-bouncy|ease-soft|ease-snappy|dur-gentle|dur-bouncy|dur-soft|dur-snappy|dur-fade|dur-out|motion|lag|stagger)\)/g, "")).not.toMatch(/\d(?:ms|s)\b|cubic-bezier|linear\(|\b(?:ease|ease-in|ease-out|ease-in-out|linear)\b/);
    }
    expect(css).not.toMatch(/transition-property|transition:\s*all\b/);
    // The keyframes move opacity and transform only, and the fade in clears a blur (the content coming into focus).
    const frames = [...css.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((m) => m[1]!);
    expect(frames.length).toBeGreaterThan(0);
    for (const body of frames) for (const prop of body.matchAll(/([\w-]+)\s*:/g)) expect(["opacity", "transform", "filter"]).toContain(prop[1]!);
    expect(css).toMatch(/@keyframes layer-fade \{ from \{ opacity: 0; filter: var\(--blur-in\); \} \}/);
    // No shadow and no backdrop-filter on the dock: the window is the island's size (a shadow would be
    // cut off) and the frost is the OS's, behind the see-through window (D0028). No filter outside a
    // fade: in, the blur clears; out, it gathers again.
    expect(css).not.toMatch(/box-shadow|backdrop-filter/);
    expect(css).toMatch(/@keyframes layer-out \{ to \{ opacity: 0; transform: scale\(var\(--pop\)\); filter: var\(--blur-in\); \} \}/);
    expect(css.replace(/@keyframes layer-(?:fade|out) \{[^}]*\}/g, "")).not.toMatch(/\bfilter\b/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    // The page never asks the shell for anything but the state: no size, and no call that waits for an animation.
    expect(noComments(source("dock.js"))).not.toMatch(/resizeTo|resizeBy|innerWidth|innerHeight/);
  });

  test("the bridge is used for setState and nothing else, and the page works without it", () => {
    const js = noComments(source("dock.js"));
    expect(js.match(/intuitionDock[?.\w]*/g)).toEqual(["intuitionDock?.setState"]);
  });

  test("the links open new windows on /prompt and /?session=<id>, which the shell turns into the pop-up and the chat window", () => {
    const html = source("dock.html");
    expect(html).toMatch(/<a class="[^"]*" href="\/prompt" target="_blank" rel="noopener">New task<\/a>/);
    // Open in chat is in the head's "…": it opens /?session=<id> the same way, through window.open.
    expect(source("dock.js")).toContain('window.open(`/?session=${encodeURIComponent(id)}`, "_blank", "noopener")');
  });
});

describe("what the pill says", () => {
  test("nothing going on: 'intuition', without a dot", () => {
    expect(pillOf([])).toEqual({ tone: "none", text: "intuition", status: null, failed: false });
    expect(pillOf([session("a", "idle")])).toEqual({ tone: "none", text: "intuition", status: null, failed: false });
  });

  test("running sessions are counted, with the running dot", () => {
    expect(pillOf([session("a", "running"), session("b", "idle", 5)])).toMatchObject({ tone: "running", text: "1 running", status: "running" });
    expect(pillOf([session("a", "running"), session("b", "running"), session("c", "idle")])).toMatchObject({ tone: "running", text: "2 running" });
  });

  test("a session that waits for approval wins over running ones", () => {
    expect(pillOf([session("a", "running"), session("b", "waiting_approval"), session("c", "running")])).toMatchObject({ tone: "needs", text: "needs you", status: "waiting_approval" });
  });

  test("the newest finished one failed: an error mark, alone or beside what is going on", () => {
    expect(pillOf([session("a", "error", 1), session("b", "idle", 9)])).toEqual({ tone: "failed", text: "failed", status: "error", failed: true });
    expect(pillOf([session("a", "error", 9), session("b", "idle", 1)])).toMatchObject({ tone: "none", failed: false });
    expect(pillOf([session("a", "error", 1), session("b", "running")])).toMatchObject({ tone: "running", text: "1 running", failed: true });
    expect(pillOf([session("a", "error", 1), session("b", "waiting_approval")])).toMatchObject({ tone: "needs", failed: true });
  });

  test("it takes any iterable, as the page's Map gives", () => {
    const map = new Map([["a", session("a", "running")]]);
    expect(pillOf(map.values()).text).toBe("1 running");
  });
});

describe("the peek queue", () => {
  test("a notification becomes a peek; anything else is dropped", () => {
    expect(asPeek({ seq: 3, ts: at(0), kind: "finished", sessionId: "a", title: "T", body: "B" })).toEqual({ kind: "finished", sessionId: "a", title: "T", body: "B" });
    expect(asPeek({ kind: "error", sessionId: "a", title: "", body: 5 })).toEqual({ kind: "error", sessionId: "a", title: "Untitled", body: "" });
    for (const bad of [null, undefined, "x", {}, { kind: "other", sessionId: "a" }, { kind: "finished" }, { kind: "finished", sessionId: "" }, { kind: "toString", sessionId: "a" }]) {
      expect(asPeek(bad)).toBeNull();
    }
  });

  test("several queue newest last, at most five: the oldest are dropped", () => {
    let queue: Peek[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) queue = enqueue(queue, peek(id));
    expect(PEEK_MAX).toBe(5);
    expect(queue.map((p) => p.sessionId)).toEqual(["c", "d", "e", "f", "g"]);
  });

  test("a session's newer peek replaces its older one that still waits", () => {
    const queue = enqueue(enqueue(enqueue([], peek("a", "needs_approval")), peek("b")), peek("a", "finished"));
    expect(queue.map((p) => `${p.sessionId}:${p.kind}`)).toEqual(["b:finished", "a:finished"]);
  });

  test("enqueue leaves the queue it was given as it was", () => {
    const queue = [peek("a")];
    enqueue(queue, peek("b"));
    expect(queue).toHaveLength(1);
  });

  test("the next peek is the oldest waiting; an approval already answered is skipped", () => {
    const queue = [peek("a", "needs_approval"), peek("b", "needs_approval"), peek("c")];
    const sessions = [session("a", "running"), session("b", "waiting_approval"), session("c", "idle")];
    const first = nextPeek(queue, sessions);
    expect(first.peek?.sessionId).toBe("b");
    expect(first.queue.map((p) => p.sessionId)).toEqual(["c"]);
    const second = nextPeek(first.queue, sessions);
    expect(second.peek?.sessionId).toBe("c");
    expect(nextPeek(second.queue, sessions)).toEqual({ peek: null, queue: [] });
    expect(nextPeek([peek("gone", "needs_approval")], [])).toEqual({ peek: null, queue: [] });
    expect(queue).toHaveLength(3);
  });

  test("a peek is over after five seconds", () => {
    expect(PEEK_MS).toBe(5000);
    for (const kind of ["finished", "error"] as const) {
      expect(peekOver(peek("a", kind), [session("a", "idle")], 4999)).toBe(false);
      expect(peekOver(peek("a", kind), [session("a", "idle")], 5000)).toBe(true);
    }
  });

  test("one that waits for approval stays until its session no longer waits", () => {
    const waiting = peek("a", "needs_approval");
    expect(peekOver(waiting, [session("a", "waiting_approval")], 60_000)).toBe(false);
    expect(peekOver(waiting, [session("a", "running")], 0)).toBe(true);
    expect(peekOver(waiting, [session("a", "idle")], 0)).toBe(true);
    expect(peekOver(waiting, [], 0)).toBe(true);
  });

  test("the word and the dot of each kind", () => {
    expect(["finished", "needs_approval", "error"].map(peekLabel)).toEqual(["done", "needs you", "failed"]);
    expect(["finished", "needs_approval", "error"].map(peekStatus)).toEqual(["idle", "waiting_approval", "error"]);
  });
});

describe("when the dock may close", () => {
  const free = { pointerInside: false, pointerDown: false, replyFocused: false, replyText: "" };

  test("with the pointer away and nothing typed", () => {
    expect(CLOSE_MS).toBe(400);
    expect(mayClose(free)).toBe(true);
    expect(mayClose({ ...free, replyText: "  \n" })).toBe(true);
    expect(mayClose({ pointerInside: false, pointerDown: false, replyFocused: false })).toBe(true);
  });

  test("not while the pointer is on it or held down", () => {
    expect(mayClose({ ...free, pointerInside: true })).toBe(false);
    expect(mayClose({ ...free, pointerDown: true })).toBe(false);
  });

  test("not while the reply box has the focus or text in it", () => {
    expect(mayClose({ ...free, replyFocused: true })).toBe(false);
    expect(mayClose({ ...free, replyText: "half a reply" })).toBe(false);
  });
});

describe("the session the dock opens on", () => {
  const sessions = [session("old", "idle", 30), session("waits", "waiting_approval", 20), session("peeked", "idle", 10), session("new", "running", 1)];

  test("the one peeking now", () => {
    expect(preselect(sessions, "peeked", null)).toBe("peeked");
    expect(preselect(sessions, "old", "peeked")).toBe("old");
  });

  test("else the one that peeked since it was last open, else the one it was last left on while it is still listed", () => {
    expect(preselect(sessions, null, null, "old")).toBe("old");
    // News wins: the one peeking now, or the one that peeked since.
    expect(preselect(sessions, "peeked", null, "old")).toBe("peeked");
    expect(preselect(sessions, null, "peeked", "old")).toBe("peeked");
    // Gone (archived, or another workspace is shown): the usual pick.
    expect(preselect(sessions, null, null, "gone")).toBe("waits");
  });

  test("it is remembered in the dock's own storage, and a storage that fails remembers nothing", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    expect(savedSession(storage)).toBeNull();
    saveSession(storage, "old");
    expect(map.get(SESSION_KEY)).toBe("old");
    expect(savedSession(storage)).toBe("old");
    saveSession(storage, null);
    expect(savedSession(storage)).toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(savedSession(broken)).toBeNull();
    expect(() => saveSession(broken, "old")).not.toThrow();
    expect(savedSession(null)).toBeNull();
  });

  test("else the newest that waits for approval", () => {
    expect(preselect(sessions, null, null)).toBe("waits");
    expect(preselect([...sessions, session("waits2", "waiting_approval", 5)], null, null)).toBe("waits2");
  });

  test("the one that peeked last wins over one that waits; else the newest", () => {
    expect(preselect(sessions, null, "peeked")).toBe("peeked");
    const calm = sessions.filter((s) => s.id !== "waits");
    expect(preselect(calm, null, "peeked")).toBe("peeked");
    expect(preselect(calm, null, null)).toBe("new");
    expect(preselect(calm, "gone", "gone too")).toBe("new");
    expect(preselect([], null, null)).toBeNull();
  });
});

describe("the open dock's hotkeys", () => {
  test("⌘K opens the switch, ⌘1..9 picks a row of it, Ctrl+Tab and Alt+arrows step; Alt+digit is the person's", () => {
    expect(dockKey({ key: "k", code: "KeyK", metaKey: true }, true)).toEqual({ find: true });
    expect(dockKey({ key: "k", code: "KeyK", ctrlKey: true }, false)).toEqual({ find: true });
    expect(dockKey({ key: "3", code: "Digit3", metaKey: true }, true)).toEqual({ nth: 3 });
    expect(dockKey({ key: "1", code: "Digit1", ctrlKey: true }, false)).toEqual({ nth: 1 });
    expect(dockKey({ key: "Tab", ctrlKey: true }, true)).toEqual({ step: 1 });
    expect(dockKey({ key: "Tab", ctrlKey: true, shiftKey: true }, true)).toEqual({ step: -1 });
    expect(dockKey({ key: "ArrowUp", altKey: true }, true)).toEqual({ step: -1 });
    expect(dockKey({ key: "ArrowDown", altKey: true }, true)).toEqual({ step: 1 });
    // Option+2 is @ on a Finnish Mac, and Option+7..9 are | [ ]: never the dock's.
    for (const e of [
      { key: "@", code: "Digit2", altKey: true },
      { key: "1", code: "Digit1", altKey: true },
      { key: "ArrowUp" },
      { key: "1", code: "Digit1" },
      { key: "1", code: "Digit1", ctrlKey: true },
      { key: "0", code: "Digit0", metaKey: true },
      { key: "ArrowUp", altKey: true, shiftKey: true },
      { key: "ArrowDown", altKey: true, metaKey: true },
      { key: "ArrowUp", altKey: true, isComposing: true },
      { key: "Tab" },
    ]) expect(dockKey(e, true)).toBeNull();
    expect(dockKey(null)).toBeNull();
  });

  test("the dock's order puts the sessions waiting for the person first, then the running ones, then the rest as they were", () => {
    const list = [session("pinned", "idle"), session("new", "idle"), session("run", "running"), session("wait", "waiting_approval"), session("run2", "running")];
    expect(dockOrder(list).map((s) => s.id)).toEqual(["wait", "run", "run2", "pinned", "new"]);
    expect(dockOrder([])).toEqual([]);
  });

  test("the head's other sessions at work leave out the one shown and the idle ones, at most two", () => {
    const order = dockOrder([session("a", "waiting_approval"), session("b", "running"), session("c", "idle"), session("d", "running"), session("e", "running"), session("f", "running"), session("g", "error")]);
    expect(liveOthers(order, "b").map((s) => s.id)).toEqual(["a", "d"]);
    expect(liveOthers(order, null, 4).map((s) => s.id)).toEqual(["a", "b", "d", "e"]);
  });

  test("a step stops at either end of the list; from outside it, down starts at the top and up at the bottom", () => {
    const ids = ["a", "b", "c"];
    expect(stepSession(ids, "b", 1)).toBe("c");
    expect(stepSession(ids, "b", -1)).toBe("a");
    expect(stepSession(ids, "c", 1)).toBe("c");
    expect(stepSession(ids, "a", -1)).toBe("a");
    expect(stepSession(ids, null, 1)).toBe("a");
    expect(stepSession(ids, "gone", -1)).toBe("c");
    expect(stepSession([], "a", 1)).toBeNull();
  });
});

describe("the workspace switch", () => {
  const at = (workspace: string, archived = false) => ({ workspace, archived });

  test("each workspace with a session the dock lists, by name, once", () => {
    expect(dockWorkspaces([at("work"), at("home"), at("work"), at("old", true)])).toEqual(["home", "work"]);
    expect(dockWorkspaces([])).toEqual([]);
  });

  test("and the one chosen, even with none left in it", () => {
    expect(dockWorkspaces([at("work")], "gone")).toEqual(["gone", "work"]);
    expect(dockWorkspaces([at("work")], "")).toEqual(["work"]);
  });

  test("a workspace chosen lists only its sessions; none chosen lists all", () => {
    const all = [{ id: "a", workspace: "work" }, { id: "b", workspace: "home" }, { id: "c", workspace: "work" }];
    expect(inWorkspace(all, "work").map((s) => s.id)).toEqual(["a", "c"]);
    expect(inWorkspace(all, "").map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(inWorkspace(new Map(all.map((s) => [s.id, s])).values(), "home").map((s) => s.id)).toEqual(["b"]);
  });

  test("the choice is remembered, and all of them is remembered as nothing", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
    expect(savedWorkspace(storage)).toBe("");
    saveWorkspace(storage, "work");
    expect(kept.get(WORKSPACE_KEY)).toBe("work");
    expect(savedWorkspace(storage)).toBe("work");
    saveWorkspace(storage, "");
    expect(kept.has(WORKSPACE_KEY)).toBe(false);
    expect(savedWorkspace(storage)).toBe("");
  });

  test("storage that refuses, or none, forgets and throws nothing", () => {
    const refuses = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(savedWorkspace(refuses)).toBe("");
    expect(() => saveWorkspace(refuses, "work")).not.toThrow();
    expect(savedWorkspace(null)).toBe("");
    expect(() => saveWorkspace(undefined, "work")).not.toThrow();
  });
});

describe("the last few events", () => {
  test("only the newest are drawn", () => {
    const events = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(RECENT_EVENTS).toBe(30);
    expect(recentEvents(events)).toEqual(events.slice(70));
    expect(recentEvents([1, 2, 3])).toEqual([1, 2, 3]);
    expect(recentEvents([])).toEqual([]);
  });
});

describe("the sources", () => {
  test("dock-state.js touches no DOM and no network", () => {
    expect(noComments(source("dock-state.js"))).not.toMatch(/\b(?:document|window|fetch|WebSocket|localStorage|navigator|location)\b/);
  });

  test("untrusted text never becomes markup: no innerHTML, no HTML strings, no eval", () => {
    const js = noComments(source("dock.js"));
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|\beval\(|new Function/);
    expect(js).not.toMatch(/["'`]\s*<[a-z]/i);
    expect(js).not.toMatch(/setAttribute\(\s*["'](?:on|href|src|style)/i);
    // Every element is made by h(), which sets its text as textContent.
    expect(js.match(/document\.createElement\(/g)).toHaveLength(1);
    expect(js).toContain("el.textContent = text");
  });

  test("the page is dark in both schemes: .dark in base.css has the dark scheme's own values", () => {
    // On <body>, not <html>: theme.js puts data-theme on <html>, and :root[data-theme="light"]
    // outranks .dark on the same element. On <body> the dark tokens win whatever the theme.
    expect(source("dock.html")).toMatch(/<body class="dark">/);
    expect(source("dock.html")).not.toMatch(/<html[^>]*class=/);
    const base = noComments(source("base.css"));
    const tokens = (block: string) => Object.fromEntries([...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
    const scheme = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/.exec(base);
    const scoped = /\n\.dark \{([^}]*)\}/.exec(base);
    expect(scheme).not.toBeNull();
    expect(scoped).not.toBeNull();
    expect(Object.keys(tokens(scheme![1]!)).length).toBeGreaterThan(12);
    expect(tokens(scoped![1]!)).toEqual(tokens(scheme![1]!));
    expect(scoped![1]).toMatch(/color-scheme:\s*dark;/);
  });
});
