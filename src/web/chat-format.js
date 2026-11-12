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

/** Text with `inline code` split out: [{ text, code }]. An unpaired backtick stays as text. */
export function splitInline(text) {
  const spans = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index), code: false });
    spans.push({ text: match[1], code: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), code: false });
  return spans;
}

/**
 * The little markdown the chat view renders: paragraphs (split at blank lines), fenced code blocks
 * and inline code. Everything else stays as the text it is.
 * Returns [{ type: "text", spans }] and [{ type: "code", lang, text }] blocks, in order.
 * A fence that is still open (the text is streaming) runs to the end.
 */
export function splitMarkdown(text) {
  const blocks = [];
  let paragraph = [];
  let fence = null;
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "text", spans: splitInline(paragraph.join("\n")) });
    paragraph = [];
  };
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (fence) {
      if (line.trim() === fence.mark) {
        blocks.push({ type: "code", lang: fence.lang, text: fence.lines.join("\n") });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    const open = /^\s*(```|~~~)\s*([^\s`]*)\s*$/.exec(line);
    if (open) {
      endParagraph();
      fence = { mark: open[1], lang: open[2], lines: [] };
    } else if (line.trim() === "") {
      endParagraph();
    } else {
      paragraph.push(line);
    }
  }
  if (fence) blocks.push({ type: "code", lang: fence.lang, text: fence.lines.join("\n") });
  endParagraph();
  return blocks;
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

/** Whether a reply can be sent, and the hint under the reply box. */
export function replyState(session) {
  if (!session) return { enabled: false, hint: "" };
  if (session.status === "running") return { enabled: false, hint: "Working. You can reply when this turn ends." };
  if (session.status === "waiting_approval") return { enabled: false, hint: "Waiting for approval." };
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
