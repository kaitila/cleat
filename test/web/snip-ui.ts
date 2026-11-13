// Drives the snip overlay in headless Chromium as one display at 125% (1280x800 CSS pixels), against
// a runner with the fake agent, with a stand-in for the shell's bridge: getCapture() hands over a
// generated 1600x1000 image, crop(rect) is recorded and answers with a real PNG under the Windows
// temp folder (the runner only takes images under /mnt/<drive>), close() is counted.
// Run it on this machine: `bun test/web/snip-ui.ts`. It uses the playwright installed globally for
// bun, and prints "skipped" and exits 0 without one, or in CI.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { EventsResponse, SessionsResponse } from "../../src/shared/protocol";
import { loadConfig } from "../../src/runner/config";
import { startServer } from "../../src/runner/server";

interface Rect { x: number; y: number; width: number; height: number }
// The little of playwright's API this script uses (the package isn't a dependency, so no types).
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T>;
  waitForFunction(fn: () => unknown, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  close(): Promise<void>;
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>;
  exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>;
  route(url: string, handler: (route: { abort(): Promise<void> }) => unknown): Promise<void>;
  unroute(url: string): Promise<void>;
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
  mouse: { move(x: number, y: number, options?: { steps?: number }): Promise<void>; down(): Promise<void>; up(): Promise<void>; click(x: number, y: number): Promise<void> };
}
interface Browser {
  newContext(options: { viewport: { width: number; height: number }; colorScheme: "light" | "dark"; deviceScaleFactor?: number }): Promise<{
    newPage(): Promise<Page>;
    on(event: "request", listener: (request: { url(): string }) => void): void;
  }>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(options: { headless: boolean }): Promise<Browser> };
}

function skip(why: string): never {
  console.log(`skipped: ${why}`);
  process.exit(0);
}

if (process.env.CI) skip("CI has no browser for this check");
const playwrightPath = join(homedir(), ".bun", "install", "global", "node_modules", "playwright");
let browser: Browser;
try {
  const mod = (await import(playwrightPath)) as Playwright & { default?: Playwright };
  browser = await (mod.chromium ?? mod.default!.chromium).launch({ headless: true });
} catch (e) {
  skip(`no browser is available (${playwrightPath}): ${(e as Error).message.split("\n")[0]}`);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
}

/** An RGB PNG: a made-up desktop, a window and a few blocks of colour, so the screenshots show what the dim and the selection do. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      // A soft blue-grey wallpaper, a light window with a title bar, and a few coloured blocks in it.
      let rgb = [60 + 40 * v, 80 + 30 * u, 120 + 40 * (1 - v)];
      if (u > 0.12 && u < 0.7 && v > 0.1 && v < 0.75) rgb = v < 0.15 ? [225, 226, 230] : [248, 248, 250];
      if (u > 0.16 && u < 0.36 && v > 0.22 && v < 0.4) rgb = [230, 120, 90];
      if (u > 0.4 && u < 0.66 && v > 0.22 && v < 0.27) rgb = [60, 60, 70];
      if (u > 0.4 && u < 0.6 && v > 0.3 && v < 0.33) rgb = [150, 150, 160];
      if (u > 0.16 && u < 0.66 && v > 0.48 && v < 0.7) rgb = [90, 150, 220];
      if (u > 0.75 && u < 0.95 && v > 0.55 && v < 0.9) rgb = [70, 170, 120];
      rows.set(rgb.map(Math.round), row + 1 + x * 3);
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** A folder under a Windows user's temp folder, by its WSL path, for the PNG crop answers with. Null where there is none. */
function windowsTemp(): string | null {
  try {
    const users = "/mnt/c/Users";
    const temp = readdirSync(users).map((u) => join(users, u, "AppData", "Local", "Temp")).find((t) => existsSync(t));
    if (!temp) return null;
    mkdirSync(join(temp, "intuition"), { recursive: true });
    return mkdtempSync(join(temp, "intuition", "snip-ui-"));
  } catch {
    return null;
  }
}

const dir = mkdtempSync(join(tmpdir(), "intuition-snip-ui-"));
for (const name of ["alpha", "beta"]) mkdirSync(join(dir, name));
const env = { INTUITION_CONFIG: join(dir, "config.json"), INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: "0", INTUITION_FAKE_AGENT: "1" };
writeFileSync(env.INTUITION_CONFIG, JSON.stringify({ workspaces: ["gone", "alpha", "beta"].map((name) => ({ name, path: join(dir, name) })) }));
const runner = startServer(loadConfig(env));
const shots = join(dir, "screenshots");
mkdirSync(shots);

const SIZE = { width: 1280, height: 800 };
const SCALE = 1.25;
const capture = `data:image/png;base64,${png(SIZE.width * SCALE, SIZE.height * SCALE).toString("base64")}`;
const folder = windowsTemp();
// What crop answers: the Windows path of a real PNG, as the shell's does.
const cropFile = folder ? join(folder, "snip-20261113-120000-000.png") : null;
if (cropFile) writeFileSync(cropFile, png(8, 8));
const cropAnswer = cropFile ? Bun.spawnSync(["wslpath", "-w", cropFile]).stdout.toString().trim() : null;

const sessions = async () => ((await (await fetch(`${runner.url}/api/sessions`)).json()) as SessionsResponse).sessions;
const userEvents = async (id: string) => ((await (await fetch(`${runner.url}/api/sessions/${id}/events`)).json()) as EventsResponse).events.flatMap((e) => (e.kind === "user" ? [e] : []));
const requested: string[] = [];

/** A page with the stand-in bridge. `crops` and `closes` record what the page asked of it. */
async function open(colorScheme: "light" | "dark", bridge = true) {
  const context = await browser.newContext({ viewport: SIZE, colorScheme, deviceScaleFactor: SCALE });
  context.on("request", (r) => requested.push(r.url()));
  const page = await context.newPage();
  const seen = { crops: [] as Rect[], closes: 0 };
  if (bridge) {
    await page.exposeFunction("__snipCrop", ((rect: Rect) => {
      seen.crops.push(rect);
      if (!cropAnswer) throw new Error("no Windows temp folder");
      return cropAnswer;
    }) as never);
    await page.exposeFunction("__snipClose", (() => {
      seen.closes++;
    }) as never);
    await page.addInitScript((url: string) => {
      const w = window as unknown as Record<string, unknown> & { __snipCrop(r: unknown): Promise<string>; __snipClose(): void };
      w.intuitionSnip = { getCapture: async () => url, crop: (r: unknown) => w.__snipCrop(r), close: () => void w.__snipClose() };
    }, capture);
  }
  await page.goto(`${runner.url}/assets/snip.html`);
  if (bridge) await page.waitForFunction(() => (window as unknown as { snipReady?: Promise<boolean> }).snipReady?.then((ok) => ok));
  await page.waitForFunction(() => document.querySelector("#workspace-name")?.textContent !== "no workspace", undefined, { timeout: 3000 }).catch(() => {});
  return { page, seen };
}

const state = () => {
  const box = document.querySelector<HTMLElement>("#box")!;
  const rect = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    focus: document.activeElement?.id ?? "",
    boxShown: !box.hidden,
    box: rect(box),
    placement: box.dataset.placement ?? "",
    selection: document.querySelector<HTMLElement>("#selection")!.hidden ? null : rect(document.querySelector("#selection")!),
    size: document.querySelector<HTMLElement>("#size")!.hidden ? null : document.querySelector("#size")!.textContent,
    sizeAt: rect(document.querySelector("#size")!),
    hint: document.querySelector<HTMLElement>("#hint")!.hidden ? null : document.querySelector("#hint")!.textContent,
    clip: document.querySelector<HTMLElement>("#shade")!.style.clipPath,
    task: document.querySelector<HTMLTextAreaElement>("#task")!.value,
    workspace: document.querySelector("#workspace-name")!.textContent,
    status: document.querySelector("#status")!.textContent ?? "",
    statusKind: document.querySelector<HTMLElement>("#status")!.dataset.kind ?? "",
    image: document.querySelector<HTMLImageElement>("#frozen")!.naturalWidth,
    overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
    cursor: getComputedStyle(document.body).cursor,
  };
};
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const path = join(shots, `${name}.png`);
  await page.screenshot({ path });
  console.log(`screenshot: ${path}`);
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
const near = (a: number, b: number) => Math.abs(a - b) <= 1;

try {
  if (!cropAnswer) console.log("note: no Windows temp folder under /mnt/c: the sessions can't carry an image, and those checks fail");

  // Light: the frozen screen, then a drag.
  const { page, seen } = await open("light");
  let s = await page.evaluate(state);
  check("the frozen image is the capture, at the display's device pixels", s.image === SIZE.width * SCALE, String(s.image));
  check("before a press: the hint, the whole screen dimmed, no box, a crosshair", s.hint !== null && s.clip === "" && !s.boxShown && s.selection === null && s.cursor === "crosshair", JSON.stringify(s));
  check("nothing scrolls", !s.overflow);
  await shot(page, "light-start");

  await drag(page, { x: 200, y: 150 }, { x: 600, y: 400 });
  s = await page.evaluate(state);
  check("the drag draws the selection where the pointer went", s.selection !== null && near(s.selection.x, 200) && near(s.selection.y, 150) && near(s.selection.width, 400) && near(s.selection.height, 250), JSON.stringify(s.selection));
  check("the selection is cut out of the dim", s.clip.includes("evenodd") && /M\s*200\s+150\s*H\s*600\s*V\s*400\s*H\s*200\s*Z/.test(s.clip), s.clip);
  check("its size is shown in device pixels", s.size === "500 × 313", String(s.size));
  check("the size label sits just above its top left corner", near(s.sizeAt.x, 200) && s.sizeAt.y + s.sizeAt.height <= 150 && s.sizeAt.y > 120, JSON.stringify(s.sizeAt));
  check("on release the box appears below the selection, left edges lined up", s.boxShown && s.placement === "below" && near(s.box.x, 200) && near(s.box.y, 408), JSON.stringify({ placement: s.placement, box: s.box }));
  check("the box has the focus at once", s.focus === "task", s.focus);
  check("the hint is gone", s.hint === null);
  check("the workspace chip shows the first that exists (none used yet)", s.workspace === "alpha", String(s.workspace));
  await shot(page, "light-selected");

  await page.keyboard.type("What is in this area?");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("Be brief.");
  s = await page.evaluate(state);
  check("typing goes into the box, Shift+Enter is a new line, and the box grows", s.task === "What is in this area?\nBe brief." && s.box.height > 80 && seen.crops.length === 0, JSON.stringify({ task: s.task, h: s.box.height }));
  await page.keyboard.press("Tab");
  s = await page.evaluate(state);
  check("Tab switches the workspace, and the focus stays in the box", s.workspace === "beta" && s.focus === "task", `${s.workspace} ${s.focus}`);
  await page.keyboard.press("Alt+1");
  check("Alt+1 can't pick the missing workspace", (await page.evaluate(state)).workspace === "beta");
  await page.keyboard.press("Alt+2");
  check("Alt+2 picks the second", (await page.evaluate(state)).workspace === "alpha");
  await page.keyboard.press("Shift+Tab");
  check("Shift+Tab goes back round", (await page.evaluate(state)).workspace === "beta");
  await shot(page, "light-typed");

  // Dragging again replaces the selection and keeps the text.
  await drag(page, { x: 700, y: 300 }, { x: 300, y: 100 });
  s = await page.evaluate(state);
  check("a second drag replaces the selection, and the text is kept", s.selection !== null && near(s.selection.x, 300) && near(s.selection.y, 100) && near(s.selection.width, 400) && near(s.selection.height, 200) && s.task.startsWith("What is in this area?") && s.focus === "task", JSON.stringify(s.selection));

  // An error: the runner can't be reached. Shown in the box, the text kept, nothing closed.
  await page.route("**/api/sessions", (route) => route.abort());
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#status")!.dataset.kind === "error", undefined, { timeout: 3000 }).catch(() => {});
  s = await page.evaluate(state);
  check("an unreachable runner shows in the box, the text is kept and nothing closes", s.status === "the runner is not reachable" && s.task.startsWith("What is in this area?") && seen.closes === 0, JSON.stringify({ status: s.status, closes: seen.closes }));
  await shot(page, "light-error");
  await page.unroute("**/api/sessions");

  // Enter: crop with the selection, one session with imagePath, then close.
  const before = (await sessions()).length;
  await page.keyboard.press("Enter");
  for (let i = 0; i < 30 && seen.closes === 0; i++) await Bun.sleep(100);
  const list = await sessions();
  check("Enter crops the selection once, in CSS pixels of the display (the shell turns them into device pixels)", seen.crops.length === 1 && JSON.stringify(seen.crops[0]) === JSON.stringify({ x: 300, y: 100, width: 400, height: 200 }), JSON.stringify(seen.crops));
  check("Enter starts one session", list.length === before + 1, `${list.length - before} started`);
  const started = list.find((x) => x.title === "What is in this area?");
  const user = started ? await userEvents(started.id) : [];
  check("in the chosen workspace", started?.workspace === "beta", String(started?.workspace));
  check("with the snip as its imagePath, apart from the text", user[0]?.text === "What is in this area?\nBe brief." && user[0]?.imagePath === cropFile, JSON.stringify(user));
  check("then the overlays close", seen.closes === 1, String(seen.closes));
  await page.close();

  // Dark: a click without dragging takes the whole image; the box goes inside it.
  const whole = await open("dark");
  await shot(whole.page, "dark-start");
  await whole.page.mouse.click(640, 400);
  s = await whole.page.evaluate(state);
  check("a click without dragging selects the whole display", s.selection !== null && s.selection.x === 0 && s.selection.y === 0 && s.selection.width === SIZE.width && s.selection.height === SIZE.height, JSON.stringify(s.selection));
  check("its size is the whole image's", s.size === "1600 × 1000", String(s.size));
  check("the box goes inside it, at the bottom, centred, focused", s.placement === "inside" && near(s.box.x + s.box.width / 2, 640) && near(s.box.y + s.box.height, SIZE.height - 8) && s.focus === "task", JSON.stringify({ placement: s.placement, box: s.box }));
  check("a second visit preselects the workspace last used", s.workspace === "beta", String(s.workspace));
  await whole.page.keyboard.type("Describe the whole screen");
  await shot(whole.page, "dark-whole");
  await whole.page.keyboard.press("Enter");
  for (let i = 0; i < 30 && whole.seen.closes === 0; i++) await Bun.sleep(100);
  check("Enter crops the whole image", JSON.stringify(whole.seen.crops) === JSON.stringify([{ x: 0, y: 0, width: SIZE.width, height: SIZE.height }]), JSON.stringify(whole.seen.crops));
  check("and starts a session", (await sessions()).some((x) => x.title === "Describe the whole screen") && whole.seen.closes === 1);
  await whole.page.close();

  // Dark: a selection in the bottom right corner puts the box above it; Esc closes without a crop.
  const corner = await open("dark");
  await drag(corner.page, { x: 1250, y: 780 }, { x: 900, y: 560 });
  s = await corner.page.evaluate(state);
  check("at the bottom right corner the box goes above the selection, on screen", s.placement === "above" && near(s.box.y + s.box.height, 552) && s.box.x + s.box.width <= SIZE.width - 8 + 1, JSON.stringify({ placement: s.placement, box: s.box }));
  check("with the box above, the size label is inside the selection's corner", s.sizeAt.x >= 900 && s.sizeAt.y >= 560, JSON.stringify(s.sizeAt));
  await corner.page.keyboard.type("This button");
  await shot(corner.page, "dark-corner");
  await corner.page.keyboard.press("Escape");
  check("Esc closes, and nothing was cropped or started", corner.seen.closes === 1 && corner.seen.crops.length === 0 && !(await sessions()).some((x) => x.title === "This button"), JSON.stringify(corner.seen));
  await corner.page.close();

  // Esc before any selection closes too.
  const early = await open("light");
  await early.page.keyboard.press("Escape");
  check("Esc before any press closes", early.seen.closes === 1);
  await early.page.close();

  // Light, top edge: the box goes below a selection at the top.
  const top = await open("light");
  await drag(top.page, { x: 900, y: 0 }, { x: 1280, y: 120 });
  s = await top.page.evaluate(state);
  check("at the top right the box goes below, kept on screen", s.placement === "below" && s.box.x + s.box.width <= SIZE.width - 8 + 1 && near(s.box.y, 128), JSON.stringify({ placement: s.placement, box: s.box }));
  check("at the top edge the size label is inside the selection", s.sizeAt.y >= 0 && s.sizeAt.y < 20, JSON.stringify(s.sizeAt));
  await shot(top.page, "light-top-right");
  await top.page.close();

  // No bridge (a plain browser): the page says it opens from the shell, and does nothing.
  const plain = await open("light", false);
  s = await plain.page.evaluate(state);
  check("without the shell's bridge the page says where it opens from", (s.hint ?? "").includes("snip hotkey"), String(s.hint));
  await plain.page.close();

  const elsewhere = requested.filter((u) => !/^(?:data|blob|about):/.test(u) && new URL(u).hostname !== "127.0.0.1");
  check("no request left 127.0.0.1", requested.length > 0 && elsewhere.length === 0, elsewhere.join(" "));
} catch (e) {
  check("the run finished", false, (e as Error).stack ?? String(e));
} finally {
  await browser.close();
  await runner.stop();
  if (folder) rmSync(folder, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
