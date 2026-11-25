// Pure helpers for the chat view: no DOM, no network, so they are unit tested with bun (test/web/).
// chat.js turns what these return into DOM nodes with textContent.

/** Tools whose one-line summary is the file they work on. */
const PATH_KEYS = ["file_path", "path", "notebook_path"];
export const SUMMARY_MAX = 80;
/** A tool result longer than this is cut until the person asks for all of it. */
export const RESULT_MAX_CHARS = 2000;
export const RESULT_MAX_LINES = 30;

function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** A tool's input as text: a string as it is, anything else as JSON. */
export function inputText(input, indent = 0) {
  if (typeof input === "string") return input;
  if (input === undefined) return "";
  try {
    return JSON.stringify(input, null, indent) ?? "";
  } catch {
    return String(input);
  }
}

/**
 * A tool's name as a person reads it: { source, action }. An MCP tool (`mcp__<server>__<tool>`) is
 * its server's name without the "claude.ai " prefix and its tool's words ("Gamma", "list funds");
 * ToolSearch, which only loads other tools, is "Tools" / "load"; any other tool is its own name.
 */
const TOOL_SEARCH = { source: "Tools", action: "load" };

export function toolLabel(name) {
  const text = typeof name === "string" && name ? name : "Tool";
  const mcp = /^mcp__(.+?)__(.+)$/.exec(text);
  if (mcp) {
    const source = mcp[1].replace(/^claude_ai_/, "").replace(/_/g, " ");
    const words = mcp[2].replace(/_/g, " ");
    // "Slack" and "slack search": the action doesn't say the source again.
    const prefix = `${source.toLowerCase()} `;
    return { source, action: words.toLowerCase().startsWith(prefix) && words.length > prefix.length ? words.slice(prefix.length) : words };
  }
  if (text === "ToolSearch") return { ...TOOL_SEARCH };
  return { source: text, action: "" };
}

/** A tool's label on one line: "Gamma list funds", "Bash". */
export function toolLabelText(name) {
  const { source, action } = toolLabel(name);
  return action ? `${source} ${action}` : source;
}

/** The input fields whose value says best what a call is about, before any other text field. */
const SUMMARY_KEYS = ["query", "q", "pattern", "url", "skill", "name", "description", "prompt"];

/**
 * The line shown next to a tool's name while its call is collapsed: the command for Bash, the path
 * for file tools, the tools ToolSearch loads, otherwise the input's telling text field (a query, a
 * name, else the first text it has), and the input as JSON when it has no text; at most 80 characters.
 */
export function toolSummary(name, input) {
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  if (name === "Bash" && typeof fields.command === "string") return oneLine(fields.command);
  // An agent's questions: the first one's text.
  if (name === "AskUserQuestion" && Array.isArray(fields.questions) && typeof fields.questions[0]?.question === "string") return oneLine(fields.questions[0].question).slice(0, SUMMARY_MAX);
  for (const key of PATH_KEYS) {
    if (typeof fields[key] === "string" && fields[key]) return fields[key];
  }
  if (name === "ToolSearch" && typeof fields.query === "string" && fields.query.startsWith("select:")) {
    const names = fields.query.slice("select:".length).split(",");
    return oneLine(names.map((n) => toolLabelText(n.trim())).join(", ")).slice(0, SUMMARY_MAX);
  }
  const texts = Object.entries(fields).filter(([, v]) => typeof v === "string" && v.trim());
  const telling = SUMMARY_KEYS.map((key) => texts.find(([k]) => k === key)).find(Boolean) ?? texts[0];
  if (telling) return oneLine(String(telling[1])).slice(0, SUMMARY_MAX);
  if (input !== fields || Object.keys(fields).length > 0) return oneLine(inputText(input)).slice(0, SUMMARY_MAX);
  return "";
}

/** At most this many sources are named on a folded run of steps; the rest are a count. */
export const STEP_SOURCES = 3;

/**
 * What a folded run of tool calls says: { count: "11 steps", sources: "Gamma, Google Drive, Bash +2" },
 * its sources in the order they were first used. Loading tools (ToolSearch) is left out of the
 * sources while there is anything else: it says nothing about the work.
 */
export function stepsSummary(names) {
  const all = [...new Set(names.map((n) => toolLabel(n).source))];
  const sources = all.length > 1 ? all.filter((s) => s !== TOOL_SEARCH.source) : all;
  const shown = sources.slice(0, STEP_SOURCES).join(", ");
  const more = sources.length - STEP_SOURCES;
  return { count: `${names.length} ${names.length === 1 ? "step" : "steps"}`, sources: more > 0 ? `${shown} +${more}` : shown };
}

/** The text a file tool is about to put into its file, by the input field that carries it. */
const TEXT_KEYS = ["content", "new_string", "new_source"];
/** An approval card shows this much of a file's new text, or of a JSON input, before "show all". */
export const APPROVAL_MAX_CHARS = 600;
export const APPROVAL_MAX_LINES = 12;

/**
 * What an approval card shows of a tool call: { path, text, full }.
 * Bash: the whole command, as it is: the person decides on all of it. File tools: the path, and a
 * cut preview of the text to be written. Anything else: the input as JSON, cut.
 * `full` is the uncut text; it is longer than `text` when there is more to show.
 */
export function approvalView(toolName, input) {
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  if (toolName === "Bash" && typeof fields.command === "string") return { path: "", text: fields.command, full: fields.command };
  for (const key of PATH_KEYS) {
    if (typeof fields[key] !== "string" || !fields[key]) continue;
    const textKey = TEXT_KEYS.find((k) => typeof fields[k] === "string");
    const full = textKey ? fields[textKey] : "";
    return { path: fields[key], text: cutResult(full, APPROVAL_MAX_CHARS, APPROVAL_MAX_LINES).text, full };
  }
  const full = inputText(input, 2);
  return { path: "", text: cutResult(full, APPROVAL_MAX_CHARS, APPROVAL_MAX_LINES).text, full };
}

const DECIDED = { allow: "Allowed", deny: "Denied" };

/** What a decided approval card says. An approval nobody answered (its turn is over) is "Not answered". */
export function decidedLabel(decision) {
  return Object.hasOwn(DECIDED, decision) ? DECIDED[decision] : "Not answered";
}

/** How long ago, short enough for the sidebar: now, 5m, 3h, 2d, then the date. */
export function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A long tool result cut for the collapsed view: { text, cut }. `cut` says there is more. */
export function cutResult(text, maxChars = RESULT_MAX_CHARS, maxLines = RESULT_MAX_LINES) {
  let shown = text;
  const lines = shown.split("\n");
  if (lines.length > maxLines) shown = lines.slice(0, maxLines).join("\n");
  if (shown.length > maxChars) shown = shown.slice(0, maxChars);
  return { text: shown, cut: shown.length < text.length };
}

/** Sessions with the newest activity first. */
export function byActivity(sessions) {
  return [...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The session to show: the one the URL asks for if it exists, otherwise the newest. */
export function pickSession(sessions, wanted) {
  if (wanted && sessions.some((s) => s.id === wanted)) return wanted;
  return byActivity(sessions)[0]?.id ?? null;
}

const STATUS_LABEL = { running: "working", waiting_approval: "waiting for approval", idle: "idle", error: "failed" };

export function statusLabel(status) {
  return STATUS_LABEL[status] ?? String(status);
}

/** What the head says beside the dot: "in terminal" while a turn arrives from a terminal, else the status. */
export function sessionStatus(session) {
  if (session?.status === "running" && session.terminalTurn === true) return "in terminal";
  return statusLabel(session?.status);
}

/** The tooltip of the list's terminal mark. */
export const TERMINAL_MARK_TITLE = "started in the terminal";

/** Whether the list marks the session as one started in the terminal. */
export function startedInTerminal(session) {
  return session?.source === "terminal";
}

/** The start of the runner's 409 for a reply to a session another process writes to (OPEN_IN_TERMINAL in the contract). */
const OPEN_IN_TERMINAL_START = "it looks open in a terminal";

/** True for a reply refused because the session looks open in a terminal: the page offers "Send anyway" (force). */
export function isOpenInTerminal(status, error) {
  return status === 409 && typeof error === "string" && error.startsWith(OPEN_IN_TERMINAL_START);
}

/** What the reply hint says when the runner answered with that 409. */
export const OPEN_IN_TERMINAL_HINT = "It looks open in a terminal.";

/** A word for a POSIX shell: as it is when it is plainly safe, else in single quotes. */
export function shellWord(word) {
  if (/^[A-Za-z0-9_\-./@%+=:,]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command that continues the session in a terminal, or null before the agent has given its id:
 * `codex resume <thread id>` for a Codex session, `claude --resume <session id>` for the rest.
 */
export function resumeCommand(session) {
  if (!session?.claudeSessionId || !session.cwd) return null;
  const command = session.agent === "codex" ? "codex resume" : "claude --resume";
  return `cd ${shellWord(session.cwd)} && ${command} ${shellWord(session.claudeSessionId)}`;
}

/** Whether a reply can be sent, and the hint under the reply box. */
export function replyState(session) {
  if (!session) return { enabled: false, hint: "" };
  // A turn in a terminal: a reply here may go in all the same (the runner asks for force).
  if (session.status === "running" && session.terminalTurn === true) return { enabled: true, hint: "A turn is arriving from the terminal." };
  if (session.status === "running") return { enabled: false, hint: "Working. You can reply when this turn ends." };
  if (session.status === "waiting_approval") return { enabled: false, hint: "Waiting for your answer above." };
  if (session.status === "error") return { enabled: true, hint: "The last turn failed. A reply tries again." };
  return { enabled: true, hint: "Enter to send, Shift+Enter for a new line" };
}

/** The quiet line that ends a turn: "Done · 4.2 s · $0.03". */
export function resultLine(event) {
  const parts = [event.ok ? "Done" : "Ended with an error"];
  if (typeof event.durationMs === "number") {
    const s = event.durationMs / 1000;
    parts.push(s < 60 ? `${s < 10 ? s.toFixed(1) : Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);
  }
  if (typeof event.costUsd === "number" && event.costUsd > 0) parts.push(`$${event.costUsd.toFixed(event.costUsd < 0.1 ? 3 : 2)}`);
  return parts.join(" · ");
}

/** The one-line note for an event kind this page doesn't draw (yet). */
export function unknownNote(event) {
  const kind = typeof event?.kind === "string" ? event.kind.replaceAll("_", " ") : "event";
  const tool = typeof event?.toolName === "string" ? `: ${event.toolName}` : "";
  const decision = typeof event?.decision === "string" ? `: ${event.decision}` : "";
  return oneLine(`${kind}${tool}${decision}`).slice(0, 120);
}

/** Delay before reconnect attempt number `attempt` (0, 1, 2...): 0.5 s doubling to 5 s. */
export function backoffMs(attempt) {
  return Math.min(5000, 500 * 2 ** Math.max(0, attempt));
}

/**
 * The word beside the working mark (D0053): island and harbour lingo, as a cleat is the fitting a
 * boat is tied to. One is picked each time the mark appears and kept while it stays.
 */
export const WORKING_WORDS = [
  "Island-hopping",
  "Casting off",
  "Charting the reef",
  "Reading the tides",
  "Beachcombing",
  "Paddling out",
  "Trimming the sails",
  "Rowing ashore",
  "Sounding the depths",
  "Hauling in",
  "Mending nets",
  "Tying up",
  "Riding the swell",
  "Spotting land",
  "Following the gulls",
  "Waiting for the tide",
  "Coiling rope",
  "Scanning the horizon",
  "Dropping anchor",
  "Raising the flag",
];

/** A working word, as "Island-hopping…". `random` is a number in [0, 1), Math.random's by default. */
export function workingWord(random = Math.random()) {
  const i = Math.min(WORKING_WORDS.length - 1, Math.max(0, Math.floor(random * WORKING_WORDS.length)));
  return `${WORKING_WORDS[i]}…`;
}
