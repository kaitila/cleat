// Drives the chat view in headless Chromium: `bun test/web/chat-ui.ts`.
// This machine only: it needs the playwright that is installed globally for bun and its browser,
// and prints a "skipped" line and exits 0 where there is none (and in CI).
// The runner is real, on a free port with temp folders, with the fake agent (INTUITION_FAKE_AGENT=1).
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDriver } from "../../src/runner/agent-fake";
import { Store } from "../../src/runner/store";
import { startServer, type Runner } from "../../src/runner/server";
import { testRunner } from "../runner/helpers";
import { MARKDOWN_EXPECTED, markdownProblems, seedMarkdown } from "./markdown-sample";
import { assistantEntry, MemoryTranscripts, userEntry } from "./chat-transcripts";

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

/**
 * A headless Chromium. `args` are its command line: an emulated deviceScaleFactor alone still snaps
 * borders to whole CSS pixels, so the 2x pass starts one with --force-device-scale-factor=2.
 */
async function launch(args: string[] = []): Promise<Any> {
  if (process.env.CI) skip("CI is set: no browser there");
  if (!existsSync(PLAYWRIGHT)) skip(`no playwright at ${PLAYWRIGHT}`);
  try {
    const playwright: Any = await import(PLAYWRIGHT);
    return await (playwright.chromium ?? playwright.default.chromium).launch({ args });
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
  store.append(id, { kind: "approval_request", approvalId: "a2", toolUseId: "t2", toolName: "Bash", input: { command: `echo ${HOSTILE}` }, reason: `because ${HOSTILE}` });
  store.append(id, { kind: "approval_resolved", approvalId: "a2", decision: "deny" });
  store.append(id, { kind: "approval_request", approvalId: "a3", toolName: HOSTILE, input: { query: HOSTILE, lines: Array.from({ length: 40 }, (_, i) => `row ${i}`) } });
  store.append(id, { kind: "approval_resolved", approvalId: "a3", decision: "allow" });
  // A kind this page doesn't know (a newer runner's).
  store.append(id, { kind: "compacted" } as never);
  store.append(id, { kind: "assistant_text", text: `Markup stays text: ${HOSTILE}\n\nRun \`bun test\` like this:\n\n\`\`\`ts\nconst html = '${HOSTILE}';\n\`\`\`\n\nThat is all.` });
  store.append(id, { kind: "result", ok: true, durationMs: 4200, costUsd: 0.031 });
  // Appending set the time to now: put it back three hours, so the session started below is the newest.
  store.get(id)!.updatedAt = at;
  store.create(store.get(id)!);
  markdownId = seedMarkdown(store);
  return id;
}
let markdownId = "";

const browser = await launch();
const dir = mkdtempSync(join(tmpdir(), "intuition-chat-ui-"));
const shots = mkdtempSync(join(tmpdir(), "intuition-chat-shots-"));
const hostileId = seed(join(dir, "data"));
const api = testRunner({ dir });
let runner: Runner = api;
let failed = false;

try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, colorScheme: "light" });
  /** Every URL the pages asked for: none may be on another host (the fonts are the runner's own files). */
  const requested: string[] = [];
  context.on("request", (r: Any) => requested.push(r.url()));
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  page.on("console", (m: Any) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  const text = (selector: string) => page.locator(selector).allTextContents() as Promise<string[]>;
  const shot = async (name: string) => {
    const path = join(shots, `${name}.png`);
    // Away from whatever was clicked, and after the colour transitions.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
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
  await page.evaluate(() => document.fonts.ready);
  check(await page.evaluate(() => document.fonts.check('13px "Inter Variable"') && document.fonts.check('12px "JetBrains Mono Variable"')), "the interface font and the code font are loaded");
  check(requested.some((u) => new URL(u).pathname === "/assets/fonts/inter-latin.woff2") && requested.some((u) => new URL(u).pathname === "/assets/fonts/jetbrains-mono-latin.woff2"), "from the runner's own /assets/fonts");
  const borderOf = (p: Any) => p.locator(".sidebar").evaluate((el: Element) => getComputedStyle(el).borderRightWidth) as Promise<string>;
  check((await borderOf(page)) === "1px", "a hairline is 1px where a CSS pixel is one device pixel");
  await shot("chat-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("chat-dark");
  await page.emulateMedia({ colorScheme: "light" });
  // The same session at two device pixels per CSS pixel: hairlines become half a CSS pixel.
  const denseBrowser = await launch(["--force-device-scale-factor=2"]);
  for (const colorScheme of ["light", "dark"] as const) {
    const dense = await denseBrowser.newContext({ viewport: { width: 1100, height: 720 }, colorScheme, deviceScaleFactor: 2 });
    dense.on("request", (r: Any) => requested.push(r.url()));
    const densePage = await dense.newPage();
    await densePage.goto(`${runner.url}/?session=${session.id}`);
    await densePage.locator(".note", { hasText: "Done" }).waitFor();
    await densePage.evaluate(() => document.fonts.ready);
    if (colorScheme === "light") check((await borderOf(densePage)) === "0.5px", "and 0.5px where it is two");
    const path = join(shots, `chat-${colorScheme}-2x.png`);
    await densePage.screenshot({ path });
    console.log(`  screenshot: ${path}`);
    await dense.close();
  }
  await denseBrowser.close();

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

  check(await page.locator("#head .resume").isVisible(), "a session with a Claude Code session id offers 'Continue in terminal'");

  // ---- a session from the terminal: its mark, a turn arriving from it, Send anyway, Continue in terminal ----
  {
    const transcripts = new MemoryTranscripts();
    const term = testRunner({ sync: { transcripts, pollMs: 50, idleMs: 400 } });
    try {
      const work = term.config.workspaces.find((w) => w.name === "work")!.path;
      const first = "started in a terminal";
      // Written five minutes ago: imported idle, and not taken as open in a terminal.
      transcripts.write("term-1", work, [userEntry(first), assistantEntry("hello from the terminal")], Date.now() - 5 * 60_000);
      await term.startSession("one of the runner's own");
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: term.url });
      await page.goto(`${term.url}/`);
      const termRow = page.locator(".session", { hasText: first });
      await termRow.waitFor();
      check((await page.locator(".session .terminal-mark").count()) === 1, "only the session from the terminal has the terminal mark");
      const mark = termRow.locator(".terminal-mark");
      check((await mark.getAttribute("title")) === "started in the terminal" && (await mark.textContent()) === ">_", "a quiet glyph whose tooltip says 'started in the terminal'");
      await termRow.click();
      await page.locator(".msg.assistant", { hasText: "hello from the terminal" }).waitFor();
      check(true, "its history is read from the transcript");
      const resumeButton = page.locator("#head .resume");
      check((await resumeButton.textContent()) === "Continue in terminal", "the head offers 'Continue in terminal'");
      await resumeButton.click();
      await page.locator("#head .resume", { hasText: "Copied" }).waitFor();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      check(copied === `cd ${work} && claude --resume term-1`, `it copies the command that continues it (${copied})`);
      check(true, "and says Copied");
      await page.locator("#head .resume", { hasText: "Continue in terminal" }).waitFor({ timeout: 3000 });
      check(true, "then its label comes back");
      // A turn arrives from the terminal: the transcript grows while the runner runs nothing.
      const typedThere = "typed in the terminal";
      transcripts.write("term-1", work, [userEntry(typedThere)]);
      await page.locator("#status", { hasText: "in terminal" }).waitFor();
      check((await page.locator("#dot").getAttribute("data-status")) === "running", "a turn arriving from the terminal: the head says 'in terminal' beside the running dot");
      await page.locator(".msg.user .user-text", { hasText: typedThere }).waitFor();
      check(true, "and its prompt streams in");
      check(!(await page.locator("#reply-text").isDisabled()) && (await page.locator("#reply-hint").textContent()) !== "Working. You can reply when this turn ends.", "the reply box stays on, without the usual running hint");
      await shot("chat-terminal-turn-light");
      const replyBox = page.locator("#reply-text");
      const here = "and this from intuition";
      await replyBox.fill(here);
      await replyBox.press("Enter");
      const anyway = page.locator("#reply-hint button", { hasText: "Send anyway" });
      await anyway.waitFor();
      check((await page.locator("#reply-hint").textContent())?.startsWith("It looks open in a terminal."), "a reply answered 409 'open in a terminal' says so inline");
      check((await replyBox.inputValue()) === here, "and the typed text is kept");
      check((await page.locator(".msg.user").count()) === 2, "and nothing was added to the stream");
      await shot("chat-send-anyway-light");
      await page.emulateMedia({ colorScheme: "dark" });
      await shot("chat-send-anyway-dark");
      await page.emulateMedia({ colorScheme: "light" });
      const bodies: unknown[] = [];
      page.on("request", (req: Any) => {
        if (req.method() === "POST" && req.url().endsWith("/messages")) bodies.push(req.postDataJSON());
      });
      await anyway.click();
      await page.locator(".msg.assistant:not(.streaming)", { hasText: `You said: ${here}` }).waitFor();
      check(JSON.stringify(bodies) === JSON.stringify([{ prompt: here, force: true }]), "'Send anyway' repeats the request with force: true, and it goes through");
      await page.locator("#reply-text:not([disabled])").waitFor();
      check((await replyBox.inputValue()) === "" && (await page.locator("#reply-hint button").count()) === 0, "then the box is empty and the offer gone");
      await page.locator("#status", { hasText: "idle" }).waitFor();
      check(true, "and the head no longer says 'in terminal'");
    } finally {
      await term.stop();
    }
  }

  // ---- a tool call that needs approval ----
  const needs = "this one needs approval";
  const waiting = await api.startSession(needs);
  await page.goto(`${runner.url}/?session=${waiting.id}`);
  const card = page.locator(".approval");
  await card.locator("button", { hasText: "Allow" }).waitFor();
  check((await card.count()) === 1 && (await card.getAttribute("data-state")) === "open", "a call that needs approval is a card in the stream");
  check((await card.locator(".approval-tool").textContent()) === "Write", "it names the tool");
  check((await card.locator(".approval-path").textContent()) === `${api.dir}/work/fake.txt`, "shows the file's path");
  check((await card.locator(".approval-input").textContent()) === "fake", "and what would be written");
  check((await card.locator(".approval-reason").textContent()) === "the fake agent asks before it writes", "and the reason");
  check((await text(".approval-actions button")).join(",") === "Allow,Deny", "with Allow and Deny buttons");
  const colour = (selector: string, property: string) => page.locator(selector).first().evaluate((el: Element, p: string) => getComputedStyle(el).getPropertyValue(p), property) as Promise<string>;
  const warn = await page.evaluate(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(--warn)";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  await page.locator('.session[aria-current="true"] .dot[data-status="waiting_approval"]').waitFor();
  check((await colour('.session[aria-current="true"] .dot', "background-color")) === warn, "the sidebar dot of a session waiting for approval is amber");
  check((await colour(".approval", "border-left-color")) === warn, "and the open card is accented in the same amber");
  check((await page.locator("#status").textContent()) === "waiting for approval" && (await page.locator("#reply-text").isDisabled()), "the head says it waits, and the reply box is off");
  await shot("chat-approval-open-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("chat-approval-open-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await card.locator("button", { hasText: "Allow" }).click();
  await page.locator('.approval[data-state="allow"]').waitFor();
  check((await card.locator(".approval-state").textContent()) === "Allowed", "clicking Allow resolves it: the card says Allowed");
  check((await card.locator("button").count()) === 0, "and its buttons are gone");
  await page.locator(".msg.assistant:not(.streaming)", { hasText: "The tool call was allowed." }).waitFor();
  check(true, "the turn goes on with the call allowed");
  await page.locator(".note", { hasText: "Done" }).waitFor();
  check((await colour(".approval", "border-left-color")) !== warn, "decided, the card is no longer accented");
  await shot("chat-approval-decided-light");
  await page.reload();
  await page.locator(".note", { hasText: "Done" }).waitFor();
  check((await card.count()) === 1 && (await card.getAttribute("data-state")) === "allow" && (await card.locator(".approval-state").textContent()) === "Allowed", "after a reload the card is still there, as decided");
  check((await card.locator("button").count()) === 0, "without buttons");
  // Deny, and an answer the runner no longer takes.
  const second = await api.startSession("this needs approval as well");
  await page.goto(`${runner.url}/?session=${second.id}`);
  await card.locator("button", { hasText: "Deny" }).waitFor();
  const approvalRoute = `**/api/sessions/${second.id}/approvals/*`;
  await page.route(approvalRoute, (route: Any) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no such open approval" }) }));
  await card.locator("button", { hasText: "Allow" }).click();
  await card.locator(".approval-error", { hasText: "Couldn't send: this approval is no longer open" }).waitFor();
  check((await card.getAttribute("data-state")) === "open" && (await card.locator("button:not([disabled])").count()) === 2, "an answer the runner refuses is said quietly on the card, which stays open");
  await page.unroute(approvalRoute);
  await card.locator("button", { hasText: "Deny" }).click();
  await page.locator('.approval[data-state="deny"]').waitFor();
  check((await card.locator(".approval-state").textContent()) === "Denied" && (await card.locator("button").count()) === 0, "clicking Deny resolves it as denied");
  await page.locator(".msg.assistant:not(.streaming)", { hasText: "The tool call was denied." }).waitFor();
  check(true, "and the turn goes on with the call denied");
  await page.locator(".note", { hasText: "Done" }).waitFor();

  // ---- untrusted text, a failed tool call, a long result, an unknown event ----
  await page.locator(".session", { hasText: "<img" }).click();
  check(new URL(page.url()).searchParams.get("session") === hostileId, "clicking a session selects it and puts it in the URL");
  await page.goto(`${runner.url}/?session=${hostileId}`);
  await page.locator(".note", { hasText: "Done · 4.2 s · $0.031" }).waitFor();
  check((await page.locator('.session[aria-current="true"] .session-title').textContent()) === HOSTILE, "/?session=<id> opens that session");
  check(await page.locator("#head .resume").isHidden(), "a session with no Claude Code session id has no 'Continue in terminal'");
  check((await page.locator(".session-time").last().textContent()) === "3h", "the sidebar shows a short relative time, oldest activity last");
  check((await page.locator("body img, body script").count()) === 0 && (await page.evaluate(() => (window as Any).__xss)) === undefined, "markup in a title, a prompt, an answer and a tool result made no element and ran nothing");
  const bad = page.locator("details.tool");
  check((await bad.locator(".tool-result").textContent())?.startsWith(`${HOSTILE}\nline 1\n`), "a tool result containing <img onerror> is shown as text");
  check((await text(".msg.user .user-text"))[0] === `${HOSTILE}\nsecond line`, "so is the user's text");
  check((await text(".msg.assistant p"))[0] === `Markup stays text: ${HOSTILE}`, "and the assistant's");
  check((await text(".msg.user .attachment"))[0] === "/mnt/c/Users/x/AppData/Local/Temp/intuition/clip-1.png", "an imagePath is shown as its path");
  check((await text(".msg.assistant p code"))[0] === "bun test", "inline code is rendered");
  check((await text(".msg.assistant pre.code-block"))[0] === `const html = '${HOSTILE}';`, "a fenced code block is rendered");
  // ---- every markdown construct, in light and dark ----
  await page.goto(`${runner.url}/?session=${markdownId}`);
  await page.locator(".msg.assistant.md", { hasText: "CREANDUM" }).waitFor();
  const mdWrong = (await page.evaluate(markdownProblems, [MARKDOWN_EXPECTED])) as string[];
  check(mdWrong.length === 0, `every markdown construct is drawn, links only to http(s) and mailto, and nothing widens the stream (${mdWrong.join("; ") || "all there"})`);
  check((await page.evaluate(() => (window as Any).__xss)) === undefined, "and nothing in it ran");
  check((await text(".msg.user .user-text"))[0] === "Show me **every** construct", "the user's markdown stays plain text");
  await page.setViewportSize({ width: 1100, height: 1500 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shot(`chat-markdown-${scheme}`);
  }
  await page.setViewportSize({ width: 600, height: 1600 });
  await shot("chat-markdown-narrow-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`${runner.url}/?session=${hostileId}`);
  await page.locator(".note", { hasText: "Done · 4.2 s · $0.031" }).waitFor();
  check((await bad.evaluate((el: HTMLDetailsElement) => el.open)) === false, "the failed tool call is closed too");
  check((await bad.locator(".tool-mark").textContent()) === "failed" && (await bad.getAttribute("data-error")) === "true", "an error result is marked");
  check((await bad.locator(".tool-line").textContent()) === `/tmp/${HOSTILE}.txt`, "a file tool's summary is its path");
  await bad.locator("summary").click();
  check(!(await bad.locator(".tool-result").textContent())?.includes("the last line"), "a long result is cut");
  await shot("chat-tool-open-light");
  await bad.locator("button.show-all").click();
  check((await bad.locator(".tool-result").textContent())?.endsWith("the last line"), "'show all' shows all of it");
  check((await text(".note")).includes("compacted"), "an unknown event kind is a quiet one-line note");
  const cards = page.locator(".approval");
  check((await cards.count()) === 3 && (await cards.locator("button:not(.show-all)").count()) === 0, "stored approvals are cards without buttons");
  check((await text(".approval-state")).join(",") === "Not answered,Denied,Allowed", "each says what was decided, or that nobody answered before the turn ended");
  check((await cards.nth(1).locator(".approval-input").textContent()) === `echo ${HOSTILE}` && (await cards.nth(1).locator(".approval-reason").textContent()) === `because ${HOSTILE}`, "a Bash approval shows its command, and markup in it and in the reason is text");
  check((await cards.nth(2).locator(".approval-tool").textContent()) === HOSTILE, "so is markup in a tool's name");
  const json = cards.nth(2).locator(".approval-input");
  check((await json.textContent())?.startsWith(`{\n  "query": ${JSON.stringify(HOSTILE)}`) && !(await json.textContent())?.includes("row 39"), "another tool's input is shown as JSON, cut");
  await cards.nth(2).locator("button.show-all").click();
  check((await json.textContent())?.includes("row 39"), "'show all' shows the whole input");
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
  await page.locator("details.tool button.show-all").click();
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

  // ---- managing sessions: search, filter, menu, rename, pin, fork, archive with undo, delete, stop ----
  {
    const mdir = mkdtempSync(join(tmpdir(), "intuition-chat-manage-"));
    {
      // A session in another workspace, for the filter.
      const store = new Store(join(mdir, "data"));
      const when = new Date(Date.now() - 60 * 60_000).toISOString();
      store.create({ id: crypto.randomUUID(), claudeSessionId: "fake-gamma", workspace: "elsewhere", cwd: "/nowhere", title: "gamma notes", status: "idle", createdAt: when, updatedAt: when, lastSeq: 0, source: "intuition" });
    }
    const transcripts = new MemoryTranscripts();
    const m = testRunner({ dir: mdir, driver: fakeDriver(5), sync: { transcripts, pollMs: 50, idleMs: 400 } });
    try {
      const work = m.config.workspaces.find((w) => w.name === "work")!.path;
      transcripts.write("term-m", work, [userEntry("from the terminal"), assistantEntry("hi")], Date.now() - 5 * 60_000);
      const listed = async () => ((await (await m.get("/api/sessions")).json()) as { sessions: { id: string; title: string }[] }).sessions;
      const alpha = await m.startSession("alpha task");
      const beta = await m.startSession("beta task");
      await page.goto(`${m.url}/?session=${alpha.id}`);
      const row = (t: string) => page.locator(".session-item", { hasText: t });
      await row("from the terminal").waitFor();
      await page.locator(".note", { hasText: "Done" }).waitFor();
      const titles = () => text(".session-item .session-title");

      // Search and filter.
      await page.locator("#search").fill("alpha");
      check((await titles()).join("|") === "alpha task", "the search box narrows the list to titles that match, as you type");
      await page.locator("#search").fill("elsewhere");
      check((await titles()).join("|") === "gamma notes", "it matches the workspace too");
      await page.locator("#search").fill("nothing like this");
      check((await page.locator("#sessions-empty").textContent()) === "Nothing matches." && (await page.locator("#sessions-empty").isVisible()), "with no match it says so quietly");
      await page.locator("#search").press("Escape");
      check((await page.locator(".session-item").count()) === 4, "Esc in the search box clears it");
      check((await page.locator("#workspace-filter option").allTextContents()).join("|") === "All workspaces|elsewhere|work", "the workspace filter offers every workspace a session is in");
      await page.locator("#workspace-filter").selectOption("elsewhere");
      check((await titles()).join("|") === "gamma notes", "and narrows the list to one");
      await page.locator("#workspace-filter").selectOption("");
      await shot("chat-manage-list-light");

      // The menu.
      await row("alpha task").hover();
      await row("alpha task").locator(".more").click();
      const items = () => text(".menu:not([hidden]) .menu-item");
      check((await items()).join(",") === "Rename,Pin,Fork,Archive,Delete", "the … button opens the menu: Rename, Pin, Fork, Archive, Delete");
      check(await page.evaluate(() => document.activeElement?.classList.contains("menu-item")), "with the focus on its first item");
      await shot("chat-manage-menu-light");
      await page.emulateMedia({ colorScheme: "dark" });
      await shot("chat-manage-menu-dark");
      await page.emulateMedia({ colorScheme: "light" });
      await page.keyboard.press("Escape");
      check(await page.locator(".menu").isHidden(), "Esc closes it");
      await row("from the terminal").locator("a").click({ button: "right" });
      check((await items()).join(",") === "Rename,Pin,Fork,Archive", "right-click opens it too; a session from the terminal has no Delete, only Archive");
      await page.keyboard.press("Escape");

      // Rename: inline from the menu, and F2.
      await row("alpha task").locator("a").click({ button: "right" });
      await page.locator(".menu-item", { hasText: "Rename" }).click();
      const input = page.locator(".session-item input.rename");
      check((await input.inputValue()) === "alpha task", "Rename edits the title in its row");
      await input.fill("alpha renamed");
      await input.press("Enter");
      await row("alpha renamed").waitFor();
      check((await listed()).some((x) => x.id === alpha.id && x.title === "alpha renamed"), "Enter saves it in the runner");
      check((await page.locator("#title").textContent()) === "alpha renamed", "and the head follows");
      await row("beta task").locator("a").focus();
      await page.keyboard.press("F2");
      await input.fill("beta via F2");
      await input.press("Enter");
      await row("beta via F2").waitFor();
      check(true, "F2 renames the focused session");
      await page.keyboard.press("F2");
      await input.press("Escape");
      check((await input.count()) === 0 && (await row("beta via F2").count()) === 1, "Esc leaves the title as it was");

      // Pin.
      await row("gamma notes").locator("a").click({ button: "right" });
      await page.locator(".menu-item", { hasText: "Pin" }).click();
      await page.locator(".session-item:first-child .pin-mark").waitFor();
      check((await titles())[0] === "gamma notes", "a pinned session goes to the top, marked Pinned");
      await row("gamma notes").locator("a").click({ button: "right" });
      check((await items())[1] === "Unpin", "and its menu offers Unpin");
      await page.keyboard.press("Escape");

      // Fork.
      await row("alpha renamed").locator("a").click({ button: "right" });
      await page.locator(".menu-item", { hasText: "Fork" }).click();
      await page.locator('.session[aria-current="true"]', { hasText: "alpha renamed (fork)" }).waitFor();
      check(true, "Fork makes '<title> (fork)' and shows it");
      // The session before it may still be fading out: the stream is the one that stays.
      await page.locator("#stream .msg.user .user-text", { hasText: "alpha task" }).waitFor();
      check((await page.locator("#status").textContent()) === "idle", "with the conversation so far, idle until replied to");

      // Archive with the Delete key, and Undo.
      await row("beta via F2").locator("a").focus();
      await page.keyboard.press("Delete");
      await page.locator("#undo", { hasText: "Archived “beta via F2”." }).waitFor();
      check((await row("beta via F2").count()) === 0, "the Delete key archives the focused session: it leaves the list");
      check(await page.locator("#undo button", { hasText: "Undo" }).isVisible(), "and a line says so, with Undo");
      await shot("chat-manage-undo-light");
      await page.locator("#undo button", { hasText: "Undo" }).click();
      await row("beta via F2").waitFor();
      check(!(await listed()).every((x) => x.id !== beta.id), "Undo brings it back");
      await row("beta via F2").locator("a").focus();
      await page.keyboard.press("Delete");
      await page.locator("#undo", { hasText: "Archived" }).waitFor();
      await page.locator("#undo").waitFor({ state: "hidden", timeout: 8000 });
      check(true, "the line goes after a few seconds");

      // The Archived view.
      await page.locator("#archived-view").click();
      check((await page.locator("#archived-view").getAttribute("aria-pressed")) === "true" && (await titles()).join("|") === "beta via F2", "Archived shows the archived sessions only");
      await shot("chat-manage-archived-light");
      await row("beta via F2").locator("a").click({ button: "right" });
      await page.locator(".menu-item", { hasText: "Unarchive" }).click();
      await page.locator("#sessions-empty", { hasText: "No archived sessions." }).waitFor();
      check(true, "Unarchive takes it out of the Archived view");
      await page.locator("#archived-view").click();
      await row("beta via F2").waitFor();
      check(true, "and back in the list");

      // Delete, after a confirmation that says what goes.
      const fork = (await listed()).find((x) => x.title === "alpha renamed (fork)")!;
      await row("alpha renamed (fork)").locator("a").click({ button: "right" });
      await page.locator(".menu-item", { hasText: "Delete" }).click();
      const dialog = page.locator("#confirm");
      await dialog.waitFor();
      check((await page.locator("#confirm-title").textContent()) === "Delete “alpha renamed (fork)”?", "Delete asks first, naming the session");
      check((await page.locator("#confirm-body").textContent())?.includes("deletes its Claude Code transcript"), "and saying its transcript goes too, for good");
      check(await page.evaluate(() => document.activeElement?.getAttribute("value") === "cancel"), "with the focus on Cancel");
      await shot("chat-manage-confirm-light");
      await page.emulateMedia({ colorScheme: "dark" });
      await shot("chat-manage-confirm-dark");
      await page.emulateMedia({ colorScheme: "light" });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      check((await listed()).some((x) => x.id === fork.id), "Esc (or Cancel) deletes nothing");
      await row("alpha renamed (fork)").locator("a").click({ button: "right" });
      await page.locator(".menu-item", { hasText: "Delete" }).click();
      await page.locator("#confirm-ok").click();
      await row("alpha renamed (fork)").waitFor({ state: "detached" });
      check(!(await listed()).some((x) => x.id === fork.id), "confirmed, the session is deleted and leaves the list");
      check((await page.locator(".session[aria-current]").count()) === 1, "and another one is shown");

      // Stop.
      const slow = await m.startSession("please count slowly");
      await page.goto(`${m.url}/?session=${slow.id}`);
      const stop = page.locator("#stop");
      await stop.waitFor();
      check((await stop.textContent()) === "Stop", "a running session has Stop in the head");
      await shot("chat-manage-stop-light");
      await stop.click();
      await page.locator(".note", { hasText: "Stopped" }).waitFor();
      check(true, "Stop ends the turn: the stream says Stopped");
      await page.locator(".msg.streaming").waitFor({ state: "detached" });
      check(true, "and what had streamed of the answer goes");
      await page.locator("#status", { hasText: "idle" }).waitFor();
      check(await stop.isHidden(), "the session is idle and Stop is gone");
      check(!(await page.locator("#reply-text").isDisabled()), "and the reply box is on");
      await page.setViewportSize({ width: 390, height: 720 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "nothing scrolls sideways at 390 wide with the finder");
      await shot("chat-manage-narrow-light");
      await page.setViewportSize({ width: 1100, height: 720 });
    } finally {
      await m.stop();
    }
  }

  // ---- the motion: what arrives rises in, an approval card bounces, a tool row springs, a new session cross-fades ----
  {
    // A slow fake agent, so what it does arrives while the page watches, not with the session's history.
    const slow = testRunner({ driver: fakeDriver(500) });
    const m = await browser.newContext({ viewport: { width: 1100, height: 720 }, colorScheme: "dark" });
    try {
      const mp = await m.newPage();
      mp.on("pageerror", (e: Error) => pageErrors.push(e.message));
      const names = (selector: string) => mp.locator(selector).first().evaluate((el: Element) => el.getAnimations().map((a) => (a as CSSAnimation).animationName).sort().join()) as Promise<string>;
      const quiet = await slow.startSession("a quiet one, to select later");
      await mp.goto(`${slow.url}/?session=${quiet.id}`);
      await mp.locator(".note", { hasText: "Done" }).waitFor({ timeout: 15000 });
      check((await mp.locator("#stream .arrive").count()) > 0, "what arrives while the page watches is marked to rise in");
      await mp.reload();
      await mp.locator(".note", { hasText: "Done" }).waitFor();
      check((await mp.locator("#stream .arrive").count()) === 0, "a session's history, loaded on selecting it, doesn't rise in: it is there");
      const asks = await slow.startSession("motion: this needs approval");
      await mp.goto(`${slow.url}/?session=${asks.id}`);
      // Every approval card that arrives is held at its first moment, to be stepped through.
      await mp.evaluate(() => {
        new MutationObserver((records) => {
          for (const r of records) for (const n of r.addedNodes) {
            if (!(n instanceof HTMLElement) || !n.matches(".approval.arrive")) continue;
            for (const a of n.getAnimations()) a.pause();
            (window as Any).__card = n;
          }
        }).observe(document.getElementById("stream")!, { childList: true });
      });
      await mp.waitForFunction(() => (window as Any).__card);
      check((await names(".approval.arrive")) === "card-pop,fade-in", "an approval card that arrives pops in with a small bounce, and fades in");
      check((await mp.locator(".msg.user.arrive, .msg.assistant.arrive, .tool.arrive").count()) > 0 && (await names(".msg.arrive, .tool.arrive")) === "fade-in,rise", "what arrives while the page watches rises in softly");
      // The card at moments through its arrival: scale and place from its transform, and a strip to look at.
      const moments = [0, 40, 80, 120, 160, 200, 250, 300, 350];
      const pictures: string[] = [];
      const scales: number[] = [];
      const box = await mp.locator(".approval").boundingBox();
      for (const ms of moments) {
        scales.push(await mp.evaluate((t: number) => {
          const card = (window as Any).__card as HTMLElement;
          for (const a of card.getAnimations()) a.currentTime = t;
          return new DOMMatrix(getComputedStyle(card).transform === "none" ? undefined : getComputedStyle(card).transform).a;
        }, ms));
        await mp.waitForTimeout(60);
        pictures.push((await mp.screenshot({ clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } })).toString("base64"));
      }
      check(scales[0]! < 0.97 && Math.max(...scales) > 1.003 && Math.abs(scales.at(-1)! - 1) < 0.002, `the card grows from a little small, a little past its size and back (scale ${scales.map((v) => v.toFixed(3)).join(", ")})`);
      await mp.evaluate(() => {
        for (const a of ((window as Any).__card as HTMLElement).getAnimations()) a.play();
      });
      const sheet = await m.newPage();
      const w = Math.ceil(box.width + 48);
      const hgt = Math.ceil(box.height + 48);
      await sheet.setViewportSize({ width: Math.min(moments.length, 3) * (w + 12) + 12, height: Math.ceil(moments.length / 3) * (hgt + 40) + 12 });
      await sheet.setContent(`<body style="margin:12px;background:#000;color:#bbb;font:14px system-ui;display:flex;flex-wrap:wrap;gap:12px">${pictures
        .map((png, i) => `<figure style="margin:0"><img width="${w}" height="${hgt}" src="data:image/png;base64,${png}"><figcaption style="height:24px;padding-top:4px">approval, ${moments[i]} ms</figcaption></figure>`)
        .join("")}</body>`);
      const stripPath = join(shots, "chat-strip-approval.png");
      await sheet.screenshot({ path: stripPath });
      await sheet.close();
      console.log(`  frames: ${stripPath} (${moments.join(", ")} ms)`);
      check(readFileSync(stripPath).length > 10_000, "a strip of the approval card arriving is saved, to be looked at");
      await mp.locator(".approval button", { hasText: "Allow" }).click();
      await mp.locator(".note", { hasText: "Done" }).waitFor({ timeout: 15000 });

      // A tool row springs open, and fades before it closes.
      const row = mp.locator("details.tool").first();
      await row.locator("summary").click();
      check((await row.evaluate((el: HTMLDetailsElement) => el.open)) && (await names("details.tool[open] > .tool-body")) === "drop,fade-in", "a tool row springs open: its body drops in from under the row");
      await mp.waitForTimeout(400);
      await row.locator("summary").click();
      check((await row.getAttribute("data-closing")) === "" && (await row.evaluate((el: HTMLDetailsElement) => el.open)), "closing, its body fades out first");
      await mp.waitForFunction(() => !(document.querySelector("details.tool") as HTMLDetailsElement).open);
      check((await row.getAttribute("data-closing")) === null, "and then it closes");

      // Selecting another session cross-fades: the old stream, copied over the new one, fades away.
      await mp.locator(".session", { hasText: "a quiet one" }).click();
      check((await mp.locator(".stream-leaving").count()) === 1 && (await names(".stream-leaving")) === "fade-out" && (await names("#stream")) === "fade-in", "selecting another session cross-fades the streams");
      await mp.locator(".stream-leaving").waitFor({ state: "detached" });
      check((await mp.locator(".stream-leaving [id]").count()) === 0, "and the copy is gone once faded");
    } finally {
      await m.close();
    }

    // Reduced motion: only short plain fades.
    const r = await browser.newContext({ viewport: { width: 1100, height: 720 }, colorScheme: "dark", reducedMotion: "reduce" });
    try {
      const rp = await r.newPage();
      const asks = await slow.startSession("reduced: this needs approval");
      await rp.goto(`${slow.url}/?session=${asks.id}`);
      await rp.evaluate(() => {
        new MutationObserver((records) => {
          for (const rec of records) for (const n of rec.addedNodes) {
            if (n instanceof HTMLElement && n.matches(".approval.arrive")) (window as Any).__seen = n.getAnimations().map((a) => (a as CSSAnimation).animationName).join();
          }
        }).observe(document.getElementById("stream")!, { childList: true });
      });
      await rp.waitForFunction(() => (window as Any).__seen !== undefined);
      check((await rp.evaluate(() => (window as Any).__seen)) === "fade-in", "prefers-reduced-motion: the approval card only fades in");
      await rp.locator(".approval button", { hasText: "Deny" }).click();
      await rp.locator(".note", { hasText: "Done" }).waitFor({ timeout: 15000 });
      const row = rp.locator("details.tool").first();
      if (await row.count()) {
        await row.locator("summary").click();
        await row.locator("summary").click();
        check(!(await row.evaluate((el: HTMLDetailsElement) => el.open)), "and a tool row opens and closes at once");
      }
    } finally {
      await r.close();
      await slow.stop();
    }
  }

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

  const elsewhere = requested.filter((u) => !/^(?:data|blob|about):/.test(u) && new URL(u).hostname !== "127.0.0.1");
  check(requested.length > 0 && elsewhere.length === 0, `no request left 127.0.0.1 (${elsewhere.join(" ") || "none did"})`);
  check(pageErrors.length === 0 || pageErrors.every((e) => /WebSocket|ERR_CONNECTION_REFUSED|404|409/.test(e)), `the page logged no errors of its own (${pageErrors.join(" | ") || "none"})`);
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
