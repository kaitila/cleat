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
 * The line shown next to a tool's name while its call is collapsed: the command for Bash, the path
 * for file tools, otherwise the first 80 characters of the input.
 */
export function toolSummary(name, input) {
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  if (name === "Bash" && typeof fields.command === "string") return oneLine(fields.command);
  for (const key of PATH_KEYS) {
    if (typeof fields[key] === "string" && fields[key]) return fields[key];
  }
  return oneLine(inputText(input)).slice(0, SUMMARY_MAX);
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

/** The command that continues the session in a WSL terminal, or null before it has a Claude Code session id. */
export function resumeCommand(session) {
  if (!session?.claudeSessionId || !session.cwd) return null;
  return `cd ${shellWord(session.cwd)} && claude --resume ${shellWord(session.claudeSessionId)}`;
}

/** Whether a reply can be sent, and the hint under the reply box. */
export function replyState(session) {
  if (!session) return { enabled: false, hint: "" };
  // A turn in a terminal: a reply here may go in all the same (the runner asks for force).
  if (session.status === "running" && session.terminalTurn === true) return { enabled: true, hint: "A turn is arriving from the terminal." };
  if (session.status === "running") return { enabled: false, hint: "Working. You can reply when this turn ends." };
  if (session.status === "waiting_approval") return { enabled: false, hint: "Waiting for your Allow or Deny above." };
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
