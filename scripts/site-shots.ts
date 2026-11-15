// The landing page's screenshots: `bun scripts/site-shots.ts`. Writes site/shots/*.png.
// Every image on the page is the app itself: the real pages, served by a real runner with the fake
// agent (INTUITION_FAKE_AGENT=1), driven in headless Chromium by the playwright installed globally
// for bun. The config is a throwaway one with made-up workspaces in a mkdtemp folder, and the
// sessions are seeded into a temp data folder: nothing of this machine's shows in them.
// This machine only: it needs that playwright and its browser, and says "skipped" and exits 0
// where there is none (and when CI is set). Each PNG is re-encoded by ImageMagick, if it is there,
// and must come out under 300 KB.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDriver } from "../src/runner/agent-fake";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";
import { Store } from "../src/runner/store";
import type { AgentDriver, NewEvent } from "../src/runner/agent";
import type { SessionMeta, SessionResponse, SessionsResponse } from "../src/shared/protocol";
import { DOCK_WINDOW } from "../shell/src/dock";

const PLAYWRIGHT = join(homedir(), ".bun", "install", "global", "node_modules", "playwright");
const OUT = join(import.meta.dir, "..", "site", "shots");
/** The most one screenshot may weigh. */
export const SHOT_LIMIT = 300 * 1024;

function skip(why: string): never {
  console.log(`site-shots: skipped (${why})`);
  process.exit(0);
}
if (process.env.CI) skip("CI is set: no browser there");
if (!existsSync(PLAYWRIGHT)) skip(`no playwright at ${PLAYWRIGHT}`);

// Playwright isn't a dependency of this project, so it has no types here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let browser: Any;
try {
  const playwright: Any = await import(PLAYWRIGHT);
  browser = await (playwright.chromium ?? playwright.default.chromium).launch();
} catch (e) {
  skip(`no browser available: ${String((e as Error).message ?? e).split("\n")[0]}`);
}

// ---------- a throwaway runner with made-up workspaces ----------
const dir = mkdtempSync(join(tmpdir(), "intuition-site-"));
const WORKSPACES = ["website", "billing-api", "notes"];
for (const name of WORKSPACES) mkdirSync(join(dir, name));
const env = { INTUITION_CONFIG: join(dir, "config.json"), INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: "0", INTUITION_FAKE_AGENT: "1" };
writeFileSync(env.INTUITION_CONFIG, JSON.stringify({ theme: "system", workspaces: WORKSPACES.map((name) => ({ name, path: join(dir, name) })) }));

/** A finished session, `ago` minutes old, with its events a few seconds apart. */
function seed(store: Store, workspace: string, title: string, ago: number, events: NewEvent[]): void {
  const id = crypto.randomUUID();
  const start = Date.now() - ago * 60_000;
  const at = (i: number) => new Date(start + i * 4_000).toISOString();
  store.create({ id, claudeSessionId: `fake-${id}`, workspace, cwd: join(dir, workspace), title, status: "idle", createdAt: at(0), updatedAt: at(0), lastSeq: 0 });
  events.forEach((e, i) => store.append(id, e, at(i)));
  store.create({ ...(store.get(id) as SessionMeta), updatedAt: at(events.length) });
}
{
  const store = new Store(env.INTUITION_DATA_DIR);
  seed(store, "notes", "Summarise the notes from Tuesday's planning call", 190, [
    { kind: "user", text: "Summarise the notes from Tuesday's planning call into three bullet points" },
    { kind: "tool_use", toolUseId: "n1", name: "Read", input: { file_path: "planning/tuesday.md" } },
    { kind: "tool_result", toolUseId: "n1", content: "…", isError: false },
    { kind: "assistant_text", text: "- Ship the settings page first.\n- Move the import job to the nightly run.\n- Ask design for the empty states." },
    { kind: "result", ok: true, durationMs: 9_000 },
  ]);
  seed(store, "website", "Tighten the hero copy on the pricing page", 64, [
    { kind: "user", text: "Tighten the hero copy on the pricing page. Keep it to two lines." },
    { kind: "tool_use", toolUseId: "w1", name: "Read", input: { file_path: "src/pages/pricing.tsx" } },
    { kind: "tool_result", toolUseId: "w1", content: "…", isError: false },
    { kind: "tool_use", toolUseId: "w2", name: "Edit", input: { file_path: "src/pages/pricing.tsx" } },
    { kind: "tool_result", toolUseId: "w2", content: "ok", isError: false },
    { kind: "assistant_text", text: "Done: the headline is one line now, and the subline says what the free plan includes." },
    { kind: "result", ok: true, durationMs: 21_000 },
  ]);
  seed(store, "billing-api", "Fix the flaky date test in invoices", 12, [
    { kind: "user", text: "The invoice date test fails around midnight. Find out why and fix it." },
    { kind: "tool_use", toolUseId: "b1", name: "Grep", input: { pattern: "dueDate", path: "src/invoices" } },
    { kind: "tool_result", toolUseId: "b1", content: "src/invoices/due.ts", isError: false },
    { kind: "tool_use", toolUseId: "b2", name: "Read", input: { file_path: "src/invoices/due.ts" } },
    { kind: "tool_result", toolUseId: "b2", content: "…", isError: false },
    { kind: "tool_use", toolUseId: "b3", name: "Bash", input: { command: "bun test test/invoices" } },
    { kind: "tool_result", toolUseId: "b3", content: "pass", isError: false },
    {
      kind: "assistant_text",
      text: "The test built its expected date with `new Date()` in local time, while `dueDate()` works in UTC, so the two disagreed for an hour around midnight.\n\nI pinned the clock in the test and compare both in UTC:\n\n```ts\nsetSystemTime(new Date(\"2026-03-01T23:30:00Z\"));\nexpect(dueDate(invoice)).toEqual(\"2026-03-31\");\n```\n\nThe suite passes, and it no longer depends on the hour it runs at.",
    },
    { kind: "result", ok: true, durationMs: 48_000 },
  ]);
}

/**
 * The fake agent, with one turn scripted to read like a real one: a prompt about the changelog reads
 * it, then asks to edit it and waits for the person's Allow or Deny, as Claude Code does for a call
 * auto mode leaves to the person. Every other prompt goes to the fake agent as it is.
 */
function standIn(): AgentDriver {
  const fake = fakeDriver(60);
  return {
    async *run(input) {
      if (!input.prompt.includes("changelog")) return yield* fake.run(input);
      yield { type: "session_id", id: `fake-${crypto.randomUUID()}` };
      yield { type: "permission_mode", mode: input.permissionMode };
      await Bun.sleep(60);
      yield { type: "event", event: { kind: "tool_use", toolUseId: "c1", name: "Read", input: { file_path: "CHANGELOG.md" } } };
      yield { type: "event", event: { kind: "tool_result", toolUseId: "c1", content: "…", isError: false } };
      const edit = { file_path: "CHANGELOG.md", old_string: "## Unreleased\n", new_string: "## Unreleased\n\n- Invoices: due dates are computed in UTC, so they no longer shift around midnight.\n" };
      yield { type: "event", event: { kind: "tool_use", toolUseId: "c2", name: "Edit", input: edit } };
      const decision = await input.approve({ toolUseId: "c2", toolName: "Edit", input: edit });
      yield { type: "event", event: { kind: "tool_result", toolUseId: "c2", content: decision === "allow" ? "ok" : "denied", isError: decision !== "allow" } };
      yield { type: "event", event: { kind: "result", ok: true, durationMs: 1_000 } };
    },
  };
}
const runner = startServer(loadConfig(env), standIn());
const post = (path: string, body: unknown) => fetch(runner.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A session that waits for the person's Allow or Deny: the fake agent asks before it writes. */
async function waitingSession(): Promise<string> {
  const res = await post("/api/sessions", { workspace: "billing-api", prompt: "Add a changelog entry for the invoice date fix" });
  const { session } = (await res.json()) as SessionResponse;
  for (let i = 0; i < 100; i++) {
    const { sessions } = (await (await fetch(`${runner.url}/api/sessions`)).json()) as SessionsResponse;
    if (sessions.find((s) => s.id === session.id)?.status === "waiting_approval") return session.id;
    await Bun.sleep(50);
  }
  throw new Error("the fake session never asked for approval");
}

// ---------- the screenshots ----------
mkdirSync(OUT, { recursive: true });
const written: string[] = [];
const requested: string[] = [];
type Scheme = "light" | "dark";

async function page(viewport: { width: number; height: number }, colorScheme: Scheme, scale = 2): Promise<Any> {
  const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: scale, reducedMotion: "reduce" });
  context.on("request", (r: Any) => requested.push(r.url()));
  const p = await context.newPage();
  // Settle: no animation left running (the running dot's breath is infinite and is left alone).
  p.rest = async () => {
    await p.evaluate(() => document.fonts.ready);
    await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity));
    await p.waitForTimeout(150);
  };
  return p;
}

/** Saves a screenshot as site/shots/<name>.png, re-encoded smaller where ImageMagick is installed. */
async function save(p: Any, name: string, options: Record<string, unknown> = {}): Promise<void> {
  await p.rest();
  const path = join(OUT, `${name}.png`);
  await p.screenshot({ path, ...options });
  if (Bun.which("convert")) {
    const smaller = Bun.spawnSync(["convert", path, "-strip", "-define", "png:compression-level=9", "-define", "png:compression-filter=5", "-define", "png:exclude-chunks=all", path]);
    if (smaller.exitCode !== 0) console.log(`  note: convert failed on ${name}: ${smaller.stderr.toString().trim()}`);
  }
  let size = statSync(path).size;
  if (size > SHOT_LIMIT && Bun.which("convert")) {
    // Still too heavy: fewer colours. The pages are flat glass, so 256 of them hold up.
    Bun.spawnSync(["convert", path, "-strip", "-colors", "256", "-define", "png:compression-level=9", path]);
    size = statSync(path).size;
  }
  console.log(`  ${name}.png ${Math.round(size / 1024)} KB`);
  if (size > SHOT_LIMIT) throw new Error(`${name}.png is ${Math.round(size / 1024)} KB, over ${SHOT_LIMIT / 1024}`);
  written.push(path);
}

try {
  const CHAT = { width: 1200, height: 760 };

  for (const scheme of ["light", "dark"] as Scheme[]) {
    console.log(scheme);
    // The chat view, on the session that fixed a test: what the snip freezes behind its box.
    const chat = await page(CHAT, scheme, 1.25);
    const { sessions } = (await (await fetch(`${runner.url}/api/sessions`)).json()) as SessionsResponse;
    const fixed = sessions.find((x) => x.title.startsWith("Fix the flaky"))!;
    await chat.goto(`${runner.url}/?session=${fixed.id}`);
    await chat.getByText("no longer depends on the hour").waitFor();
    await chat.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await chat.rest();
    const frozen = (await chat.screenshot()).toString("base64");
    await chat.context().close();

    // 1. The pop-up, with the copied text attached, a workspace chosen and a task typed.
    await post("/api/clipboard", { text: "TypeError: Cannot read properties of undefined (reading 'total')\n    at renderInvoice (src/invoices/render.ts:42:18)" });
    const prompt = await page({ width: 560, height: 380 }, scheme);
    await prompt.goto(`${runner.url}/prompt`);
    await prompt.waitForFunction(() => document.querySelectorAll("#workspaces input").length > 0);
    await prompt.locator("#clipboard").getByText("TypeError").first().waitFor();
    await prompt.locator('#workspaces input[value="billing-api"]').check({ force: true });
    await prompt.locator("#task").fill("This shows up on the invoice page since this morning. Find the cause and fix it.");
    await save(prompt, `popup-${scheme}`, { omitBackground: true });
    await prompt.context().close();

    // 2. The snip: the chat view frozen, an area dragged over the answer, a task typed beside it.
    const snip = await page(CHAT, scheme, 1);
    await snip.addInitScript((url: string) => {
      (window as unknown as Record<string, unknown>).intuitionSnip = { getCapture: async () => url, crop: async () => "", close: () => {} };
    }, `data:image/png;base64,${frozen}`);
    await snip.goto(`${runner.url}/assets/snip.html`);
    await snip.waitForFunction(() => (window as unknown as { snipReady?: Promise<boolean> }).snipReady?.then((ok) => ok));
    await snip.waitForFunction(() => document.querySelector("#workspace-name")?.textContent !== "no workspace", undefined, { timeout: 3000 }).catch(() => {});
    // Around the code block of the answer.
    await snip.mouse.move(384, 320);
    await snip.mouse.down();
    await snip.mouse.move(1080, 432, { steps: 10 });
    await snip.mouse.up();
    await snip.locator("#box").waitFor();
    // Tab steps through the workspaces: on to the one the answer is from.
    for (let i = 0; i < WORKSPACES.length && (await snip.locator("#workspace-name").textContent()) !== "billing-api"; i++) await snip.keyboard.press("Tab");
    await snip.locator("#task").fill("Use this pattern in the other date tests too");
    await save(snip, `snip-${scheme}`);
    await snip.context().close();
  }

  // 3. The dock, open on the session that waits for an Allow or Deny. The dock is dark in both schemes.
  console.log("dock");
  const dock = await page({ ...DOCK_WINDOW }, "dark");
  await dock.addInitScript(() => {
    (window as unknown as Record<string, unknown>).intuitionDock = { setState: () => {} };
  });
  await dock.goto(`${runner.url}/dock`);
  await dock.locator("#pill").waitFor();
  await dock.rest();
  // It peeks for what happens while it watches: the session that asks starts now.
  await waitingSession();
  await dock.locator("#peek-title").waitFor();
  await dock.rest();
  await save(dock, "dock-peek", { omitBackground: true, clip: { x: 0, y: 0, width: DOCK_WINDOW.width, height: 48 } });
  await dock.mouse.move(DOCK_WINDOW.width / 2, 8);
  await dock.locator("#panel").waitFor();
  await dock.locator(".approval").first().waitFor();
  await dock.rest();
  await save(dock, "dock-open", { omitBackground: true });
  await dock.context().close();

  const foreign = requested.filter((u) => !u.startsWith(runner.url) && !u.startsWith("data:"));
  if (foreign.length) throw new Error(`the pages asked another host: ${foreign.join(", ")}`);
  console.log(`wrote ${written.length} screenshots to ${OUT}`);
} finally {
  await browser.close();
  await runner.stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
