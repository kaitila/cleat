import type { Store } from "../../src/runner/store";
// One assistant message with every construct the renderer understands, for the browser scripts
// (chat-ui.ts and dock-ui.ts) to draw and screenshot, and links that must not become links.
export const MARKDOWN_SAMPLE = [
  "# Plan for Thursday",
  "**CREANDUM DAY ZERO DRINKS**",
  "- **FR8 Demo Day**, 17:00-19:00",
  "- Dinner with *the team* and _guests_, ~~18:00~~ 19:30",
  "  - nested: bring `badge.pdf`",
  "    1. print it",
  "    2. sign it",
  "",
  "## Steps",
  "3. Read https://example.com/agenda.",
  "4. Reply to [the organiser](mailto:events@example.com)",
  "",
  "### Tasks",
  "- [x] book the table",
  "- [ ] send the invite",
  "",
  "> A quote, with **bold** inside.",
  "> And a second line.",
  "",
  "---",
  "",
  "| Item | Time | Cost |",
  "|:-----|:----:|-----:|",
  "| Drinks | 17:00 | 0 |",
  "| Dinner | 19:30 | 45 |",
  "",
  "```ts",
  "const html = '<img src=x onerror=\"window.__xss=1\">'; // a long line that has to scroll sideways inside its well, not widen the page",
  "```",
  "",
  "#### Heading four",
  "##### Heading five",
  "###### Heading six",
  "Not links: [js](javascript:window.__xss=1) and [data](data:text/html,<script>window.__xss=1</script>).",
].join("\n");

/** What the page must have drawn from MARKDOWN_SAMPLE: a selector and how many of it, at least. */
export const MARKDOWN_EXPECTED: [string, number][] = [
  ["h1", 1], ["h2", 1], ["h3", 1], ["h4", 1], ["h5", 1], ["h6", 1],
  ["strong", 3], ["em", 2], ["del", 1], ["code", 2],
  ["ul ul ol li", 2], ['ol[start="3"] li', 2],
  ['a[href="https://example.com/agenda"][target="_blank"][rel="noopener noreferrer"]', 1],
  ['a[href="mailto:events@example.com"]', 1],
  ['li.task[data-done="true"] .task-mark', 1], ['li.task[data-done="false"] .task-mark', 1],
  ["blockquote strong", 1], ["hr", 1],
  ['table th[data-align="center"]', 1], ["table tbody tr", 2],
  ['pre.code-block[data-lang="ts"]', 1],
];

/** Stores a session, two hours old, whose answer is MARKDOWN_SAMPLE. Returns its id. */
export function seedMarkdown(store: Store): string {
  const id = crypto.randomUUID();
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  store.create({ id, claudeSessionId: null, workspace: "work", cwd: "/nowhere", title: "Markdown sample", status: "idle", createdAt: at, updatedAt: at, lastSeq: 0 });
  store.append(id, { kind: "user", text: "Show me **every** construct" });
  store.append(id, { kind: "assistant_text", text: MARKDOWN_SAMPLE });
  store.append(id, { kind: "result", ok: true, durationMs: 1000 });
  store.get(id)!.updatedAt = at;
  store.create(store.get(id)!);
  return id;
}

/** In the page: what is missing from the drawn sample, and any link to somewhere other than http(s) or mailto. */
export function markdownProblems([expected]: [[string, number][]]): string[] {
  const msg = [...document.querySelectorAll(".msg.assistant.md")].find((el) => el.textContent?.includes("CREANDUM"));
  if (!msg) return ["the sample is not on the page"];
  const why: string[] = [];
  for (const [selector, count] of expected) {
    const n = msg.querySelectorAll(selector).length;
    if (n < count) why.push(`${selector}: ${n}, wanted ${count}`);
  }
  for (const a of msg.querySelectorAll("a")) if (!/^(?:https?:|mailto:)/.test(a.getAttribute("href") ?? "")) why.push(`a link to ${a.getAttribute("href")}`);
  if (!msg.textContent?.includes("[js](javascript:window.__xss=1)")) why.push("the javascript: link is not shown as its text");
  if (msg.querySelector("input, img, script")) why.push("an input, image or script was made");
  if (msg.scrollWidth > msg.clientWidth + 1) why.push(`the message is ${msg.scrollWidth}px wide in ${msg.clientWidth}px`);
  return why;
}
