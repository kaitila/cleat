// Drives the dock in headless Chromium: `bun test/web/dock-ui.ts`.
// This machine only: it needs the playwright that is installed globally for bun and its browser,
// and prints a "skipped" line and exits 0 where there is none (and in CI).
// The runner is real, on a free port with temp folders, with the fake agent (INTUITION_FAKE_AGENT=1),
// slowed down so a running session can be seen. The shell is a stand-in: a window.intuitionDock that
// records each setState call and resizes the viewport to the contract's size, as the shell resizes
// its window (docs/protocol.md, "Dock").
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDriver } from "../../src/runner/agent-fake";
import { Store } from "../../src/runner/store";
import { DOCK_SIZES, type DockState } from "../../shell/src/dock";
import { testRunner } from "../runner/helpers";

const PLAYWRIGHT = join(homedir(), ".bun", "install", "global", "node_modules", "playwright");
/** Markup that would run if any of it reached the page as HTML. */
const HOSTILE = '<img src=x onerror="window.__xss=1">';
/** The fake agent waits this long between its steps: a turn takes a second or two. */
const STEP_MS = 250;

function skip(why: string): never {
  console.log(`dock-ui: skipped (${why})`);
  process.exit(0);
}

// Playwright isn't a dependency of this project, so it has no types here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function launch(): Promise<Any> {
  if (process.env.CI) skip("CI is set: no browser there");
  if (!existsSync(PLAYWRIGHT)) skip(`no playwright at ${PLAYWRIGHT}`);
  try {
    const playwright: Any = await import(PLAYWRIGHT);
    return await (playwright.chromium ?? playwright.default.chromium).launch();
  } catch (e) {
    skip(`no browser available: ${String((e as Error).message ?? e).split("\n")[0]}`);
  }
}

const passed: string[] = [];
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`failed: ${what}`);
  passed.push(what);
  console.log(`  ok  ${what}`);
}

/** One setState call, as the stand-in saw it: the state, and what the page showed at that moment. */
interface Call { state: DockState; at: number; panelShown: boolean; peekShown: boolean; islandWidth: number; islandHeight: number }

/** An older session full of text that must stay text. */
function seed(dataDir: string): string {
  const store = new Store(dataDir);
  const id = crypto.randomUUID();
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  store.create({ id, claudeSessionId: null, workspace: "work", cwd: "/nowhere", title: HOSTILE, status: "idle", createdAt: at, updatedAt: at, lastSeq: 0 });
  store.append(id, { kind: "user", text: `${HOSTILE}\nsecond line` });
  store.append(id, { kind: "tool_use", toolUseId: "t1", name: "Read", input: { file_path: `/tmp/${HOSTILE}.txt` } });
  store.append(id, { kind: "tool_result", toolUseId: "t1", content: HOSTILE, isError: true });
  store.append(id, { kind: "approval_request", approvalId: "a1", toolUseId: "t2", toolName: HOSTILE, input: { command: `echo ${HOSTILE}` }, reason: `because ${HOSTILE}` });
  store.append(id, { kind: "approval_resolved", approvalId: "a1", decision: "deny" });
  store.append(id, { kind: "assistant_text", text: `Markup stays text: ${HOSTILE}\n\nRun \`bun test\`:\n\n\`\`\`ts\nconst html = '${HOSTILE}';\n\`\`\`` });
  store.append(id, { kind: "result", ok: true, durationMs: 4200, costUsd: 0.031 });
  // Appending set the time to now: put it back three hours, so the sessions started below are newer.
  store.get(id)!.updatedAt = at;
  store.create(store.get(id)!);
  return id;
}

const browser = await launch();
const dir = mkdtempSync(join(tmpdir(), "intuition-dock-ui-"));
const shots = mkdtempSync(join(tmpdir(), "intuition-dock-shots-"));
const hostileId = seed(join(dir, "data"));
const runner = testRunner({ dir, driver: fakeDriver(STEP_MS) });
let failed = false;
/** Every URL the pages asked for: none may be on another host. */
const requested: string[] = [];
const pageErrors: string[] = [];

/** A dock page in a window of the idle size, with the stand-in for the shell's bridge. */
async function dock(colorScheme: "light" | "dark", bridge = true) {
  const context = await browser.newContext({ viewport: bridge ? { ...DOCK_SIZES.idle } : { width: 1000, height: 700 }, colorScheme });
  context.on("request", (r: Any) => requested.push(r.url()));
  const page = await context.newPage();
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  page.on("console", (m: Any) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  if (bridge) {
    await page.exposeFunction("__resize", (state: DockState) => page.setViewportSize({ ...DOCK_SIZES[state] }));
    await page.addInitScript(() => {
      const w = window as Any;
      w.__calls = [];
      // What the shell's preload gives the page: setState and nothing else.
      w.intuitionDock = {
        setState(state: string) {
          const island = document.getElementById("island")?.getBoundingClientRect();
          const shown = (id: string) => document.getElementById(id)?.hidden === false;
          w.__calls.push({ state, at: Date.now(), panelShown: shown("panel"), peekShown: shown("peek"), islandWidth: island?.width ?? 0, islandHeight: island?.height ?? 0 });
          void w.__resize(state);
        },
      };
    });
  }
  const calls = () => page.evaluate(() => (window as Any).__calls) as Promise<Call[]>;
  const lastCall = async () => (await calls()).at(-1)!;
  const text = (selector: string) => page.locator(selector).allTextContents() as Promise<string[]>;
  /** Waits until the shell has been told `state` and the island has finished changing size. */
  const settle = async (state: DockState) => {
    await page.waitForFunction((s: string) => (window as Any).__calls.at(-1)?.state === s, state);
    await page.waitForFunction(
      ([w, h]: number[]) => {
        const r = document.getElementById("island")!.getBoundingClientRect();
        return r.width === w && r.height === h && window.innerWidth === w && window.innerHeight === h;
      },
      [DOCK_SIZES[state].width, DOCK_SIZES[state].height],
    );
  };
  /** What is outside the state's window: nothing may be. Returns the reasons, none when all is inside. */
  const outside = (state: DockState) =>
    page.evaluate(
      ([w, h, view]: [number, number, string]) => {
        const why: string[] = [];
        const root = document.documentElement;
        if (window.innerWidth !== w || window.innerHeight !== h) why.push(`the window is ${window.innerWidth}x${window.innerHeight}`);
        if (root.scrollWidth > w || root.scrollHeight > h) why.push(`the page is ${root.scrollWidth}x${root.scrollHeight} and scrolls`);
        if (getComputedStyle(document.body).overflow !== "hidden") why.push("the body may scroll");
        const island = document.getElementById("island")!;
        const r = island.getBoundingClientRect();
        if (r.left !== 0 || r.top !== 0 || r.width !== w || r.height !== h) why.push(`the island is at ${r.left},${r.top} ${r.width}x${r.height}`);
        if (getComputedStyle(island).overflow !== "hidden") why.push("the island does not clip its content");
        if (getComputedStyle(island).boxShadow !== "none") why.push("the island has a shadow, which would be cut by the window");
        const bg = getComputedStyle(document.body).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)") why.push(`the page's background is ${bg}, not transparent`);
        // Everything the state shows lies inside the window, except what a scrolling box holds.
        for (const el of document.getElementById(view)!.querySelectorAll("*")) {
          if (el.closest(".scroller > *, .sessions > *") || (el as HTMLElement).offsetParent === null) continue;
          const b = el.getBoundingClientRect();
          if (b.left < -0.5 || b.top < -0.5 || b.right > w + 0.5 || b.bottom > h + 0.5) why.push(`<${el.tagName.toLowerCase()} class="${el.className}"> reaches ${Math.round(b.right)},${Math.round(b.bottom)}`);
        }
        return why;
      },
      [DOCK_SIZES[state].width, DOCK_SIZES[state].height, state === "idle" ? "pill" : state === "peek" ? "peek" : "panel"] as [number, number, string],
    ) as Promise<string[]>;
  const fits = async (state: DockState) => {
    const why = await outside(state);
    check(why.length === 0, `${colorScheme}, ${state}: nothing is drawn or scrolls outside ${DOCK_SIZES[state].width}x${DOCK_SIZES[state].height} (${why.join("; ") || "all inside"})`);
  };
  const shot = async (name: string) => {
    const path = join(shots, `dock-${name}-${colorScheme}.png`);
    await page.waitForTimeout(350);
    await page.screenshot({ path });
    console.log(`  screenshot: ${path}`);
  };
  /** The pointer onto the island, and away from it: out of the window, as on a real screen. */
  const hover = () => page.mouse.move(Math.round(page.viewportSize().width / 2), 20);
  const leave = () => page.mouse.move(page.viewportSize().width + 200, 300);
  return { context, page, calls, lastCall, text, settle, fits, shot, hover, leave };
}

try {
  // ================= light: the whole story =================
  const d = await dock("light");
  const { page } = d;
  await page.goto(`${runner.url}/dock`);
  await page.locator("#pill-text", { hasText: "intuition" }).waitFor();
  await d.settle("idle");
  check((await d.calls()).map((c) => c.state).join(",") === "idle", "on load the page tells the shell 'idle', once");
  check((await page.locator("#pill").getAttribute("data-tone")) === "none" && (await page.locator("#pill-dot").isHidden()), "with nothing going on the pill says 'intuition', dimmed, without a dot");
  check((await page.locator("#peek").isHidden()) && (await page.locator("#panel").isHidden()), "nothing replays on load: no peek for the session that finished before the page connected");
  await page.evaluate(() => document.fonts.ready);
  await d.fits("idle");
  await d.shot("idle-nothing");

  // ---- a session runs, finishes and peeks ----
  const prompt = "Tell me about docks";
  const first = await runner.startSession(prompt);
  await page.locator("#pill-text", { hasText: "1 running" }).waitFor();
  check((await page.locator("#pill-dot").getAttribute("data-status")) === "running" && (await page.locator("#pill-dot").isVisible()), "idle says '1 running' with the running dot while a session runs");
  check((await d.lastCall()).state === "idle", "a running session changes the pill, not the state");
  await d.fits("idle");
  await d.shot("idle-running");

  await page.locator("#peek-title", { hasText: prompt }).waitFor();
  await d.settle("peek");
  const peekCall = await d.lastCall();
  check(peekCall.state === "peek" && !peekCall.peekShown && peekCall.islandWidth === DOCK_SIZES.idle.width, "when it finishes the shell is told 'peek' first, before the island grows");
  check((await page.locator("#peek-title").textContent()) === prompt, "the peek shows the session's title");
  check((await page.locator("#peek-body").textContent()) === `You said: ${prompt}`, "and the start of the answer, on one line");
  check((await page.locator("#peek-label").textContent()) === "done" && (await page.locator("#pill").isHidden()), "it says 'done', in place of the pill");
  await d.fits("peek");
  await d.shot("peek-finished");
  await page.locator("#pill").waitFor({ timeout: 8000 });
  await d.settle("idle");
  const backCall = await d.lastCall();
  check(backCall.state === "idle" && backCall.islandWidth === DOCK_SIZES.idle.width && backCall.islandHeight === DOCK_SIZES.idle.height, "it returns to idle: the island shrinks first, and the shell is told once it is small");
  check(backCall.at - peekCall.at >= 4800 && backCall.at - peekCall.at < 7000, `after about five seconds (${backCall.at - peekCall.at} ms)`);
  check((await page.locator("#pill-text").textContent()) === "intuition", "and the pill is quiet again");

  // ---- a session that needs approval peeks and stays ----
  const needs = "this one needs approval";
  const waiting = await runner.startSession(needs);
  await page.locator("#peek-title", { hasText: needs }).waitFor();
  await d.settle("peek");
  check((await page.locator("#peek-label").textContent()) === "needs you" && (await page.locator("#peek").getAttribute("data-kind")) === "needs_approval", "a session that needs approval peeks and says 'needs you'");
  check((await page.locator("#peek-body").textContent()) === `Write: ${runner.dir}/work/fake.txt`, "with the tool and its target");
  check((await page.locator("#pill-text").textContent()) === "needs you" && (await page.locator("#pill").getAttribute("data-tone")) === "needs", "and the pill behind it says 'needs you'");
  await d.fits("peek");
  await d.shot("peek-approval");
  await page.waitForTimeout(6000);
  check((await page.locator("#peek").isVisible()) && (await d.lastCall()).state === "peek", "six seconds later the peek is still there: it stays until answered or opened");

  // ---- hovering opens ----
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  const openCall = await d.lastCall();
  check(openCall.state === "open" && !openCall.panelShown && openCall.islandHeight === DOCK_SIZES.peek.height, "hovering opens: setState('open') is called before the content shows");
  check((await page.locator('.session-row[aria-current="true"] .row-title').textContent()) === needs, "the session that peeked and needs approval is preselected");
  check((await d.text(".row-title")).join("|") === [needs, prompt, HOSTILE].join("|"), "the list has the sessions, newest activity first");
  check((await page.locator('.session-row[aria-current="true"] .row-workspace').textContent()) === "work" && (await d.text(".row-time")).join(",") === "now,now,3h", "each with its workspace and a short relative time");
  check((await page.locator('.session-row[aria-current="true"] .dot').getAttribute("data-status")) === "waiting_approval", "and a status dot");
  const card = page.locator(".approval");
  await card.locator("button", { hasText: "Allow" }).waitFor();
  check((await card.getAttribute("data-state")) === "open" && (await d.text(".approval-actions button")).join(",") === "Allow,Deny", "the open approval is a card with Allow and Deny");
  check((await card.locator(".approval-tool").textContent()) === "Write" && (await card.locator(".approval-path").textContent()) === `${runner.dir}/work/fake.txt`, "that names the tool and the file");
  check((await page.locator("#reply-text").isDisabled()) && (await page.locator("#reply-hint").textContent()) === "Waiting for your Allow or Deny above.", "the reply box is off, with a short hint, while it waits");
  check((await page.locator("#open-chat").getAttribute("href")) === `/?session=${waiting.id}` && (await page.locator("#open-chat").getAttribute("target")) === "_blank", "'Open in chat' is a new window on /?session=<id>");
  check((await page.locator(".panel-head a", { hasText: "New task" }).getAttribute("href")) === "/prompt" && (await page.locator(".panel-head a").getAttribute("target")) === "_blank", "'New task' is a new window on /prompt");
  await d.fits("open");
  await d.shot("open-approval");

  // ---- leaving closes; unanswered, the pill says so ----
  await d.leave();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  const closedCall = await d.lastCall();
  check(closedCall.islandHeight === DOCK_SIZES.idle.height, "the pointer leaves and the dock closes: the island shrinks, then the shell is told 'idle'");
  check(closedCall.at - openCall.at >= 400, "not sooner than 400 ms after the pointer left");
  check((await page.locator("#pill-text").textContent()) === "needs you" && (await page.locator("#pill-dot").getAttribute("data-status")) === "waiting_approval", "opened but not answered: no peek again, and the pill says 'needs you'");
  const warn = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--warn)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  check((await page.locator("#pill-text").evaluate((el: Element) => getComputedStyle(el).color)) === warn, "in the approval colour");
  await d.fits("idle");
  await d.shot("idle-needs-you");

  // ---- Allow in the dock ----
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  check((await page.locator('.session-row[aria-current="true"] .row-title').textContent()) === needs, "opened again, the session that needs approval is preselected");
  await card.locator("button", { hasText: "Allow" }).click();
  await page.locator('.approval[data-state="allow"]').waitFor();
  check((await card.locator(".approval-state").textContent()) === "Allowed" && (await card.locator("button").count()) === 0, "Allow in the dock resolves the approval: the card says Allowed, without buttons");
  await page.locator(".msg.streaming").waitFor();
  check(true, "the turn goes on and its answer streams in");
  await page.locator(".msg.assistant:not(.streaming)", { hasText: "The tool call was allowed." }).waitFor();
  await page.locator(".note", { hasText: "Done" }).waitFor();
  check((await page.locator(".msg.streaming").count()) === 0 && (await page.locator(".msg.assistant").count()) === 1, "the streamed text is replaced by the complete text, once");
  check((await d.text(".tool-row .tool-name")).join(",") === "Write" && (await d.text(".tool-row .tool-line")).join(",") === `${runner.dir}/work/fake.txt`, "the tool call is a one-line row");
  check((await d.lastCall()).state === "open" && (await page.locator("#peek").isHidden()), "no peek while the dock is open: the turn finished and the list shows it");
  check((await page.locator("#pill-text").textContent()) === "intuition", "and the pill no longer says 'needs you'");

  // ---- continuing the session ----
  const box = page.locator("#reply-text");
  await page.locator("#reply-text:not([disabled])").waitFor();
  check((await page.locator("#reply-hint").textContent()) === "Enter to send, Shift+Enter for a new line", "the turn over, the reply box is on");
  await box.click();
  await box.fill("first line");
  await box.press("Shift+Enter");
  check((await box.inputValue()) === "first line\n", "Shift+Enter is a new line and sends nothing");
  const reply = "and what then?";
  await box.fill(reply);
  await box.press("Enter");
  await page.locator(".msg.user", { hasText: reply }).waitFor();
  check(true, "typing a reply and pressing Enter shows the reply");
  await page.locator("#reply-text[disabled]").waitFor();
  check((await page.locator("#reply-hint").textContent()) === "Working. You can reply when this turn ends.", "the box is off, with a hint, while the session runs");
  await page.locator(".msg.streaming").waitFor();
  check(true, "the new answer streams in");
  await page.locator(".msg.assistant:not(.streaming)", { hasText: `You said: ${reply}` }).waitFor();
  await page.locator("#reply-text:not([disabled])").waitFor();
  check((await box.inputValue()) === "" && (await page.evaluate(() => document.activeElement?.id)) === "reply-text", "then the box is empty, on, and has the focus back");
  check((await page.locator(".msg.user").count()) === 2 && (await page.locator(".msg.assistant").count()) === 2, "each message is in the stream once");
  check(await page.evaluate(() => {
    const s = document.getElementById("scroller")!;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 4;
  }), "and the stream is scrolled to the bottom");
  await d.fits("open");
  await d.shot("open-replied");

  // ---- what keeps it open ----
  await d.leave();
  await page.waitForTimeout(900);
  check((await page.locator("#panel").isVisible()) && (await d.lastCall()).state === "open", "the pointer away, the dock stays open while the reply box has the focus");
  await box.fill("half a reply");
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.waitForTimeout(900);
  check((await page.locator("#panel").isVisible()) && (await d.lastCall()).state === "open", "and, the focus gone, while the box has text in it");
  await d.hover();
  await box.fill("");
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.waitForTimeout(900);
  check(await page.locator("#panel").isVisible(), "cleared, it stays open while the pointer is on it");
  await d.leave();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  check(true, "and closes once the box is cleared and the pointer leaves");

  // ---- the pointer held down, Esc, and a pointer that only passes ----
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  await page.mouse.down();
  await d.leave();
  await page.waitForTimeout(900);
  check(await page.locator("#panel").isVisible(), "it stays open while the pointer is held down, even outside");
  await page.mouse.up();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  check(true, "and closes when it is let go there");
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  await page.keyboard.press("Escape");
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  check(true, "Esc closes it, with the pointer still on it");
  await d.leave();
  const before = (await d.calls()).length;
  await d.hover();
  await d.leave();
  await page.waitForTimeout(500);
  check((await d.calls()).length === before && (await page.locator("#pill").isVisible()), "a pointer that only crosses the pill opens nothing");

  // ---- a failed session ----
  const failing = await runner.startSession("please fail");
  await page.locator("#peek-title", { hasText: "please fail" }).waitFor();
  await d.settle("peek");
  check((await page.locator("#peek-label").textContent()) === "failed" && (await page.locator("#peek-body").textContent()) === "the fake agent failed", "a failed session peeks with the error's message");
  await d.shot("peek-error");
  await page.locator("#pill").waitFor({ timeout: 8000 });
  await d.settle("idle");
  check((await page.locator("#pill-text").textContent()) === "failed" && (await page.locator("#pill-dot").getAttribute("data-status")) === "error", "and the pill then carries an error mark: the newest finished one failed");
  await d.shot("idle-failed");
  await d.hover();
  await page.locator("#panel").waitFor();
  await d.settle("open");
  check((await page.locator('.session-row[aria-current="true"] .row-title').textContent()) === "please fail", "opened after a peek, the session that peeked last is preselected");
  await page.locator(".error", { hasText: "the fake agent failed" }).waitFor();
  check((await page.locator("#reply-text").isEnabled()) && (await page.locator("#reply-hint").textContent()) === "The last turn failed. A reply tries again.", "its error is in the stream, and a reply may try again");
  void failing;

  // ---- untrusted text, and picking another session ----
  await page.locator(".session-row", { hasText: "<img" }).click();
  await page.locator(".note", { hasText: "Done · 4.2 s · $0.031" }).waitFor();
  check((await page.locator("#title").textContent()) === HOSTILE && (await page.locator("#open-chat").getAttribute("href")) === `/?session=${hostileId}`, "clicking a row selects that session");
  check((await page.locator("body img, body script").count()) === 0 && (await page.evaluate(() => (window as Any).__xss)) === undefined, "markup in a title, a prompt, an answer, a tool call and an approval made no element and ran nothing");
  check((await d.text(".msg.user"))[0] === `${HOSTILE}\nsecond line` && (await d.text(".msg.assistant p"))[0] === `Markup stays text: ${HOSTILE}`, "the user's and the assistant's text are shown as text");
  check((await d.text(".tool-row .tool-line"))[0] === `/tmp/${HOSTILE}.txt` && (await d.text(".tool-row .tool-mark"))[0] === "failed", "a failed tool call is marked on its row");
  check((await page.locator(".approval").getAttribute("data-state")) === "deny" && (await page.locator(".approval button").count()) === 0 && (await page.locator(".approval-tool").textContent()) === HOSTILE, "a decided approval is a quiet card without buttons");
  check((await d.text(".msg.assistant p code"))[0] === "bun test" && (await d.text(".msg.assistant pre.code-block"))[0] === `const html = '${HOSTILE}';`, "inline code and a code block are rendered");
  await d.fits("open");
  await d.shot("open-hostile");
  await d.leave();
  await page.locator("#pill").waitFor();
  await d.settle("idle");
  await d.context.close();

  // ================= dark: the three states again =================
  const k = await dock("dark");
  await k.page.goto(`${runner.url}/dock`);
  await k.page.locator("#pill-text", { hasText: "failed" }).waitFor();
  await k.settle("idle");
  await k.page.evaluate(() => document.fonts.ready);
  const darkPrompt = "A second look, in the dark";
  await runner.startSession(darkPrompt);
  await k.page.locator("#pill-text", { hasText: "1 running" }).waitFor();
  check((await k.page.locator("#pill-failed").isVisible()) && (await k.page.locator("#pill-dot").getAttribute("data-status")) === "running", "beside '1 running' a red dot still marks that the newest finished one failed");
  await k.fits("idle");
  await k.shot("idle-running");
  await k.page.locator("#peek-title", { hasText: darkPrompt }).waitFor();
  await k.settle("peek");
  await k.fits("peek");
  await k.shot("peek-finished");
  await k.hover();
  await k.page.locator("#panel").waitFor();
  await k.settle("open");
  await k.page.locator(".note", { hasText: "Done" }).waitFor();
  check((await k.page.locator('.session-row[aria-current="true"] .row-title').textContent()) === darkPrompt, "dark: opened from a peek, its session is selected");
  await k.fits("open");
  await k.shot("open");
  const colours = (p: Any) => p.evaluate(() => [getComputedStyle(document.getElementById("island")!).backgroundColor, getComputedStyle(document.body).color]) as Promise<string[]>;
  const darkColours = await colours(k.page);
  await k.page.emulateMedia({ colorScheme: "light" });
  check((await colours(k.page)).join() === darkColours.join() && darkColours[0] === "rgb(15, 15, 17)", `the island is the same dark in both schemes (${darkColours.join(" on ")})`);
  await k.context.close();

  // ================= a normal browser: no bridge =================
  const b = await dock("light", false);
  await b.page.goto(`${runner.url}/dock`);
  await b.page.locator("#pill-text", { hasText: "intuition" }).waitFor();
  const rect = () => b.page.locator("#island").evaluate((el: Element) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  }) as Promise<number[]>;
  check((await rect()).join() === [360, 0, 280, 40].join(), "without the bridge the pill hangs from the top of the page, in the middle");
  await b.page.mouse.move(500, 20);
  await b.page.locator("#panel").waitFor();
  await b.page.waitForFunction(() => document.getElementById("island")!.getBoundingClientRect().height === 600);
  check((await rect()).join() === [270, 0, 460, 600].join(), "and opens on hover just the same");
  await b.page.mouse.move(900, 650);
  await b.page.locator("#pill").waitFor();
  check(true, "and closes when the pointer leaves the island");
  await b.shot("browser");
  await b.context.close();

  const elsewhere = requested.filter((u) => !/^(?:data|blob|about):/.test(u) && new URL(u).hostname !== "127.0.0.1");
  check(requested.length > 0 && elsewhere.length === 0, `no request left 127.0.0.1 (${elsewhere.join(" ") || "none did"})`);
  check(pageErrors.length === 0, `the page logged no errors (${pageErrors.join(" | ") || "none"})`);
  console.log(`dock-ui: passed (${passed.length} checks)`);
} catch (e) {
  failed = true;
  console.error(`dock-ui: FAILED. ${(e as Error).message}`);
} finally {
  await browser.close();
  await runner.stop();
}
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
