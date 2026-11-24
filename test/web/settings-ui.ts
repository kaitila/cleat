// Drives the settings page and the themes in headless Chromium, against a stub server that
// implements the settings contract (docs/protocol.md, "Settings"; T-0030 builds the runner's half)
// and serves src/web as the runner does. Run it on this machine: `bun test/web/settings-ui.ts`.
// It uses the playwright installed globally for bun, and prints "skipped" and exits 0 without one.
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type { ServerWebSocket } from "bun";
import { refusal } from "../../src/runner/server";

// The little of playwright's API this script uses (the package isn't a dependency, so no types).
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<unknown>;
  focus(selector: string): Promise<void>;
  waitForFunction<A>(fn: (arg: A) => unknown, arg?: A, options?: { timeout?: number }): Promise<unknown>;
  screenshot(options: { path?: string; fullPage?: boolean }): Promise<Uint8Array>;
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
  mouse: { move(x: number, y: number, options?: { steps?: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
}
interface Browser {
  newContext(options: { viewport: { width: number; height: number }; colorScheme: "light" | "dark" }): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
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
/** The page writes a Mac's keys by their symbols (headless Chromium on a Mac says MacIntel). */
const MAC = process.platform === "darwin";
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

// ---------- the stub: the settings contract, and src/web as the runner serves it ----------

type Mode = "auto" | "default";
interface Settings {
  theme: "system" | "light" | "dark";
  permissionMode: Mode;
  agent?: "claude" | "codex";
  workspaces: { name: string; path: string; permissionMode?: Mode; agent?: "claude" | "codex" | null }[];
  shell: { hotkey: string; snipHotkey: string; chatHotkey?: string; dock: boolean; startOnLogin: boolean } | null;
  port: number;
}

const dir = mkdtempSync(join(tmpdir(), "holm-settings-ui-"));
for (const name of ["alpha", "beta"]) mkdirSync(join(dir, name));
const shots = join(dir, "screenshots");
mkdirSync(shots);
const WEB = join(import.meta.dir, "..", "..", "src", "web");

let stored: Settings = {
  theme: "system",
  permissionMode: "auto",
  agent: "claude",
  workspaces: [
    { name: "alpha", path: join(dir, "alpha") },
    { name: "gone", path: join(dir, "gone"), permissionMode: "default" },
  ],
  // From before the chat's hotkey (D0046): none.
  shell: { hotkey: "Control+Alt+Space", snipHotkey: "Control+Alt+S", dock: true, startOnLogin: false },
  port: 0,
};

/**
 * The controls on the page that a person can't tell apart without a name or a tooltip: every visible
 * button and link needs an accessible name, and one that is only a glyph (two characters or fewer, or
 * none) needs a tooltip too (D0046).
 */
function unnamedControls(): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("button, a[href], [role=button], [role=menuitem]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden" || el.closest("[hidden], [inert]")) continue;
    const words = (el.textContent ?? "").trim();
    const labelled = el.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join("") ?? "";
    const name = el.getAttribute("aria-label") || labelled || words || el.title || el.dataset.tip;
    const tooltip = el.title || el.dataset.tip;
    if (!name) out.push(`no name: ${el.outerHTML.slice(0, 120)}`);
    else if (words.length <= 2 && !labelled && !tooltip) out.push(`no tooltip: ${el.outerHTML.slice(0, 120)}`);
  }
  return out;
}

/** Every PUT body, for the checks. */
const puts: unknown[] = [];
/** How long GET /api/settings waits before it answers (the cache check sets it). */
let getDelay = 0;

/** The first bad field of a PUT, as the runner answers it: 400 { error, field }. */
function invalid(s: Record<string, unknown>): { error: string; field: string } | null {
  if (!["system", "light", "dark"].includes(s.theme as string)) return { error: "theme must be system, light or dark", field: "theme" };
  if (!["auto", "default"].includes(s.permissionMode as string)) return { error: "permissionMode must be auto or default", field: "permissionMode" };
  if (!Array.isArray(s.workspaces)) return { error: "workspaces must be a list", field: "workspaces" };
  const names = new Set<string>();
  for (const [i, w] of (s.workspaces as Record<string, unknown>[]).entries()) {
    if (typeof w.name !== "string" || w.name.trim() === "") return { error: "A workspace needs a name.", field: `workspaces[${i}].name` };
    if (names.has(w.name)) return { error: `Another workspace is called ${w.name}.`, field: `workspaces[${i}].name` };
    names.add(w.name);
    if (typeof w.path !== "string" || !isAbsolute(w.path)) return { error: "The folder must be an absolute path, like /home/you/project.", field: `workspaces[${i}].path` };
    if (w.permissionMode !== undefined && !["auto", "default"].includes(w.permissionMode as string)) return { error: "bad mode", field: `workspaces[${i}].permissionMode` };
  }
  const shell = s.shell as Record<string, unknown> | null;
  if (shell !== null) {
    if (typeof shell !== "object") return { error: "shell must be an object or null", field: "shell" };
    if (typeof shell.hotkey !== "string" || !shell.hotkey) return { error: "A shortcut is needed.", field: "shell.hotkey" };
    if (typeof shell.snipHotkey !== "string" || !shell.snipHotkey) return { error: "A shortcut is needed.", field: "shell.snipHotkey" };
    if (shell.snipHotkey === shell.hotkey) return { error: "This is already the New task shortcut.", field: "shell.snipHotkey" };
    if (shell.chatHotkey !== undefined && (typeof shell.chatHotkey !== "string" || !shell.chatHotkey)) return { error: "A shortcut is needed.", field: "shell.chatHotkey" };
    for (const k of ["dock", "startOnLogin"]) if (typeof shell[k] !== "boolean") return { error: `${k} must be true or false`, field: `shell.${k}` };
  }
  return null;
}

/** GET /api/platform as the runner answers it: a Mac whose shell runs without Screen Recording. */
let platform = {
  layout: "macos",
  runner: { running: true, version: "0.1.0" },
  shell: { connected: true, report: { os: "macos", startOnLogin: false, hotkeys: { hotkey: true, snipHotkey: true }, dockTransparent: true, screenRecording: "denied", reportedAt: new Date().toISOString() } as Record<string, unknown> | null },
};
/** GET /api/agents as the runner answers it: Claude Code ready, Codex installed but not logged in. */
const agentStatus = {
  agents: [
    { agent: "claude", installed: true, version: "2.1.325 (Claude Code)", loggedIn: true, detail: "2.1.325 (Claude Code), logged in", fix: "" },
    { agent: "codex", installed: true, version: "codex-cli 0.169.0", loggedIn: false, detail: "codex-cli 0.169.0, not logged in", fix: "Log in: codex login" },
  ],
  checkedAt: new Date().toISOString(),
};
/** How many times the page asked the shell to open Screen Recording's pane. */
let screenOpens = 0;

const sockets = new Set<ServerWebSocket<unknown>>();
const broadcast = () => {
  for (const ws of sockets) ws.send(JSON.stringify({ type: "settings", settings: stored }));
};
/** Changes the stored settings from outside the page (another window, the shell), as the runner would. */
function setStored(change: Partial<Settings>): void {
  stored = { ...stored, ...change };
  broadcast();
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const file = (rel: string) => {
  const f = Bun.file(join(WEB, rel));
  return f.size > 0 ? new Response(f, { headers: { "cache-control": "no-store" } }) : json({ error: "not found" }, 404);
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, srv) {
    const why = refusal(req, srv.port!);
    if (why) return json({ error: why }, 403);
    const path = new URL(req.url).pathname;
    if (path === "/ws") return srv.upgrade(req) ? undefined : json({ error: "upgrade" }, 400);
    if (path === "/api/settings" && req.method === "GET") {
      if (getDelay) await Bun.sleep(getDelay);
      return json(stored);
    }
    if (path === "/api/settings" && req.method === "PUT") {
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return json({ error: "content-type must be application/json" }, 403);
      const body = (await req.json()) as Record<string, unknown>;
      puts.push(body);
      const bad = invalid(body);
      if (bad) return json(bad, 400);
      const { port: _ignored, ...rest } = body;
      stored = { ...(rest as unknown as Settings), port: stored.port };
      broadcast();
      return json(stored);
    }
    if (path === "/api/platform" && req.method === "GET") return json(platform);
    if (path === "/api/agents" && req.method === "GET") return json(agentStatus);
    if (path === "/api/platform/open-screen-recording" && req.method === "POST") {
      screenOpens++;
      return json({ sent: true }, 202);
    }
    if (path === "/api/workspaces") return json({ workspaces: stored.workspaces.map((w) => ({ ...w, exists: existsSync(w.path) })), lastUsed: null });
    if (path === "/api/clipboard") return json({});
    if (path === "/api/sessions") return json({ sessions: [] });
    if (path === "/health") return json({ ok: true, version: "0.1.0", build: "stub" });
    if (path === "/prompt") return file("prompt.html");
    if (path === "/settings") return file("settings.html");
    if (path.startsWith("/assets/")) {
      const rel = normalize(path.slice("/assets/".length));
      if (rel.startsWith("..")) return json({ error: "not found" }, 404);
      return file(rel);
    }
    return json({ error: "not found" }, 404);
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
    },
    close(ws) {
      sockets.delete(ws);
    },
    message() {},
  },
});
stored.port = server.port!;
const url = `http://127.0.0.1:${server.port}`;

// ---------- helpers ----------

async function open(path: string, colorScheme: "light" | "dark", size = { width: 720, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport: size, colorScheme });
  const page = await context.newPage();
  await page.goto(`${url}${path}`);
  return page;
}
const loaded = (page: Page) => page.waitForFunction(() => !document.querySelector(".settings")!.hasAttribute("aria-busy"), undefined, { timeout: 5000 });
async function until(name: string, fn: () => boolean | Promise<boolean>, detail: () => unknown = () => stored): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await fn()) return check(name, true);
    await Bun.sleep(50);
  }
  check(name, false, JSON.stringify(detail()));
}
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await Bun.sleep(400);
  const path = join(shots, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`screenshot: ${path}`);
}
// The scheme a page is in, by its ground (--bg): the pop-up's own page is see-through (D0028), so its colour is the token's.
const theme = (page: Page) => page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-theme"), bg: getComputedStyle(document.body).getPropertyValue("--bg").trim() }));
const LIGHT_BG = "#eceef4";
const DARK_BG = "#101219";
const visibleError = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s);
    return el && !el.hidden ? el.textContent ?? "" : null;
  }, selector);

try {
  // ---------- the page shows what is stored ----------
  const page = await open("/assets/settings.html", "light");
  await loaded(page);
  const shown = await page.evaluate(() => ({
    theme: document.querySelector<HTMLInputElement>('input[name="theme"]:checked')?.value,
    mode: document.querySelector<HTMLInputElement>('input[name="permissionMode"]:checked')?.value,
    names: [...document.querySelectorAll<HTMLInputElement>(".workspace .name")].map((i) => i.value),
    modes: [...document.querySelectorAll<HTMLSelectElement>(".workspace .mode")].map((i) => i.value),
    caps: [...document.querySelectorAll("[data-shortcut]")].map((b) => [...b.querySelectorAll("kbd")].map((k) => k.textContent).join(" ")),
    dock: document.querySelector<HTMLInputElement>('[data-switch="dock"]')!.checked,
    login: document.querySelector<HTMLInputElement>('[data-switch="startOnLogin"]')!.checked,
    port: document.querySelector("#port")!.textContent,
    version: document.querySelector("#version")!.textContent,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  check("it shows the stored theme and permission mode", shown.theme === "system" && shown.mode === "auto", JSON.stringify(shown));
  check("it shows the workspaces, in order, each with its own mode", shown.names.join() === "alpha,gone" && shown.modes.join() === ",default", JSON.stringify(shown));
  // The chat's from before it was set: its default (D0046).
  check("the shortcuts are keycaps", shown.caps.join("|") === (MAC ? "⌃ ⌥ Space|⌃ ⌥ S|⌘ ⇧ J" : "Ctrl Alt Space|Ctrl Alt S|Ctrl Alt J"), JSON.stringify(shown.caps));
  check("dock and startup show their switches", shown.dock && !shown.login);
  check("About shows the version and the port", shown.version === "0.1.0" && shown.port === String(server.port), JSON.stringify(shown));
  check("nothing is wider than the window", !shown.overflow);
  await until("each workspace says whether its folder exists", async () => (await page.evaluate(() => [...document.querySelectorAll(".exists")].map((e) => e.textContent).join())) === "Found,Not found", () => "");

  // ---------- every setting round-trips ----------
  await page.click('label.theme:has(input[value="dark"])');
  await until("Appearance: Dark is saved", () => stored.theme === "dark");
  let t = await theme(page);
  check("the page takes the theme at once (the live preview)", t.attr === "dark" && t.bg === DARK_BG, JSON.stringify(t));
  await until("a quiet Saved", async () => (await page.evaluate(() => document.querySelector("#status")!.textContent)) === "Saved", () => "");
  await shot(page, "settings-forced-dark");
  await page.click('label.theme:has(input[value="light"])');
  await until("Appearance: Light is saved", () => stored.theme === "light");
  await page.click('label.theme:has(input[value="system"])');
  await until("Appearance: System is saved", () => stored.theme === "system");
  t = await theme(page);
  check("System removes data-theme and follows the scheme (light here)", t.attr === null && t.bg === LIGHT_BG, JSON.stringify(t));

  await page.click('.segmented label:has(input[value="default"])');
  await until("Sessions: Ask is saved", () => stored.permissionMode === "default");
  await page.click('.segmented label:has(input[value="auto"])');
  await until("Sessions: Auto is saved", () => stored.permissionMode === "auto");

  // ---------- agents ----------
  const agentRows = () => page.evaluate(() => [...document.querySelectorAll("#agents > li")].map((li) => ({ agent: (li as HTMLElement).dataset.agent, tone: (li as HTMLElement).dataset.tone, value: li.querySelector(".setup-value")!.textContent, detail: li.querySelector(".setup-detail")!.textContent, glyph: li.querySelector(".setup-name svg") !== null })));
  await until("Agents: one line per agent, from GET /api/agents", async () => (await agentRows()).map((r) => `${r.agent}:${r.tone}`).join() === "claude:ok,codex:off", () => agentRows());
  const [claudeRow, codexRow] = await agentRows();
  check("Agents: each line says what the agent needs and what doctor found, after its glyph", claudeRow!.detail === "Needs Claude Code installed and logged in. Found 2.1.325 (Claude Code), logged in." && codexRow!.detail === "Needs Codex installed and logged in. Log in: codex login" && claudeRow!.glyph && codexRow!.glyph, JSON.stringify([claudeRow, codexRow]));
  check("Agents: the default agent shows the stored one", (await page.evaluate(() => document.querySelector<HTMLInputElement>('input[name="agent"]:checked')?.value)) === "claude");
  await page.click('.segmented label:has(input[value="codex"])');
  await until("Agents: Codex as the default is saved", () => stored.agent === "codex");
  await until("Agents: Codex not logged in turns red once sessions would run on it", async () => (await agentRows())[1]?.tone === "bad", () => agentRows());
  await shot(page, "settings-agents-codex");
  await page.click('.segmented label:has(input[value="claude"])');
  await until("Agents: back to Claude Code", () => stored.agent === "claude");
  await page.selectOption(".workspace:nth-child(1) .agent", "codex");
  await until("Workspaces: a workspace's own agent is saved", () => stored.workspaces[0]?.agent === "codex");
  await page.selectOption(".workspace:nth-child(1) .agent", "");
  await until("Workspaces: Default clears the workspace's own agent (null)", () => stored.workspaces[0]?.agent === null);
  const fieldWidths = await page.evaluate(() => [".name", ".path"].map((c) => document.querySelector<HTMLElement>(`.workspace ${c}`)!.getBoundingClientRect().width));
  check("Workspaces: the name and the folder keep their room beside the two choices", fieldWidths[0]! >= 120 && fieldWidths[1]! >= 300, JSON.stringify(fieldWidths));

  await page.fill(".workspace:nth-child(1) .name", "alpha2");
  await page.keyboard.press("Tab");
  await until("Workspaces: a name is saved when the field is left", () => stored.workspaces[0]?.name === "alpha2");
  await page.fill(".workspace:nth-child(2) .path", join(dir, "beta"));
  await page.keyboard.press("Enter");
  await until("Workspaces: a folder is saved on Enter", () => stored.workspaces[1]?.path === join(dir, "beta"));
  await until("the folder check follows the new path", async () => (await page.evaluate(() => document.querySelectorAll(".exists")[1]!.textContent)) === "Found", () => "");
  await page.selectOption(".workspace:nth-child(1) .mode", "default");
  await until("Workspaces: a workspace's own mode is saved", () => stored.workspaces[0]?.permissionMode === "default");
  await page.selectOption(".workspace:nth-child(1) .mode", "");
  await until("Workspaces: As above takes the workspace's own mode away", () => stored.workspaces[0] !== undefined && !("permissionMode" in stored.workspaces[0]));
  await page.click(".workspace:nth-child(1) .down");
  await until("Workspaces: reorder", () => stored.workspaces.map((w) => w.name).join() === "gone,alpha2");
  const focusAfterMove = await page.evaluate(() => document.activeElement?.className ?? "");
  check("the focus goes with the moved row", focusAfterMove.includes("up"), focusAfterMove);
  await page.click(".workspace:nth-child(2) .up");
  await until("Workspaces: reorder back", () => stored.workspaces.map((w) => w.name).join() === "alpha2,gone");

  const before = puts.length;
  await page.click("#add-workspace");
  const focused = await page.evaluate(() => document.activeElement?.classList.contains("name") && document.activeElement.closest(".workspace") === document.querySelector(".workspace:last-child"));
  check("Add workspace puts the focus in the new row's name", focused === true);
  await page.keyboard.type("new");
  await page.keyboard.press("Tab");
  await Bun.sleep(200);
  check("a new row without a folder isn't sent yet, and shows no error", puts.length === before && (await visibleError(page, ".workspace:last-child .field-error")) === null, `${puts.length - before} puts`);
  await page.keyboard.type(join(dir, "alpha"));
  await page.keyboard.press("Tab");
  await until("Workspaces: add", () => stored.workspaces.map((w) => w.name).join() === "alpha2,gone,new");
  await page.click(".workspace:nth-child(3) .remove");
  await until("Workspaces: remove", () => stored.workspaces.map((w) => w.name).join() === "alpha2,gone");

  await page.click('[data-shortcut="hotkey"]');
  check("a shortcut being recorded says so", (await page.evaluate(() => document.querySelector('[data-shortcut="hotkey"]')!.textContent)) === "Press the keys…");
  await page.keyboard.press("Escape");
  await Bun.sleep(150);
  check("Esc keeps the old shortcut", stored.shell?.hotkey === "Control+Alt+Space" && (await page.evaluate(() => document.querySelector('[data-shortcut="hotkey"] kbd')?.textContent)) === (MAC ? "⌃" : "Ctrl"));
  await page.click('[data-shortcut="hotkey"]');
  await page.keyboard.press("k");
  check("a key without Ctrl, Alt or Win is refused inline", ((await visibleError(page, '[data-error-for="shell.hotkey"]')) ?? "").includes(MAC ? "⌘" : "Ctrl"));
  await page.keyboard.press("Control+Shift+K");
  await until("Shortcuts: New task is recorded from the keys pressed", () => stored.shell?.hotkey === "Control+Shift+K");
  const caps = await page.evaluate(() => [...document.querySelectorAll('[data-shortcut="hotkey"] kbd')].map((k) => k.textContent).join(" "));
  check("and shown as keycaps", caps === (MAC ? "⌃ ⇧ K" : "Ctrl Shift K"), caps);
  await page.click('[data-shortcut="snipHotkey"]');
  await page.keyboard.press("Alt+F9");
  await until("Shortcuts: Snip is recorded", () => stored.shell?.snipHotkey === "Alt+F9");

  // The chat's hotkey (D0046): settings from before it have none, so the row shows the default, and
  // the next save stores it. Recorded like the others; another's keys are refused at once, unsent.
  check("Shortcuts: Chat shows its default before it was ever set", (await page.evaluate(() => [...document.querySelectorAll('[data-shortcut="chatHotkey"] kbd')].map((k) => k.textContent).join(" "))) === (MAC ? "⌘ ⇧ J" : "Ctrl Alt J"));
  check("and the Snip save stored it", stored.shell?.chatHotkey === (MAC ? "Command+Shift+J" : "Control+Alt+J"), JSON.stringify(stored.shell));
  const putsBefore = puts.length;
  await page.click('[data-shortcut="chatHotkey"]');
  await page.keyboard.press("Alt+F9");
  await until("Shortcuts: the Snip shortcut's keys are refused for Chat, under its row", async () => ((await visibleError(page, '[data-error-for="shell.chatHotkey"]')) ?? "") === "This is already the Snip shortcut.", () => "");
  check("and not sent", puts.length === putsBefore && stored.shell?.chatHotkey === (MAC ? "Command+Shift+J" : "Control+Alt+J"));
  await page.click('[data-shortcut="chatHotkey"]');
  await page.keyboard.press("Control+Alt+K");
  await until("Shortcuts: Chat is recorded", () => stored.shell?.chatHotkey === "Control+Alt+K");
  check("and its error goes", (await visibleError(page, '[data-error-for="shell.chatHotkey"]')) === null);
  const pageKeys = await page.evaluate(() => [...document.querySelectorAll("#page-keys .guide-title")].map((t) => t.textContent).join(","));
  check("under the shortcuts, the pages' keys, read-only: the guide's list less the global three", pageKeys === "Dock,Chat,New task and snip", pageKeys);
  check("in this platform's words", (await page.evaluate(() => [...document.querySelectorAll('#page-keys [data-key="dock.switch"] kbd')].map((k) => k.textContent).join(""))) === (MAC ? "⌘K" : "CtrlK"));
  const unnamed = await page.evaluate(unnamedControls);
  check(`every button and link has a name, and every glyph-only one a tooltip`, unnamed.length === 0, unnamed.join("; "));

  await page.click('label.setting:has([data-switch="dock"])');
  await until("Dock: off is saved", () => stored.shell?.dock === false);
  await page.click('label.setting:has([data-switch="startOnLogin"])');
  await until("Startup: start at login is saved", () => stored.shell?.startOnLogin === true);
  check("the port is never what the page decides", (puts.at(-1) as Settings).port === server.port);

  // ---------- a 400 shows at its field ----------
  await page.click('[data-shortcut="snipHotkey"]');
  await page.keyboard.press("Control+Shift+K");
  await until("a 400 for the snip shortcut shows under it", async () => ((await visibleError(page, '[data-error-for="shell.snipHotkey"]')) ?? "").includes("already"), () => "");
  check("the field is marked invalid, and the status says it wasn't saved", await page.evaluate(() => document.querySelector('[data-shortcut="snipHotkey"]')!.getAttribute("aria-invalid") === "true" && document.querySelector("#status")!.textContent === "Not saved"));
  check("nothing was stored", stored.shell?.snipHotkey === "Alt+F9");
  await page.fill(".workspace:nth-child(2) .path", "relative/folder");
  await page.keyboard.press("Enter");
  await until("a 400 for a workspace's folder shows in that row", async () => ((await visibleError(page, ".workspace:nth-child(2) .field-error")) ?? "").includes("absolute"), () => "");
  check("only that row's folder is marked", await page.evaluate(() => [...document.querySelectorAll("[aria-invalid=true]")].map((e) => e.getAttribute("data-field")).join() === "workspaces.1.path"));
  await shot(page, "settings-light-error");
  await page.fill(".workspace:nth-child(2) .path", join(dir, "gone"));
  await page.click('[data-shortcut="snipHotkey"]');
  await page.keyboard.press("Control+Alt+S");
  await until("fixed, it saves and the errors go", async () => stored.shell?.snipHotkey === "Control+Alt+S" && (await page.evaluate(() => document.querySelectorAll("[aria-invalid=true]").length === 0 && [...document.querySelectorAll<HTMLElement>(".field-error")].every((e) => e.hidden))), () => stored.shell);

  // ---------- another window's change arrives on /ws ----------
  setStored({ theme: "dark", permissionMode: "default" });
  await until("a change from elsewhere shows on the open page", async () => {
    const s = await page.evaluate(() => [document.querySelector<HTMLInputElement>('input[name="theme"]:checked')?.value, document.querySelector<HTMLInputElement>('input[name="permissionMode"]:checked')?.value, document.documentElement.getAttribute("data-theme")]);
    return s.join() === "dark,default,dark";
  }, () => "");
  setStored({ theme: "system", permissionMode: "auto" });

  // ---------- the shell hasn't sent its values yet ----------
  const shell = stored.shell;
  stored = { ...stored, shell: null };
  const fresh = await open("/assets/settings.html", "light");
  await loaded(fresh);
  check("with no shell values its controls are off, with a note", await fresh.evaluate(() => (document.querySelector('[data-shortcut="hotkey"]') as HTMLButtonElement).disabled && (document.querySelector('[data-switch="dock"]') as HTMLInputElement).disabled && !document.querySelector<HTMLElement>("#shell-missing")!.hidden));
  stored = { ...stored, shell };

  // ---------- the theme follows live on an open pop-up ----------
  const prompt = await open("/prompt", "dark", { width: 560, height: 380 });
  await prompt.waitForFunction(() => document.querySelectorAll("#workspaces input").length > 0);
  t = await theme(prompt);
  check("pop-up: System follows the scheme (dark here)", t.attr === null && t.bg === DARK_BG, JSON.stringify(t));
  await shot(prompt, "prompt-dark");
  setStored({ theme: "light" });
  await until("pop-up: Light, set elsewhere, applies live", async () => (await theme(prompt)).bg === LIGHT_BG, () => "");
  check("pop-up: data-theme is light", (await theme(prompt)).attr === "light");
  await shot(prompt, "prompt-forced-light");
  setStored({ theme: "dark" });
  await until("pop-up: Dark applies live", async () => (await theme(prompt)).attr === "dark", () => "");
  setStored({ theme: "system" });
  await until("pop-up: back to System takes data-theme away", async () => { const x = await theme(prompt); return x.attr === null && x.bg === DARK_BG; }, () => "");

  // A light desktop with the dark theme chosen.
  setStored({ theme: "dark" });
  const promptLight = await open("/prompt", "light", { width: 560, height: 380 });
  await promptLight.waitForFunction(() => document.querySelectorAll("#workspaces input").length > 0);
  await until("pop-up: Dark wins over a light scheme", async () => (await theme(promptLight)).bg === DARK_BG, () => "");
  setStored({ theme: "system" });
  await until("pop-up: System on a light desktop is light", async () => (await theme(promptLight)).bg === LIGHT_BG, () => "");
  await shot(promptLight, "prompt-light");

  // ---------- no flash: the cached theme is there before the runner answers ----------
  setStored({ theme: "light" });
  getDelay = 1200;
  const cachedCtx = await browser.newContext({ viewport: { width: 560, height: 380 }, colorScheme: "light" });
  const cached = await cachedCtx.newPage();
  await cached.addInitScript(() => {
    try {
      if (!sessionStorage.getItem("seeded")) localStorage.setItem("holm.theme", "dark");
      sessionStorage.setItem("seeded", "1");
    } catch {}
  }, undefined);
  await cached.goto(`${url}/prompt`);
  const first = await theme(cached);
  check("the cached theme is applied before GET /api/settings answers", first.attr === "dark" && first.bg === DARK_BG, JSON.stringify(first));
  await until("then the runner's answer wins", async () => (await theme(cached)).attr === "light", () => "");
  getDelay = 0;
  setStored({ theme: "system" });

  // ---------- the snip box follows too ----------
  for (const scheme of ["light", "dark"] as const) {
    const snipCtx = await browser.newContext({ viewport: { width: 900, height: 560 }, colorScheme: scheme });
    const snip = await snipCtx.newPage();
    const grey = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560"><rect width="900" height="560" fill="#7a8494"/><rect x="80" y="60" width="420" height="260" fill="#e9edf2"/></svg>')}`;
    await snip.addInitScript((capture: string) => {
      (window as unknown as Record<string, unknown>).holmSnip = { getCapture: async () => capture, crop: async () => "", close: () => {} };
    }, grey);
    await snip.goto(`${url}/assets/snip.html`);
    await snip.waitForFunction(() => (window as unknown as { snipReady?: Promise<boolean> }).snipReady?.then((ok) => ok), undefined, { timeout: 5000 }).catch(() => {});
    await snip.mouse.move(120, 90);
    await snip.mouse.down();
    await snip.mouse.move(460, 280, { steps: 5 });
    await snip.mouse.up();
    await Bun.sleep(500);
    const box = await snip.evaluate(() => getComputedStyle(document.querySelector("#box")!).backgroundColor);
    check(`snip (${scheme}): the box is in the scheme's floating glass`, box === (scheme === "light" ? "rgba(250, 250, 253, 0.88)" : "rgba(18, 18, 24, 0.86)"), box);
    await shot(snip, `snip-${scheme}`);
  }

  // ---------- the Setup section ----------
  {
    const p = await open("/assets/settings.html", "light");
    await loaded(p);
    const lines = () => p.evaluate(() => [...document.querySelectorAll("#setup [data-setup]")].map((li) => ({ key: (li as HTMLElement).dataset.setup, tone: (li as HTMLElement).dataset.tone, button: !(li.querySelector(".setup-action") as HTMLElement).hidden })));
    await until("setup: layout, runner, shell, start at login, shortcuts and Screen Recording", async () => (await lines()).map((l) => l.key).join() === "layout,runner,shell,startOnLogin,hotkeys,screenRecording", () => lines());
    const screen = (await lines()).find((l) => l.key === "screenRecording");
    check("setup: Screen Recording is not ok and has its button", screen?.tone === "bad" && screen.button === true, JSON.stringify(screen));
    await shot(p, "settings-setup-light");
    await p.click('#setup [data-setup="screenRecording"] .setup-action');
    await until("setup: the button asks the runner to have the shell open System Settings", () => screenOpens === 1, () => screenOpens);
    // The shell reports again (granted now): the line follows the platform message.
    platform = { ...platform, shell: { connected: true, report: { ...platform.shell.report!, screenRecording: "granted", startOnLogin: true } } };
    for (const ws of sockets) ws.send(JSON.stringify({ type: "platform", platform }));
    await until("setup: a platform message redraws it, all ok", async () => (await lines()).every((l) => l.tone === "ok" && !l.button), () => lines());
    // The shell quits.
    platform = { ...platform, shell: { connected: false, report: null } };
    for (const ws of sockets) ws.send(JSON.stringify({ type: "platform", platform }));
    await until("setup: without the shell, it says so", async () => (await lines()).find((l) => l.key === "shell")?.tone === "bad", () => lines());
    await shot(p, "settings-setup-no-shell");
  }

  // ---------- screenshots of the settings page ----------
  for (const scheme of ["light", "dark"] as const) {
    const p = await open("/assets/settings.html", scheme);
    await loaded(p);
    await shot(p, `settings-${scheme}`);
  }
  const narrow = await open("/assets/settings.html", "dark", { width: 400, height: 900 });
  await loaded(narrow);
  check("at 400px nothing is wider than the window", await narrow.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await shot(narrow, "settings-dark-narrow");
} finally {
  await browser.close();
  server.stop(true);
  console.log(`screenshots kept in ${shots} (delete ${dir} when done)`);
}
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all ok");
