// The icons of tool calls and connectors (D0055): a small line glyph for each kind of tool (a
// terminal for Bash, a pencil for an edit, a magnifier for a search) and for each claude.ai
// connector (an envelope for Gmail, a calendar, a folder for Drive), drawn like the agent glyphs
// (agent.js): a 16 unit box, the text's colour, 1em square. Plain shapes, never a product's logo.
// Shared by the chat view and the dock. The markup below is fixed: no text from a tool or the model
// ever reaches it; a tool's name only picks one of these keys.

/** Each icon's shapes, inside <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">. */
const SHAPES = {
  terminal: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/><path d="M4.5 6.25 6.75 8 4.5 9.75M8.25 10h3.25"/>',
  file: '<path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3"/>',
  pencil: '<path d="M10.25 2.75l3 3L6.5 12.5l-3.75.75.75-3.75z"/><path d="M8.75 4.25l3 3"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/>',
  globe: '<circle cx="8" cy="8" r="5.75"/><path d="M2.25 8h11.5M8 2.25c-2.25 2.5-2.25 9 0 11.5M8 2.25c2.25 2.5 2.25 9 0 11.5"/>',
  spark: '<path d="M8 2.25 9.3 6.7 13.75 8 9.3 9.3 8 13.75 6.7 9.3 2.25 8 6.7 6.7z"/>',
  plug: '<path d="M6 1.75v3M10 1.75v3M4.25 4.75h7.5v2.5a3.75 3.75 0 0 1-7.5 0zM8 11v3.25"/>',
  agent: '<circle cx="4.5" cy="4" r="1.75"/><circle cx="11.5" cy="12" r="1.75"/><path d="M4.5 5.75V9a3 3 0 0 0 3 3h2.25"/>',
  list: '<path d="M2.5 4.25l1.25 1.25L6 3.25M2.5 10.25l1.25 1.25L6 9.25M8.75 4.5h4.75M8.75 10.5h4.75"/>',
  question: '<circle cx="8" cy="8" r="5.75"/><path d="M6.25 6.4a1.75 1.75 0 1 1 2.6 1.55c-.55.3-.85.65-.85 1.2M8 11.1v.15"/>',
  mail: '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><path d="m2.25 4.25 5.75 4.5 5.75-4.5"/>',
  calendar: '<rect x="2" y="3" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M5.25 1.75v2.5M10.75 1.75v2.5"/>',
  folder: '<path d="M1.75 4.25a1 1 0 0 1 1-1h3.5l1.5 1.75h5.5a1 1 0 0 1 1 1v6.75a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/>',
  grid: '<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 6h12M2 10h12M6.25 6v8"/>',
  bubble: '<path d="M2.75 2.75h10.5a1 1 0 0 1 1 1v6.75a1 1 0 0 1-1 1H7.25L4 14v-2.5H2.75a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1z"/>',
  page: '<rect x="3" y="1.75" width="10" height="12.5" rx="1.5"/><path d="M5.5 5.25h5M5.5 8h5M5.5 10.75h3"/>',
  graph: '<circle cx="8" cy="3.5" r="1.75"/><circle cx="3.5" cy="12.25" r="1.75"/><circle cx="12.5" cy="12.25" r="1.75"/><path d="M7.2 5.05 4.3 10.7M8.8 5.05l2.9 5.65M5.25 12.25h5.5"/>',
  receipt: '<path d="M3.5 1.75h9v12.5l-1.5-1-1.5 1-1.5-1-1.5 1-1.5-1-1.5 1z"/><path d="M6 5.25h4M6 8.25h4"/>',
  // The plugins' tabs' own (dock-plugins.js, D0057).
  people: '<circle cx="6" cy="5.25" r="2.25"/><path d="M1.75 13.25a4.25 4.25 0 0 1 8.5 0M10.5 3.25a2.25 2.25 0 0 1 0 4.25M12 9.4a4.25 4.25 0 0 1 2.25 3.85"/>',
  star: '<path d="m8 2 1.8 3.85 4.2.5-3.1 2.9.8 4.15L8 11.35 4.3 13.4l.8-4.15L2 6.35l4.2-.5z"/>',
  bolt: '<path d="M9 1.75 3.5 9h4L7 14.25 12.5 7h-4z"/>',
  chart: '<path d="M2.25 2.25v11.5h11.5M5 10.5V8M8 10.5V5.25M11 10.5v-3.5"/>',
  tool: '<path d="M10.5 2.25a3.25 3.25 0 0 0-3.6 4.4l-4.4 4.4a1.3 1.3 0 0 0 1.85 1.85l4.4-4.4a3.25 3.25 0 0 0 4.4-3.6l-1.9 1.9-1.75-.3-.3-1.75z"/>',
};

/** Claude Code's and Codex's own tools, by name. */
const BUILT_IN = {
  Bash: "terminal",
  BashOutput: "terminal",
  KillShell: "terminal",
  Read: "file",
  NotebookRead: "file",
  Edit: "pencil",
  MultiEdit: "pencil",
  Write: "pencil",
  NotebookEdit: "pencil",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebSearch: "globe",
  WebFetch: "globe",
  Skill: "spark",
  ToolSearch: "plug",
  Agent: "agent",
  Task: "agent",
  TodoWrite: "list",
  TaskCreate: "list",
  TaskUpdate: "list",
  TaskList: "list",
  AskUserQuestion: "question",
};

/** A connector's icon by a word in its server's name (lower case), first match wins. */
const CONNECTORS = [
  ["gmail", "mail"],
  ["mail", "mail"],
  ["calendar", "calendar"],
  ["slush", "calendar"],
  ["drive", "folder"],
  ["sheets", "grid"],
  ["slack", "bubble"],
  ["notion", "page"],
  ["docs", "page"],
  ["gamma", "graph"],
  ["nocfo", "receipt"],
  ["foreman", "list"],
];

/**
 * The icon of a tool call, by the tool's name: a built-in tool's own, an MCP tool's
 * (`mcp__<server>__<tool>`) by its server, a plug for any other connector, and a wrench for any other tool.
 */
export function iconKey(name) {
  const text = typeof name === "string" ? name : "";
  if (Object.hasOwn(BUILT_IN, text)) return BUILT_IN[text];
  const mcp = /^mcp__(.+?)__/.exec(text);
  if (mcp) {
    const server = mcp[1].toLowerCase().replace(/_/g, " ");
    return CONNECTORS.find(([word]) => server.includes(word))?.[1] ?? "plug";
  }
  return "tool";
}

/** Every icon key, for the tests. */
export const ICON_KEYS = Object.keys(SHAPES);

/** A tool call's icon: an aria-hidden <svg class="tool-icon"> in the text's colour, 1em square. */
export function toolIcon(doc, name) {
  return iconByKey(doc, iconKey(name));
}

/** One of the icons by its key (a pasted text's page, D0056), the wrench for an unknown key. */
export function iconByKey(doc, wanted) {
  const key = Object.hasOwn(SHAPES, wanted) ? wanted : "tool";
  const holder = doc.createElement("span");
  holder.innerHTML = `<svg class="tool-icon" data-icon="${key}" viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${SHAPES[key]}</svg>`;
  return holder.firstElementChild;
}
