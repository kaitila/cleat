// The pure rules of managing sessions in the pages (src/web/chat-manage.js, D0020): which sessions
// a list shows and in what order, what a session's menu offers, and what the delete confirmation says.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { archivedLine, canDelete, canFork, canStop, deleteConfirm, FOLDED_KEY, grouped, isFolded, menuItems, ordered, readFolded, showHeadings, visible, workspacesOf, writeFolded } from "../../src/web/chat-manage.js";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 15, 12, minutes)).toISOString();
const s = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "idle", updatedAt: at(0), title: id, workspace: "work", source: "intuition", claudeSessionId: `c-${id}`, ...extra });

describe("the list", () => {
  test("pinned first, then the newest activity first", () => {
    const list = [s("old", { updatedAt: at(1) }), s("new", { updatedAt: at(9) }), s("pinned-old", { updatedAt: at(0), pinned: true }), s("pinned-new", { updatedAt: at(5), pinned: true })];
    expect(ordered(list).map((x) => x.id)).toEqual(["pinned-new", "pinned-old", "new", "old"]);
  });

  test("archived sessions only in the Archived view, and the others only outside it", () => {
    const list = [s("a"), s("b", { archived: true })];
    expect(visible(list).map((x) => x.id)).toEqual(["a"]);
    expect(visible(list, { archived: true }).map((x) => x.id)).toEqual(["b"]);
  });

  test("search: every word in the title or the workspace, ignoring case; the workspace filter", () => {
    const list = [s("Fix the Login page", { workspace: "web" }), s("Login API", { workspace: "api" }), s("Docs", { workspace: "web" })];
    expect(visible(list, { query: "login" }).map((x) => x.id).sort()).toEqual(["Fix the Login page", "Login API"]);
    expect(visible(list, { query: "LOGIN web" }).map((x) => x.id)).toEqual(["Fix the Login page"]);
    expect(visible(list, { query: "  " }).length).toBe(3);
    expect(visible(list, { workspace: "web" }).map((x) => x.id).sort()).toEqual(["Docs", "Fix the Login page"]);
    expect(visible(list, { workspace: "web", query: "docs" }).map((x) => x.id)).toEqual(["Docs"]);
    expect(workspacesOf(list)).toEqual(["api", "web"]);
  });
});

describe("the sidebar's groups (D0033)", () => {
  test("one group per workspace, ordered by its newest session; in a group pinned first, then the newest", () => {
    const list = [
      s("web-old", { workspace: "web", updatedAt: at(1) }),
      s("api-new", { workspace: "api", updatedAt: at(9) }),
      s("web-pinned", { workspace: "web", updatedAt: at(0), pinned: true }),
      s("web-new", { workspace: "web", updatedAt: at(5) }),
      s("api-old", { workspace: "api", updatedAt: at(2) }),
    ];
    const groups = grouped(list);
    expect(groups.map((g) => g.workspace)).toEqual(["api", "web"]);
    expect(groups.map((g) => g.sessions.map((x) => x.id))).toEqual([["api-new", "api-old"], ["web-pinned", "web-new", "web-old"]]);
    // A pinned session's own time counts for its group's place.
    expect(grouped([...list, s("web-pin-newest", { workspace: "web", updatedAt: at(20), pinned: true })])[0]!.workspace).toBe("web");
    expect(grouped([])).toEqual([]);
  });

  test("headings only with more than one workspace in the list shown, and none with a workspace chosen", () => {
    const two = [s("a", { workspace: "web" }), s("b", { workspace: "api" })];
    expect(showHeadings(two)).toBe(true);
    expect(showHeadings(two, { workspace: "web" })).toBe(false);
    expect(showHeadings([s("a"), s("b")])).toBe(false);
    // The Archived view counts its own workspaces.
    expect(showHeadings([...two, s("c", { archived: true })], { archived: true })).toBe(false);
  });

  test("folded: the remembered folds, none without headings, and while searching only those folded for that search", () => {
    const folded = new Set(["web"]);
    const searchFolded = new Set(["api"]);
    expect(isFolded("web", { folded, searchFolded })).toBe(true);
    expect(isFolded("api", { folded, searchFolded })).toBe(false);
    expect(isFolded("web", { folded, searchFolded, headings: false })).toBe(false);
    expect(isFolded("web", { folded, searchFolded, query: "login" })).toBe(false);
    expect(isFolded("api", { folded, searchFolded, query: "login" })).toBe(true);
    expect(isFolded("web", { folded, searchFolded, query: "  " })).toBe(true);
  });

  test("the folds are remembered in storage, and a storage that throws or holds junk is no fold", () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
    writeFolded(storage, new Set(["web", "api"]));
    expect(memory.get(FOLDED_KEY)).toBe('["api","web"]');
    expect([...readFolded(storage)].sort()).toEqual(["api", "web"]);
    writeFolded(storage, new Set());
    expect(memory.has(FOLDED_KEY)).toBe(false);
    memory.set(FOLDED_KEY, "{not json");
    expect(readFolded(storage).size).toBe(0);
    memory.set(FOLDED_KEY, '[1, "web", null]');
    expect([...readFolded(storage)]).toEqual(["web"]);
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(readFolded(refusing).size).toBe(0);
    expect(() => writeFolded(refusing, new Set(["web"]))).not.toThrow();
    expect(readFolded(undefined).size).toBe(0);
  });
});

describe("what a session offers", () => {
  test("Stop only while the runner runs its turn, not one arriving from a terminal", () => {
    expect(canStop(s("a", { status: "running" }))).toBe(true);
    expect(canStop(s("a", { status: "waiting_approval" }))).toBe(true);
    expect(canStop(s("a", { status: "running", terminalTurn: true }))).toBe(false);
    expect(canStop(s("a"))).toBe(false);
  });

  test("Delete only for a session intuition started, between turns; a terminal session has no Delete at all", () => {
    expect(canDelete(s("a"))).toBe(true);
    expect(canDelete(s("a", { status: "error" }))).toBe(true);
    expect(canDelete(s("a", { status: "running" }))).toBe(false);
    expect(canDelete(s("a", { source: "terminal" }))).toBe(false);
    expect(menuItems(s("a", { source: "terminal" })).map((i) => i.action)).toEqual(["rename", "pin", "fork", "archive"]);
    expect(menuItems(s("a")).map((i) => i.action)).toEqual(["rename", "pin", "fork", "archive", "delete"]);
    expect(menuItems(s("a", { status: "running" })).find((i) => i.action === "delete")?.disabled).toBe(true);
  });

  test("Fork needs a conversation between turns", () => {
    expect(canFork(s("a"))).toBe(true);
    expect(canFork(s("a", { claudeSessionId: null }))).toBe(false);
    expect(canFork(s("a", { status: "running" }))).toBe(false);
  });

  test("the labels follow the flags; the dock's menu is Rename, Pin, Archive", () => {
    expect(menuItems(s("a", { pinned: true, archived: true })).map((i) => i.label)).toEqual(["Rename", "Unpin", "Fork", "Unarchive", "Delete"]);
    expect(menuItems(s("a"), false).map((i) => i.label)).toEqual(["Rename", "Pin", "Archive"]);
  });

  test("the delete confirmation names the session, the transcript that goes, and that it can't come back", () => {
    const c = deleteConfirm(s("Fix the bug"));
    expect(c.title).toBe("Delete “Fix the bug”?");
    expect(c.body).toContain("Claude Code transcript");
    expect(c.body).toContain("can't be undone");
    expect(c.body).toContain("archive");
    expect(c.confirm).toBe("Delete");
    expect(archivedLine(s("x", { title: "" }))).toBe("Archived “Untitled”.");
  });
});

test("chat-manage.js puts titles in the page only as text", () => {
  const js = readFileSync(join(import.meta.dir, "..", "..", "src", "web", "chat-manage.js"), "utf8");
  expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
