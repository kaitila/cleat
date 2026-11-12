// The pop-up prompt page: the runner serves it, and its pure helpers.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
// A plain JavaScript module with no types: imported by a computed path, so tsc leaves it alone.
const modulePath = join(WEB, "prompt.js");
const { initialWorkspace, altDigit, errorText, UNREACHABLE } = (await import(modulePath)) as {
  initialWorkspace(workspaces: { name: string; exists: boolean }[], lastUsed: string | null): string | null;
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
    expect(assets.sort()).toEqual(["/assets/base.css", "/assets/prompt.css", "/assets/prompt.js"]);
    for (const asset of assets) {
      const res = await runner.get(asset);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(asset.endsWith(".js") ? "javascript" : "text/css");
    }
    expect(await (await runner.get("/assets/prompt.js")).text()).toContain("/api/sessions");
  });
});

describe("prompt.css", () => {
  const css = readFileSync(join(WEB, "prompt.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  test("has no colours of its own", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix|color)\(/i);
    for (const [, value] of css.matchAll(/(?:^|[;{\s])(?:color|background|background-color|border-color|outline-color)\s*:\s*([^;}]+)/g)) {
      expect(value!.trim()).toMatch(/^(?:var\(--[a-z-]+\)|transparent|inherit|none)$/);
    }
    for (const [, value] of css.matchAll(/(?:^|[;{\s])(?:border|outline)\s*:\s*([^;}]+)/g)) {
      expect(value!.trim()).toMatch(/^(?:none|\d+px solid (?:var\(--[a-z-]+\)|transparent))$/);
    }
  });

  test("has no font sizes of its own", () => {
    const sizes = [...css.matchAll(/font-size\s*:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toMatch(/^var\(--text-[sml]\)$/);
    expect(css).not.toMatch(/(?:^|[;{\s])font\s*:/);
  });

  test("uses only tokens that base.css defines", () => {
    const base = readFileSync(join(WEB, "base.css"), "utf8");
    for (const [, token] of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect(base).toContain(`${token}:`);
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
