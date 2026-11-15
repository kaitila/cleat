// The pop-up prompt page: the runner serves it, and its pure helpers.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
// A plain JavaScript module with no types: imported by a computed path, so tsc leaves it alone.
const modulePath = join(WEB, "prompt.js");
type Attachment = { capturedAt: string; kind: "image"; imagePath: string } | { capturedAt: string; kind: "text"; text: string };
const { initialWorkspace, noWorkspaceText, altDigit, errorText, UNREACHABLE, attachmentOf, preview, sessionBody, FRESH_MS, CLIPBOARD_POLLS } = (await import(modulePath)) as {
  attachmentOf(capture: unknown, now?: number): Attachment | null;
  preview(text: string): string;
  sessionBody(workspace: string, task: string, attachment: Attachment | null): { workspace: string; prompt: string; imagePath?: string };
  FRESH_MS: number;
  CLIPBOARD_POLLS: number[];
  initialWorkspace(workspaces: { name: string; exists: boolean }[], lastUsed: string | null): string | null;
  noWorkspaceText(workspaces: unknown[]): string;
  altDigit(event: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; code?: string; key?: string }): number | null;
  errorText(status: number, body: unknown): string;
  UNREACHABLE: string;
};

describe("the runner serves the pop-up", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("/prompt is the page, with the task box, the workspace row and the hidden clipboard element", async () => {
    const res = await runner.get("/prompt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="task"');
    expect(html).toContain('id="workspaces"');
    expect(html).toMatch(/<div id="clipboard"[^>]*\shidden>\s*<\/div>/);
  });

  test("everything the page loads is served", async () => {
    const html = await (await runner.get("/prompt")).text();
    const assets = [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((m) => m[1]!);
    // The font is preloaded: the pop-up opens often, and its first paint should be in its own type.
    expect(assets.sort()).toEqual(["/assets/base.css", "/assets/fonts/inter-latin.woff2", "/assets/prompt.css", "/assets/prompt.js", "/assets/theme.js"]);
    for (const asset of assets) {
      const res = await runner.get(asset);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(asset.endsWith(".js") ? "javascript" : asset.endsWith(".woff2") ? "font/woff2" : "text/css");
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

describe("altDigit", () => {
  test("Alt+1..9 is a position from 0", () => {
    expect(altDigit({ altKey: true, code: "Digit1", key: "1" })).toBe(0);
    expect(altDigit({ altKey: true, code: "Digit9", key: "9" })).toBe(8);
    expect(altDigit({ altKey: true, code: "Numpad3", key: "3" })).toBe(2);
  });
  test("reads the physical key when Alt changes the character", () => {
    expect(altDigit({ altKey: true, code: "Digit2", key: "@" })).toBe(1);
  });
  test("falls back to the character when there is no code", () => {
    expect(altDigit({ altKey: true, key: "4" })).toBe(3);
  });
  test("is null without Alt, with Ctrl or Meta, and for other keys", () => {
    expect(altDigit({ altKey: false, code: "Digit1", key: "1" })).toBeNull();
    expect(altDigit({ altKey: true, ctrlKey: true, code: "Digit1", key: "1" })).toBeNull();
    expect(altDigit({ altKey: true, metaKey: true, code: "Digit1", key: "1" })).toBeNull();
    expect(altDigit({ altKey: true, code: "Digit0", key: "0" })).toBeNull();
    expect(altDigit({ altKey: true, code: "KeyA", key: "a" })).toBeNull();
    expect(altDigit({ altKey: true, code: "Enter", key: "Enter" })).toBeNull();
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

describe("attachmentOf", () => {
  const now = Date.parse("2026-11-13T10:00:30.000Z");
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

  test("a capture from the last 30 seconds is attached: its text, or its image", () => {
    expect(FRESH_MS).toBe(30_000);
    expect(attachmentOf({ capturedAt: at(1), text: "copied" }, now)).toEqual({ capturedAt: at(1), kind: "text", text: "copied" });
    expect(attachmentOf({ capturedAt: at(30), imagePath: "/mnt/c/a.png" }, now)).toEqual({ capturedAt: at(30), kind: "image", imagePath: "/mnt/c/a.png" });
  });
  test("an image wins over text", () => {
    expect(attachmentOf({ capturedAt: at(1), text: "copied", imagePath: "/mnt/c/a.png" }, now)?.kind).toBe("image");
  });
  test("an older capture is not attached", () => {
    expect(attachmentOf({ capturedAt: at(31), text: "copied" }, now)).toBeNull();
    expect(attachmentOf({ capturedAt: at(3600), imagePath: "/mnt/c/a.png" }, now)).toBeNull();
  });
  test("nothing is attached for no capture, an empty one, or one without a readable time", () => {
    expect(attachmentOf({}, now)).toBeNull();
    expect(attachmentOf(null, now)).toBeNull();
    expect(attachmentOf({ capturedAt: at(1) }, now)).toBeNull();
    expect(attachmentOf({ capturedAt: at(1), text: "  \n " }, now)).toBeNull();
    expect(attachmentOf({ capturedAt: "soon", text: "copied" }, now)).toBeNull();
    expect(attachmentOf({ capturedAt: at(-60), text: "copied" }, now)).toBeNull();
    expect(attachmentOf({ text: "copied" }, now)).toBeNull();
  });
  test("the page asks on load and a few more times over the first two seconds", () => {
    expect(CLIPBOARD_POLLS[0]).toBe(0);
    expect(CLIPBOARD_POLLS.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...CLIPBOARD_POLLS)).toBe(2000);
  });
});

describe("preview", () => {
  test("is the first two lines with something on them", () => {
    expect(preview("\n  one  \n\ntwo\nthree")).toBe("one\ntwo");
    expect(preview("only")).toBe("only");
    expect(preview("a\r\nb\r\nc")).toBe("a\nb");
  });
  test("cuts a long line", () => expect(preview("x".repeat(5000))).toHaveLength(200));
});

describe("sessionBody", () => {
  test("without an attachment it is the task", () => {
    expect(sessionBody("work", "Do it", null)).toEqual({ workspace: "work", prompt: "Do it" });
  });
  test("an attached image goes as imagePath", () => {
    expect(sessionBody("work", "Do it", { capturedAt: "t", kind: "image", imagePath: "/mnt/c/a.png" })).toEqual({ workspace: "work", prompt: "Do it", imagePath: "/mnt/c/a.png" });
  });
  test("attached text goes after the task, under a line 'Clipboard:'", () => {
    expect(sessionBody("work", "Explain this\n", { capturedAt: "t", kind: "text", text: "line 1\nline 2" })).toEqual({
      workspace: "work",
      prompt: "Explain this\n\nClipboard:\nline 1\nline 2",
    });
  });
});
