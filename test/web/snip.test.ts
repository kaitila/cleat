// The snip overlay page: the runner serves it, and the maths of the selection and of where the
// prompt box goes (src/web/snip-geometry.js, no DOM).
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cropPlan, toPixels } from "../../shell/src/snip";
import {
  altDigit, anchorBox, anchorLabel, CLICK_SLOP, devicePixels, errorText, GAP, initialWorkspace, isClick, selectionOf, sessionBody, sizeText, stepWorkspace, wholeDisplay,
} from "../../src/web/snip-geometry.js";
import { testRunner } from "../runner/helpers";

const WEB = join(import.meta.dir, "..", "..", "src", "web");
const source = (file: string) => readFileSync(join(WEB, file), "utf8");

describe("the runner serves the snip page", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  test("/assets/snip.html is the page, with the frozen image, the shade, the selection and the hidden box", async () => {
    const res = await runner.get("/assets/snip.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const id of ["frozen", "shade", "selection", "size", "box", "task", "workspace", "status"]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/<form id="box"[^>]*\shidden>/);
    for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) expect(url).toMatch(/^\/(?!\/)/);
  });

  test("every module it imports is served, and the page needs nothing else from the runner", async () => {
    const imports = (file: string) => [...source(file).matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!);
    expect(imports("snip.js")).toEqual(["agent.js", "snip-geometry.js"]);
    expect(imports("snip-geometry.js")).toEqual([]);
    expect(imports("agent.js")).toEqual([]);
    for (const file of ["snip.js", "snip-geometry.js", "agent.js"]) {
      const res = await runner.get(`/assets/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
    }
    expect((await runner.get("/assets/snip.css")).headers.get("content-type")).toContain("text/css");
    // The runner's two calls, as the pop-up makes them; the rest is the shell's bridge.
    expect([...source("snip.js").matchAll(/api\("([^"]+)"/g)].map((m) => m[1])).toEqual(["/api/workspaces", "/api/sessions"]);
    expect([...new Set([...source("snip.js").matchAll(/bridge\??\.(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["close", "crop", "getCapture"]);
  });

  test("the geometry module touches no DOM", () => {
    const code = source("snip-geometry.js").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(?:document|window|navigator|getComputedStyle|addEventListener)\b/);
  });
});

const screen = { width: 1920, height: 1080 };
const box = { width: 400, height: 80 };

describe("the selection", () => {
  test("a drag in any direction is the rectangle between its ends", () => {
    const want = { x: 100, y: 200, width: 300, height: 150 };
    expect(selectionOf({ x: 100, y: 200 }, { x: 400, y: 350 }, screen)).toEqual(want);
    expect(selectionOf({ x: 400, y: 350 }, { x: 100, y: 200 }, screen)).toEqual(want);
    expect(selectionOf({ x: 400, y: 200 }, { x: 100, y: 350 }, screen)).toEqual(want);
    expect(selectionOf({ x: 100, y: 350 }, { x: 400, y: 200 }, screen)).toEqual(want);
  });

  test("a drag past the edge stops at the display's edge", () => {
    expect(selectionOf({ x: 1800, y: 1000 }, { x: 2500, y: 1400 }, screen)).toEqual({ x: 1800, y: 1000, width: 120, height: 80 });
    expect(selectionOf({ x: 50, y: 40 }, { x: -30, y: -10 }, screen)).toEqual({ x: 0, y: 0, width: 50, height: 40 });
  });

  test("a press that hardly moves is a click, which takes the whole display", () => {
    expect(isClick({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(isClick({ x: 10, y: 10 }, { x: 10 + CLICK_SLOP - 1, y: 10 - CLICK_SLOP + 1 })).toBe(true);
    expect(isClick({ x: 10, y: 10 }, { x: 10 + CLICK_SLOP, y: 10 })).toBe(false);
    expect(isClick({ x: 10, y: 10 }, { x: 10, y: 10 - CLICK_SLOP })).toBe(false);
    expect(wholeDisplay(screen)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  test("its size in device pixels, at every scale, is the size the shell saves", () => {
    const sel = { x: 10.5, y: 20.25, width: 101, height: 49.5 };
    expect(devicePixels(sel, 1, screen)).toEqual({ x: 10, y: 20, width: 102, height: 50 });
    expect(devicePixels(sel, 1.25, screen)).toEqual({ x: 13, y: 25, width: 127, height: 63 });
    expect(devicePixels(sel, 1.5, screen)).toEqual({ x: 15, y: 30, width: 153, height: 75 });
    expect(devicePixels(sel, 2, screen)).toEqual({ x: 21, y: 40, width: 202, height: 100 });
    expect(devicePixels(wholeDisplay(screen), 1.5, screen)).toEqual({ x: 0, y: 0, width: 2880, height: 1620 });
    expect(sizeText({ width: 2880, height: 1620 })).toBe("2880 × 1620");
    // The page's rule and the shell's are one rule.
    for (const ratio of [1, 1.25, 1.5, 1.75, 2, 3]) {
      for (const s of [sel, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 1917.3, y: 1077.9, width: 2.7, height: 2.1 }, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }]) {
        const native = { width: Math.round(screen.width * ratio), height: Math.round(screen.height * ratio) };
        expect(devicePixels(s, ratio, screen)).toEqual(toPixels(s, ratio, native));
        const { output } = cropPlan(s, screen, ratio, native);
        expect({ width: devicePixels(s, ratio, screen).width, height: devicePixels(s, ratio, screen).height }).toEqual(output);
      }
    }
  });
});

describe("where the prompt box goes", () => {
  const inside = (at: { x: number; y: number }) => at.x >= 0 && at.y >= 0 && at.x + box.width <= screen.width && at.y + box.height <= screen.height;

  test("below the selection, centred on it, in the middle of the screen", () => {
    expect(anchorBox({ x: 500, y: 300, width: 600, height: 200 }, box, screen)).toEqual({ placement: "below", x: 800 - box.width / 2, y: 500 + GAP });
    // A selection narrower than the box: the box still centres on it, wider on both sides.
    const narrow = anchorBox({ x: 900, y: 300, width: 40, height: 40 }, box, screen);
    expect(narrow.x + box.width / 2).toBe(920);
  });

  test("an odd half pixel is rounded, so the box sits on whole pixels", () => {
    expect(Number.isInteger(anchorBox({ x: 501, y: 300, width: 601, height: 200 }, box, screen).x)).toBe(true);
  });

  test("at each edge and corner it stays on the screen", () => {
    const cases: [string, { x: number; y: number; width: number; height: number }, string][] = [
      ["top left", { x: 0, y: 0, width: 300, height: 200 }, "below"],
      ["top edge", { x: 800, y: 0, width: 300, height: 200 }, "below"],
      ["top right", { x: 1700, y: 0, width: 220, height: 200 }, "below"],
      ["right edge", { x: 1800, y: 400, width: 120, height: 200 }, "below"],
      ["left edge", { x: 0, y: 400, width: 120, height: 200 }, "below"],
      ["bottom left", { x: 0, y: 900, width: 300, height: 180 }, "above"],
      ["bottom edge", { x: 800, y: 950, width: 300, height: 130 }, "above"],
      ["bottom right", { x: 1700, y: 900, width: 220, height: 180 }, "above"],
      ["the whole screen", { x: 0, y: 0, width: 1920, height: 1080 }, "inside"],
      ["a tall strip on the left", { x: 0, y: 0, width: 200, height: 1080 }, "inside"],
      ["a tall strip on the right", { x: 1800, y: 0, width: 120, height: 1080 }, "inside"],
    ];
    for (const [name, sel, placement] of cases) {
      const at = anchorBox(sel, box, screen);
      expect({ name, placement: at.placement as string, onScreen: inside(at) }).toEqual({ name, placement, onScreen: true });
      // GAP from the screen's edges.
      expect({ name, ok: at.x >= GAP && at.y >= GAP && at.x + box.width <= screen.width - GAP && at.y + box.height <= screen.height - GAP }).toEqual({ name, ok: true });
    }
  });

  test("above and below it centres on the selection unless that would leave the screen", () => {
    const right = anchorBox({ x: 1700, y: 100, width: 220, height: 100 }, box, screen);
    expect(right.x).toBe(screen.width - box.width - GAP);
    const left = anchorBox({ x: 10, y: 100, width: 60, height: 100 }, box, screen);
    expect(left.x).toBe(GAP);
    const above = anchorBox({ x: 600, y: 900, width: 300, height: 180 }, box, screen);
    expect(above).toEqual({ placement: "above", x: 750 - box.width / 2, y: 900 - GAP - box.height });
  });

  test("inside, it sits at the selection's bottom, centred", () => {
    expect(anchorBox({ x: 0, y: 0, width: 1920, height: 1080 }, box, screen)).toEqual({ placement: "inside", x: 760, y: 1080 - GAP - box.height });
  });

  test("a box larger than the screen is put at its top left rather than off it", () => {
    const at = anchorBox({ x: 0, y: 0, width: 300, height: 300 }, { width: 400, height: 80 }, { width: 380, height: 200 });
    expect(at.x).toBe(0);
    expect(at.y).toBeGreaterThanOrEqual(0);
  });
});

describe("where the size label goes", () => {
  const label = { width: 80, height: 18 };
  test("just above the top left corner, or inside it when there is no room or the box is above", () => {
    expect(anchorLabel({ x: 500, y: 300, width: 200, height: 100 }, label, screen)).toEqual({ x: 500, y: 300 - GAP / 2 - label.height, inside: false });
    expect(anchorLabel({ x: 500, y: 5, width: 200, height: 100 }, label, screen)).toEqual({ x: 500 + GAP / 2, y: 5 + GAP / 2, inside: true });
    expect(anchorLabel({ x: 500, y: 900, width: 200, height: 100 }, label, screen, "above").inside).toBe(true);
    expect(anchorLabel({ x: 1900, y: 300, width: 20, height: 100 }, label, screen).x).toBe(screen.width - label.width);
  });
});

describe("the workspace chip and the keys", () => {
  const workspaces = [{ name: "gone", exists: false }, { name: "alpha", exists: true }, { name: "beta", exists: true }];

  test("the last used workspace first, else the first that exists", () => {
    expect(initialWorkspace(workspaces, "beta")).toBe("beta");
    expect(initialWorkspace(workspaces, "gone")).toBe("alpha");
    expect(initialWorkspace(workspaces, null)).toBe("alpha");
    expect(initialWorkspace([{ name: "gone", exists: false }], null)).toBeNull();
  });

  test("Tab goes to the next workspace that exists, round; Shift+Tab back", () => {
    expect(stepWorkspace(workspaces, "alpha", 1)).toBe("beta");
    expect(stepWorkspace(workspaces, "beta", 1)).toBe("alpha");
    expect(stepWorkspace(workspaces, "alpha", -1)).toBe("beta");
    expect(stepWorkspace(workspaces, null, 1)).toBe("alpha");
    expect(stepWorkspace([{ name: "gone", exists: false }], null, 1)).toBeNull();
  });

  test("Alt+1..9 by the physical key", () => {
    expect(altDigit({ altKey: true, code: "Digit3", key: "#" })).toBe(2);
    expect(altDigit({ altKey: true, code: "Numpad1" })).toBe(0);
    expect(altDigit({ altKey: true, key: "9" })).toBe(8);
    expect(altDigit({ altKey: false, code: "Digit3" })).toBeNull();
    expect(altDigit({ altKey: true, ctrlKey: true, code: "Digit3" })).toBeNull();
    expect(altDigit({ altKey: true, code: "Digit0" })).toBeNull();
  });

  test("an error is the runner's own text, and the session body carries the snip's path", () => {
    expect(errorText(400, { error: " imagePath is refused " })).toBe("imagePath is refused");
    expect(errorText(500, null)).toBe("the runner answered 500");
    expect(sessionBody("alpha", "what is this", "C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\snip-1.png")).toEqual({ workspace: "alpha", prompt: "what is this", imagePath: "C:\\Users\\x\\AppData\\Local\\Temp\\intuition\\snip-1.png" });
    expect(sessionBody("alpha", "what is this", "/tmp/s.png", "codex")).toEqual({ workspace: "alpha", prompt: "what is this", imagePath: "/tmp/s.png", agent: "codex" });
    expect(sessionBody("alpha", "what is this", "/tmp/s.png", "gpt")).toEqual({ workspace: "alpha", prompt: "what is this", imagePath: "/tmp/s.png" });
  });

  test("the box has the agent switch beside the workspace, and its key in the hints", () => {
    const html = source("snip.html");
    expect(html).toMatch(/id="workspace"[\s\S]*<button id="agent" class="agent-switch[^"]*" type="button" aria-keyshortcuts="Alt\+A">/);
    expect(html).toContain("<kbd>Alt</kbd><kbd>A</kbd><span>agent</span>");
  });
});
