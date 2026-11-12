// Drives the chat view in headless Chromium: `bun test/web/chat-ui.ts`.
// This machine only: it needs the playwright that is installed globally for bun and its browser,
// and prints a "skipped" line and exits 0 where there is none (and in CI).
// The runner is real, on a free port with temp folders, with the fake agent (INTUITION_FAKE_AGENT=1).
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/runner/store";
import { startServer, type Runner } from "../../src/runner/server";
import { testRunner } from "../runner/helpers";

const PLAYWRIGHT = join(homedir(), ".bun", "install", "global", "node_modules", "playwright");
/** Markup that would run if any of it reached the page as HTML. */
const HOSTILE = '<img src=x onerror="window.__xss=1">';

function skip(why: string): never {
  console.log(`chat-ui: skipped (${why})`);
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

/** A stored session full of text that must stay text, with a failed tool call and a long result. */
function seed(dataDir: string): string {
  const store = new Store(dataDir);
  const id = crypto.randomUUID();
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  store.create({ id, claudeSessionId: null, workspace: "work", cwd: "/nowhere", title: HOSTILE, status: "idle", createdAt: at, updatedAt: at, lastSeq: 0 });
  const long = [HOSTILE, ...Array.from({ length: 120 }, (_, i) => `line ${i + 1}`), "the last line"].join("\n");
  store.append(id, { kind: "user", text: `${HOSTILE}\nsecond line`, imagePath: "/mnt/c/Users/x/AppData/Local/Temp/intuition/clip-1.png" });
  store.append(id, { kind: "tool_use", toolUseId: "t1", name: "Read", input: { file_path: `/tmp/${HOSTILE}.txt` } });
  store.append(id, { kind: "tool_result", toolUseId: "t1", content: long, isError: true });
  store.append(id, { kind: "approval_request", approvalId: "a1", toolName: "Write", input: { file_path: "/tmp/x" } });
  store.append(id, { kind: "assistant_text", text: `Markup stays text: ${HOSTILE}\n\nRun \`bun test\` like this:\n\n\`\`\`ts\nconst html = '${HOSTILE}';\n\`\`\`\n\nThat is all.` });
  store.append(id, { kind: "result", ok: true, durationMs: 4200, costUsd: 0.031 });
  // Appending set the time to now: put it back three hours, so the session started below is the newest.
  store.get(id)!.updatedAt = at;
  store.create(store.get(id)!);
  return id;
}

const browser = await launch();
const dir = mkdtempSync(join(tmpdir(), "intuition-chat-ui-"));
const shots = mkdtempSync(join(tmpdir(), "intuition-chat-shots-"));
const hostileId = seed(join(dir, "data"));
const api = testRunner({ dir });
let runner: Runner = api;
let failed = false;

try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, colorScheme: "light" });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  page.on("console", (m: Any) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  const text = (selector: string) => page.locator(selector).allTextContents() as Promise<string[]>;
  const shot = async (name: string) => {
    const path = join(shots, `${name}.png`);
    await page.screenshot({ path });
    console.log(`  screenshot: ${path}`);
  };

  // ---- a session started through the API, with a tool call ----
  const prompt = "Please use tool and then tell me";
  const session = await api.startSession(prompt);
  await page.goto(`${runner.url}/`);
  await page.locator(".session", { hasText: prompt }).waitFor();
  check(true, "the session is in the sidebar");
  check((await page.locator('.session[aria-current="true"] .session-title').textContent()) === prompt, "with no ?session, the newest session is selected");
  check((await page.locator('.session[aria-current="true"] .session-workspace').textContent()) === "work", "the sidebar shows its workspace");
  check(await page.locator('.session[aria-current="true"] .dot[data-status]').count(), "and a status dot");
  check((await page.locator(".new-task").getAttribute("href")) === "/prompt", "'New task' links to /prompt");

  await page.locator(".msg.assistant:not(.streaming)", { hasText: `You said: ${prompt}` }).waitFor();
  check(true, "the assistant text arrives");
  check((await text(".msg.user .user-text"))[0] === prompt, "the prompt is shown as the user's message");
  const tool = page.locator("details.tool");
  check((await tool.count()) === 1, "the tool call and its result are one <details>");
  check((await tool.evaluate((el: HTMLDetailsElement) => el.open)) === false, "the tool call is closed");
  check((await tool.locator(".tool-name").textContent()) === "Bash", "its summary names the tool");
  check((await tool.locator(".tool-line").textContent()) === "echo fake", "and shows the command");
  await tool.locator("summary").click();
  check((await tool.locator(".tool-result").textContent()) === "fake", "opened, it shows the result");
  check((await tool.locator(".tool-input").textContent())?.includes('"command": "echo fake"'), "and the input");
  await page.locator(".note", { hasText: "Done" }).waitFor();
  check((await page.locator(".msg.streaming").count()) === 0, "the streamed text was replaced by the complete text");
  check((await page.locator(".msg.assistant").count()) === 1, "and is on the page once");
  await page.locator("#reply-text:not([disabled])").waitFor();
  check(true, "the reply box is enabled once the turn has ended");
  await tool.locator("summary").click();
  await shot("chat-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("chat-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // ---- replying ----
  const reply = "and a second message";
  const box = page.locator("#reply-text");
  await box.fill("first line");
  await box.press("Shift+Enter");
  check((await box.inputValue()) === "first line\n", "Shift+Enter is a new line and sends nothing");
  // A runner without the reply route answers 404: the page says so quietly and keeps what was typed.
  const messages = `**/api/sessions/${session.id}/messages`;
  await page.route(messages, (route: Any) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) }));
  await box.fill(reply);
  await box.press("Enter");
  await page.locator("#reply-hint", { hasText: "Couldn't send: not found" }).waitFor();
  check((await box.inputValue()) === reply, "a 404 from the reply route is shown quietly and the typed reply is kept");
  check((await page.locator(".error").count()) === 0 && (await page.locator(".msg.user").count()) === 1, "and nothing is added to the stream");
  await page.unroute(messages);
  await box.press("Enter");
  await page.locator(".msg.user .user-text", { hasText: reply }).waitFor();
  check(true, "typing a reply and pressing Enter shows the reply");
  await page.locator(".msg.assistant:not(.streaming)", { hasText: `You said: ${reply}` }).waitFor();
  check(true, "and a new answer");
  await page.locator("#reply-text:not([disabled])").waitFor();
  check((await box.inputValue()) === "", "the reply box is empty and enabled again");
  check(await page.evaluate(() => document.activeElement?.id === "reply-text"), "and has the focus back");
  check((await page.locator(".msg.user").count()) === 2 && (await page.locator(".msg.assistant").count()) === 2, "each message is on the page once");

  // ---- untrusted text, a failed tool call, a long result, an unknown event ----
  await page.locator(".session", { hasText: "<img" }).click();
  check(new URL(page.url()).searchParams.get("session") === hostileId, "clicking a session selects it and puts it in the URL");
  await page.goto(`${runner.url}/?session=${hostileId}`);
  await page.locator(".note", { hasText: "Done · 4.2 s · $0.031" }).waitFor();
  check((await page.locator('.session[aria-current="true"] .session-title').textContent()) === HOSTILE, "/?session=<id> opens that session");
  check((await page.locator(".session-time").last().textContent()) === "3h", "the sidebar shows a short relative time, oldest activity last");
  check((await page.locator("body img, body script").count()) === 0 && (await page.evaluate(() => (window as Any).__xss)) === undefined, "markup in a title, a prompt, an answer and a tool result made no element and ran nothing");
  const bad = page.locator("details.tool");
  check((await bad.locator(".tool-result").textContent())?.startsWith(`${HOSTILE}\nline 1\n`), "a tool result containing <img onerror> is shown as text");
  check((await text(".msg.user .user-text"))[0] === `${HOSTILE}\nsecond line`, "so is the user's text");
  check((await text(".msg.assistant p"))[0] === `Markup stays text: ${HOSTILE}`, "and the assistant's");
  check((await text(".msg.user .attachment"))[0] === "/mnt/c/Users/x/AppData/Local/Temp/intuition/clip-1.png", "an imagePath is shown as its path");
  check((await text(".msg.assistant p code"))[0] === "bun test", "inline code is rendered");
  check((await text(".msg.assistant pre.code-block"))[0] === `const html = '${HOSTILE}';`, "a fenced code block is rendered");
  check((await bad.evaluate((el: HTMLDetailsElement) => el.open)) === false, "the failed tool call is closed too");
  check((await bad.locator(".tool-mark").textContent()) === "failed" && (await bad.getAttribute("data-error")) === "true", "an error result is marked");
  check((await bad.locator(".tool-line").textContent()) === `/tmp/${HOSTILE}.txt`, "a file tool's summary is its path");
  await bad.locator("summary").click();
  check(!(await bad.locator(".tool-result").textContent())?.includes("the last line"), "a long result is cut");
  await shot("chat-tool-open-light");
  await bad.locator("button.show-all").click();
  check((await bad.locator(".tool-result").textContent())?.endsWith("the last line"), "'show all' shows all of it");
  check((await text(".note")).includes("approval request: Write"), "an unknown event kind is a quiet one-line note");
  check((await page.locator(".error").count()) === 0, "and not an error");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("chat-tool-open-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 720 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "nothing scrolls sideways at 390 wide");
  await shot("chat-narrow-light");
  await page.setViewportSize({ width: 1100, height: 720 });

  // ---- staying at the bottom, unless the person scrolled up ----
  await page.goto(`${runner.url}/?session=${hostileId}`);
  await page.locator(".note", { hasText: "Done" }).waitFor();
  await page.locator("details.tool summary").click();
  await page.locator("button.show-all").click();
  const atBottom = () => page.evaluate(() => {
    const s = document.getElementById("scroller")!;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 4;
  });
  await page.evaluate(() => (document.getElementById("scroller")!.scrollTop = 0));
  await page.waitForTimeout(100);
  check(!(await atBottom()), "the person can scroll up in a long session");

  // ---- the runner goes away and comes back ----
  const port = runner.port;
  await runner.stop();
  await page.locator("#connection", { hasText: "reconnecting" }).waitFor();
  check(true, "when the WebSocket closes the page says 'reconnecting'");
  runner = startServer({ ...api.config, port });
  await page.locator("#connection").waitFor({ state: "hidden" });
  check(true, "and it reconnects by itself");
  const post = (path: string, body: unknown) => fetch(runner.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const later = "started after the restart";
  check((await post("/api/sessions", { workspace: "work", prompt: later })).status === 201, "a session starts on the restarted runner");
  await page.locator(".session", { hasText: later }).waitFor();
  check((await text(".session-title"))[0] === later, "a session started afterwards appears at the top of the sidebar");
  check((await page.locator('.session[aria-current="true"] .session-title').textContent()) === HOSTILE, "without taking the selection");
  check(!(await atBottom()), "and the stream stays where the person scrolled to");

  // ---- no sessions at all ----
  const empty = testRunner();
  try {
    await page.goto(`${empty.url}/?session=nothing`);
    await page.locator("#empty").waitFor();
    check((await page.locator("#sessions-empty").isVisible()) && (await page.locator("#reply").isHidden()), "with no sessions there is a quiet empty state and no reply box");
    await shot("chat-empty-light");
  } finally {
    await empty.stop();
  }

  check(pageErrors.length === 0 || pageErrors.every((e) => /WebSocket|ERR_CONNECTION_REFUSED|404/.test(e)), `the page logged no errors of its own (${pageErrors.join(" | ") || "none"})`);
  console.log(`chat-ui: passed (${passed.length} checks)`);
} catch (e) {
  failed = true;
  console.error(`chat-ui: FAILED. ${(e as Error).message}`);
} finally {
  await browser.close();
  await runner.stop();
}
console.log(`screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
