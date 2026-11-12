// Drives the pop-up prompt in headless Chromium at the size the shell opens it (560x380), against a
// runner with the fake agent. Run it on this machine: `bun test/web/prompt-ui.ts`.
// It uses the playwright installed globally for bun, and prints "skipped" and exits 0 without one.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionsResponse, WorkspacesResponse } from "../../src/shared/protocol";
import { loadConfig } from "../../src/runner/config";
import { startServer } from "../../src/runner/server";

// The little of playwright's API this script uses (the package isn't a dependency, so no types).
interface Page {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  waitForFunction(fn: () => unknown, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  waitForEvent(event: "close", options?: { timeout?: number }): Promise<unknown>;
  screenshot(options: { path: string }): Promise<unknown>;
  isClosed(): boolean;
  close(): Promise<void>;
  route(url: string, handler: (route: { abort(): Promise<void> }) => unknown): Promise<void>;
  unroute(url: string): Promise<void>;
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
}
interface Browser {
  newContext(options: { viewport: { width: number; height: number }; colorScheme: "light" | "dark" }): Promise<{ newPage(): Promise<Page> }>;
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

// A throwaway config: one workspace whose folder is missing (first, so the default has to skip it)
// and two that exist, so "the chosen one" and "the last used one" differ from "the first".
const dir = mkdtempSync(join(tmpdir(), "intuition-prompt-ui-"));
for (const name of ["alpha", "beta"]) mkdirSync(join(dir, name));
const env = {
  INTUITION_CONFIG: join(dir, "config.json"),
  INTUITION_DATA_DIR: join(dir, "data"),
  INTUITION_PORT: "0",
  INTUITION_FAKE_AGENT: "1",
};
writeFileSync(
  env.INTUITION_CONFIG,
  JSON.stringify({ workspaces: ["gone", "alpha", "beta"].map((name) => ({ name, path: join(dir, name) })) }),
);
const runner = startServer(loadConfig(env));
const shots = join(dir, "screenshots");
mkdirSync(shots);

const SIZE = { width: 560, height: 380 };
const state = () => ({
  focus: document.activeElement?.id ?? "",
  workspaces: [...document.querySelectorAll<HTMLInputElement>("#workspaces input")].map((r) => ({
    name: r.value,
    disabled: r.disabled,
    checked: r.checked,
  })),
  task: document.querySelector<HTMLTextAreaElement>("#task")!.value,
  status: document.querySelector("#status")!.textContent ?? "",
  link: document.querySelector<HTMLAnchorElement>("#status a")?.getAttribute("href") ?? null,
  clipboardHidden: document.querySelector<HTMLElement>("#clipboard")!.hidden && document.querySelector("#clipboard")!.childNodes.length === 0,
  // No scrollbars: nothing is wider or taller than the window, and no scrollbar takes room from it.
  overflow: [document.documentElement, document.body, document.querySelector("#task")!].some(
    (el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight,
  ),
  gutter: window.innerWidth - document.documentElement.clientWidth + (window.innerHeight - document.documentElement.clientHeight),
});
const ready = () => document.querySelectorAll("#workspaces input").length > 0;
const sessions = async () => ((await (await fetch(`${runner.url}/api/sessions`)).json()) as SessionsResponse).sessions;
const checkedOf = (s: ReturnType<typeof state>) => s.workspaces.find((w) => w.checked)?.name ?? null;

async function open(colorScheme: "light" | "dark"): Promise<Page> {
  const page = await (await browser.newContext({ viewport: SIZE, colorScheme })).newPage();
  await page.goto(`${runner.url}/prompt`);
  await page.waitForFunction(ready);
  return page;
}
async function shot(page: Page, name: string): Promise<void> {
  const path = join(shots, `${name}.png`);
  await page.screenshot({ path });
  console.log(`screenshot: ${path}`);
}

try {
  // First visit, light.
  const page = await open("light");
  let s = await page.evaluate(state);
  check("the task box has focus on load", s.focus === "task", s.focus);
  check("the missing workspace is disabled", s.workspaces.find((w) => w.name === "gone")?.disabled === true);
  check("the workspaces that exist can be picked", s.workspaces.filter((w) => !w.disabled).map((w) => w.name).join() === "alpha,beta");
  check("with none used yet, the first that exists is selected", checkedOf(s) === "alpha", String(checkedOf(s)));
  check("the clipboard element is there, empty and hidden", s.clipboardHidden);
  check("no scrollbars at 560x380", !s.overflow && s.gutter === 0, JSON.stringify({ overflow: s.overflow, gutter: s.gutter }));
  await shot(page, "light-empty");

  await page.keyboard.press("Enter");
  await Bun.sleep(200);
  check("Enter on an empty task does nothing", (await sessions()).length === 0 && (await page.evaluate(state)).status === "");

  await page.keyboard.press("Alt+1");
  check("Alt+1 can't pick the missing workspace", checkedOf(await page.evaluate(state)) === "alpha");
  await page.keyboard.press("Alt+3");
  s = await page.evaluate(state);
  check("Alt+3 picks the third workspace and typing stays in the task box", checkedOf(s) === "beta" && s.focus === "task");

  await page.keyboard.type("Tidy the notes");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("and list what changed");
  s = await page.evaluate(state);
  check("Shift+Enter is a new line", s.task === "Tidy the notes\nand list what changed" && (await sessions()).length === 0, JSON.stringify(s.task));
  await shot(page, "light-typed");

  // An error: the runner can't be reached. One quiet line, and the task is kept.
  await page.route("**/api/sessions", (route) => route.abort());
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector<HTMLElement>("#status")!.dataset.kind === "error");
  s = await page.evaluate(state);
  check("an unreachable runner is one line, and the task is kept", s.status === "the runner is not reachable" && s.task.startsWith("Tidy the notes"), s.status);
  check("no scrollbars with the error line", !s.overflow && s.gutter === 0);
  await shot(page, "light-error");
  await page.unroute("**/api/sessions");

  // Enter starts the session. The window then closes itself, or says Started where it can't.
  const closed = page.waitForEvent("close", { timeout: 5000 }).then(() => true, () => false);
  await page.keyboard.press("Enter");
  await Promise.race([closed, page.waitForFunction(() => document.querySelector("#status a") !== null, undefined, { timeout: 5000 }).catch(() => {})]);
  const list = await sessions();
  check("Enter creates one session", list.length === 1, `${list.length} sessions`);
  check("the session is in the chosen workspace", list[0]?.workspace === "beta" && list[0]?.cwd === join(dir, "beta"), JSON.stringify(list[0]));
  check("the session's title is the task's first line", list[0]?.title === "Tidy the notes", list[0]?.title);
  if (page.isClosed()) {
    check("the window closed itself after the 201", true);
  } else {
    s = await page.evaluate(state);
    check("where the window can't close, it says Started with a link to the session", s.status.startsWith("Started") && s.link === `/?session=${list[0]?.id}`, JSON.stringify(s));
    check("the task box is cleared after the start", s.task === "");
    await shot(page, "light-started");
    await page.close();
  }

  // Second visit, dark: the workspace just used is preselected.
  const again = await open("dark");
  s = await again.evaluate(state);
  const last = ((await (await fetch(`${runner.url}/api/workspaces`)).json()) as WorkspacesResponse).lastUsed;
  check("a second visit preselects the workspace last used", checkedOf(s) === "beta" && last === "beta", `${checkedOf(s)} / ${last}`);
  check("the task box has focus on the second visit", s.focus === "task");
  check("no scrollbars in dark", !s.overflow && s.gutter === 0);
  await shot(again, "dark-empty");
  await again.keyboard.type("A longer task, to see the box with text in the dark theme.");
  await shot(again, "dark-typed");

  // Tab reaches the workspaces.
  await again.keyboard.press("Shift+Tab");
  const focused = await again.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value ?? "");
  check("Tab reaches the workspace row", focused === "beta", focused);
  await shot(again, "dark-workspace-focus");
} catch (e) {
  check("the run finished", false, (e as Error).stack ?? String(e));
} finally {
  await browser.close();
  await runner.stop();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
