// The pop-up prompt page: the runner serves it, and its pure helpers.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
// A plain JavaScript module with no types: imported by a computed path, so tsc leaves it alone.
const modulePath = join(WEB, "prompt.js");
const { cleanPaste, isLongPaste, pastedLabel, serializeParts, LONG_PASTE_LINES, LONG_PASTE_CHARS } = (await import(join(WEB, "composer.js"))) as {
  cleanPaste(text: unknown): string;
  isLongPaste(text: string): boolean;
  pastedLabel(text: string): string;
  serializeParts(parts: ({ kind: "text" | "paste"; text: string } | { kind: "image"; path: string })[]): { prompt: string; images: string[] };
  LONG_PASTE_LINES: number;
  LONG_PASTE_CHARS: number;
};
const { initialWorkspace, noWorkspaceText, workspaceDigit, errorText, UNREACHABLE, sessionBody } = (await import(modulePath)) as {
  sessionBody(workspace: string, prompt: string, images?: string[], agent?: string | null): { workspace: string; prompt: string; images?: string[]; agent?: string };
  initialWorkspace(workspaces: { name: string; exists: boolean }[], lastUsed: string | null): string | null;
  noWorkspaceText(workspaces: unknown[]): string;
  workspaceDigit(event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; code?: string; key?: string }, mac?: boolean): number | null;
  errorText(status: number, body: unknown): string;
  UNREACHABLE: string;
};

describe("the runner serves the pop-up", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("/prompt is the page, with the task box and the workspace row, and no clipboard attachment (D0056)", async () => {
    const res = await runner.get("/prompt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="workspaces"');
    expect(html).not.toContain('id="clipboard"');
    expect(html).toMatch(/<div id="task" class="task empty" role="textbox" aria-multiline="true"/);
  });

  test("everything the page loads is served", async () => {
    const html = await (await runner.get("/prompt")).text();
    const assets = [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);
    // The font is preloaded: the pop-up opens often, and its first paint should be in its own type.
    expect(assets.sort()).toEqual(["/assets/base.css", "/assets/fonts/geist-latin.woff2", "/assets/mark.svg", "/assets/prompt.css", "/assets/prompt.js", "/assets/theme.js"]);
    for (const asset of assets) {
      const res = await runner.get(asset);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(asset.endsWith(".js") ? "javascript" : asset.endsWith(".woff2") ? "font/woff2" : asset.endsWith(".svg") ? "image/svg+xml" : "text/css");
    }
    expect(await (await runner.get("/assets/prompt.js")).text()).toContain("/api/sessions");
  });
});

// That prompt.css has no colours or sizes of its own is test/web/design.test.ts.

describe("noWorkspaceText", () => {
  test("with none, it says to add one in Settings; with only missing folders, to fix their paths", () => {
    expect(noWorkspaceText([])).toBe("no workspaces yet: add one in Settings, from the tray menu");
    expect(noWorkspaceText([{ name: "gone", exists: false }])).toContain("fix the paths in Settings");
  });
});

describe("initialWorkspace", () => {
  const list = [
    { name: "gone", exists: false },
    { name: "a", exists: true },
    { name: "b", exists: true },
  ];
  test("is the last one used", () => expect(initialWorkspace(list, "b")).toBe("b"));
  test("is the first that exists when none was used", () => expect(initialWorkspace(list, null)).toBe("a"));
  test("is the first that exists when the last one's folder is gone, or it is no longer listed", () => {
    expect(initialWorkspace(list, "gone")).toBe("a");
    expect(initialWorkspace(list, "removed")).toBe("a");
  });
  test("is null when no folder exists", () => {
    expect(initialWorkspace([{ name: "gone", exists: false }], "gone")).toBeNull();
    expect(initialWorkspace([], null)).toBeNull();
  });
});

describe("workspaceDigit", () => {
  test("⌘1..9 on a Mac and Ctrl+1..9 elsewhere is a position from 0", () => {
    expect(workspaceDigit({ metaKey: true, code: "Digit1", key: "1" }, true)).toBe(0);
    expect(workspaceDigit({ metaKey: true, code: "Digit9", key: "9" }, true)).toBe(8);
    expect(workspaceDigit({ ctrlKey: true, code: "Numpad3", key: "3" }, false)).toBe(2);
  });
  test("reads the physical key, and falls back to the character when there is no code", () => {
    expect(workspaceDigit({ metaKey: true, code: "Digit2", key: "é" }, true)).toBe(1);
    expect(workspaceDigit({ metaKey: true, key: "4" }, true)).toBe(3);
  });
  test("Option+2 is @ on a Finnish Mac: Alt+digit is the person's, never a hotkey", () => {
    expect(workspaceDigit({ altKey: true, code: "Digit2", key: "@" }, true)).toBeNull();
    expect(workspaceDigit({ altKey: true, code: "Digit2", key: "@" }, false)).toBeNull();
  });
  test("is null for the other platform's key, with Shift or Alt too, and for other keys", () => {
    expect(workspaceDigit({ ctrlKey: true, code: "Digit1", key: "1" }, true)).toBeNull();
    expect(workspaceDigit({ metaKey: true, code: "Digit1", key: "1" }, false)).toBeNull();
    expect(workspaceDigit({ metaKey: true, shiftKey: true, code: "Digit1", key: "!" }, true)).toBeNull();
    expect(workspaceDigit({ metaKey: true, altKey: true, code: "Digit1", key: "1" }, true)).toBeNull();
    expect(workspaceDigit({ metaKey: true, code: "Digit0", key: "0" }, true)).toBeNull();
    expect(workspaceDigit({ metaKey: true, code: "KeyA", key: "a" }, true)).toBeNull();
  });
});

describe("errorText", () => {
  test("is the runner's error text", () => expect(errorText(400, { error: 'unknown workspace "x"' })).toBe('unknown workspace "x"'));
  test("names the status when the answer has no error text", () => {
    expect(errorText(500, null)).toBe("the runner answered 500");
    expect(errorText(502, { error: 7 })).toBe("the runner answered 502");
    expect(errorText(400, { error: "  " })).toBe("the runner answered 400");
  });
  test("the line for a runner that doesn't answer", () => expect(UNREACHABLE).toBe("the runner is not reachable"));
});

describe("sessionBody", () => {
  test("is the task, its pictures when there are any, and the agent on the switch", () => {
    expect(sessionBody("work", "Do it", [], "codex")).toEqual({ workspace: "work", prompt: "Do it", agent: "codex" });
    expect(sessionBody("work", "Look at [Image #1]", ["/data/images/a.png"], "claude")).toEqual({ workspace: "work", prompt: "Look at [Image #1]", images: ["/data/images/a.png"], agent: "claude" });
    expect(sessionBody("work", "Do it")).toEqual({ workspace: "work", prompt: "Do it" });
    expect(sessionBody("work", "Do it", [], "gpt")).toEqual({ workspace: "work", prompt: "Do it" });
  });
});

describe("the task box (composer.js, D0056)", () => {
  test("a paste is plain text: Windows and old Mac line ends become new lines, and one final newline goes", () => {
    expect(cleanPaste("a\r\nb\rc\n")).toBe("a\nb\nc");
    expect(cleanPaste("one\n\n")).toBe("one\n");
    expect(cleanPaste(undefined)).toBe("");
  });

  test("a paste of more than 8 lines, or 1200 characters, becomes a chip", () => {
    expect(LONG_PASTE_LINES).toBe(8);
    expect(LONG_PASTE_CHARS).toBe(1200);
    expect(isLongPaste(Array(8).fill("x").join("\n"))).toBe(false);
    expect(isLongPaste(Array(9).fill("x").join("\n"))).toBe(true);
    expect(isLongPaste("x".repeat(1200))).toBe(false);
    expect(isLongPaste("x".repeat(1201))).toBe(true);
  });

  test("a chip says how much it holds", () => {
    expect(pastedLabel(Array(42).fill("x").join("\n"))).toBe("Pasted text · 42 lines");
    expect(pastedLabel("x".repeat(4321))).toBe("Pasted text · 4,321 characters");
  });

  test("what is sent: the text in order, each picture as [Image #n] in its place, each pasted text in full, the paths in order", () => {
    const sent = serializeParts([
      { kind: "text", text: "Compare " },
      { kind: "image", path: "/i/a.png" },
      { kind: "text", text: " and " },
      { kind: "image", path: "/i/b.png" },
      { kind: "text", text: " against​ this:\n" },
      { kind: "paste", text: "line 1\nline 2" },
    ]);
    expect(sent).toEqual({ prompt: "Compare [Image #1] and [Image #2] against this:\nline 1\nline 2", images: ["/i/a.png", "/i/b.png"] });
    expect(serializeParts([])).toEqual({ prompt: "", images: [] });
  });

  test("the page: no clipboard of its own; the box a plain-text editable that takes paste and drop, and the window fits it", () => {
    const page = readFileSync(join(WEB, "prompt.js"), "utf8");
    expect(page).not.toMatch(/api\/clipboard|attachment/);
    expect(page).toContain("window.cleatPopup.fit(pick.offsetHeight + task.scrollHeight + foot.offsetHeight)");
    const box = readFileSync(join(WEB, "composer.js"), "utf8");
    expect(box).toContain('box.contentEditable = "plaintext-only"');
    for (const event of ["paste", "drop", "dragover", "input"]) expect(box).toContain(`addEventListener("${event}"`);
    // Untrusted text is never markup: a paste goes in as text, a chip is built from its parts.
    expect(box).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|insertHTML|DOMParser/);
    expect(box).toContain('doc.execCommand("insertText", false, text)');
  });
});
