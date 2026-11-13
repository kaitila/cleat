// The dock: its files are served by the runner, its pure logic (what the pill says, the peek queue,
// when it may close) does what the page relies on, its sizes are the shell's, and its sources keep
// the rule a reader can't see on the page: untrusted text never becomes markup.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOCK_SIZES as SHELL_SIZES, DOCK_STATES } from "../../shell/src/dock";
import {
  CLOSE_MS,
  DOCK_SIZES,
  PEEK_MAX,
  PEEK_MS,
  RECENT_EVENTS,
  asPeek,
  enqueue,
  mayClose,
  nextPeek,
  peekLabel,
  peekOver,
  peekStatus,
  pillOf,
  preselect,
  recentEvents,
  resizeOrder,
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
    expect(imports("dock.js")).toEqual(["chat-format.js", "dock-state.js"]);
    expect(imports("dock-state.js")).toEqual(["chat-format.js"]);
    for (const file of [...imports("dock.js"), ...imports("dock-state.js")]) expect((await runner.get(`/assets/${file}`)).status).toBe(200);
  });

  test("the page passes the port's guard like every route: another origin is refused", async () => {
    const res = await fetch(`${runner.url}/dock`, { headers: { origin: "https://example.com" } });
    expect(res.status).toBe(403);
  });
});

describe("the contract with the shell", () => {
  test("the page's three sizes are the shell's", () => {
    expect(Object.keys(DOCK_SIZES)).toEqual([...DOCK_STATES]);
    expect(DOCK_SIZES).toEqual(SHELL_SIZES);
    expect(DOCK_SIZES).toEqual({ idle: { width: 280, height: 40 }, peek: { width: 420, height: 76 }, open: { width: 460, height: 600 } });
  });

  test("growing, the shell is told before the island animates; shrinking, after", () => {
    expect(resizeOrder("idle", "peek")).toBe("before");
    expect(resizeOrder("idle", "open")).toBe("before");
    expect(resizeOrder("peek", "open")).toBe("before");
    expect(resizeOrder("open", "idle")).toBe("after");
    expect(resizeOrder("open", "peek")).toBe("after");
    expect(resizeOrder("peek", "idle")).toBe("after");
    for (const state of DOCK_STATES) expect(resizeOrder(state, state)).toBe("same");
  });

  test("the bridge is used for setState and nothing else, and the page works without it", () => {
    const js = noComments(source("dock.js"));
    expect(js.match(/intuitionDock[?.\w]*/g)).toEqual(["intuitionDock?.setState"]);
  });

  test("the links open new windows on /prompt and /?session=<id>, which the shell turns into the pop-up and the chat window", () => {
    const html = source("dock.html");
    expect(html).toMatch(/<a class="[^"]*" href="\/prompt" target="_blank" rel="noopener">New task<\/a>/);
    expect(html).toMatch(/<a id="open-chat" class="[^"]*" href="\/" target="_blank" rel="noopener">Open in chat<\/a>/);
    expect(source("dock.js")).toContain("els.openChat.href = `/?session=${encodeURIComponent(session.id)}`");
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

  test("else the newest that waits for approval", () => {
    expect(preselect(sessions, null, "peeked")).toBe("waits");
    expect(preselect([...sessions, session("waits2", "waiting_approval", 5)], null, null)).toBe("waits2");
  });

  test("else the one that peeked last, else the newest", () => {
    const calm = sessions.filter((s) => s.id !== "waits");
    expect(preselect(calm, null, "peeked")).toBe("peeked");
    expect(preselect(calm, null, null)).toBe("new");
    expect(preselect(calm, "gone", "gone too")).toBe("new");
    expect(preselect([], null, null)).toBeNull();
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
    expect(source("dock.html")).toMatch(/<html lang="en" class="dark">/);
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
