// The two agents a session can run on (docs/agents.md), as the pages show them: their names, the
// small glyph that marks a session's agent (with the name as its tooltip, never a word on the row),
// and the flip of the pop-up's and the snip's switch. Shared by the pop-up, the snip, the settings,
// the chat view and the dock.

export const AGENTS = ["claude", "codex"];
export const AGENT_NAMES = { claude: "Claude Code", codex: "Codex" };

/** A session's or a workspace's agent: "codex" only when it says so; anything else (absent, older runners) is Claude Code. */
export const agentOf = (thing) => (thing?.agent === "codex" ? "codex" : "claude");

/** The name of an agent, Claude Code for anything unknown. */
export const agentName = (kind) => AGENT_NAMES[kind === "codex" ? "codex" : "claude"];

/** The other agent: what the switch's key turns the choice to. */
export const flipAgent = (kind) => (kind === "codex" ? "claude" : "codex");

/** The tooltip of a session's mark. */
export const agentTitle = (kind) => `Runs on ${agentName(kind)}`;

/**
 * The glyphs, drawn in a 16 unit box with the text's colour, 1em square. Claude Code is an eight
 * ray spark; Codex a hexagon. Plain shapes, not either product's logo.
 */
const SHAPES = {
  claude: '<path d="M8 2.25v11.5M2.25 8h11.5M3.93 3.93l8.14 8.14M12.07 3.93l-8.14 8.14"/>',
  codex: '<path d="M8 1.9l5.3 3.05v6.1L8 14.1l-5.3-3.05v-6.1z"/>',
};

/** The bare SVG of an agent's glyph, for a page to place inside its own element (aria-hidden). */
export function agentSvg(doc, kind) {
  const holder = doc.createElement("span");
  holder.innerHTML = `<svg class="agent-glyph" viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${SHAPES[kind === "codex" ? "codex" : "claude"]}</svg>`;
  return holder.firstElementChild;
}

/**
 * A session's agent mark: the glyph in a span with the agent as its tooltip and accessible name.
 * `setAgentMark` changes it in place when the session it marks is another agent's.
 */
export function agentMark(doc, kind, className = "agent-mark") {
  const mark = doc.createElement("span");
  mark.className = className;
  mark.setAttribute("role", "img");
  setAgentMark(mark, kind);
  return mark;
}

export function setAgentMark(mark, kind) {
  const k = kind === "codex" ? "codex" : "claude";
  if (mark.dataset.agent === k) return;
  mark.dataset.agent = k;
  mark.title = agentTitle(k);
  mark.setAttribute("aria-label", agentTitle(k));
  mark.replaceChildren(agentSvg(mark.ownerDocument, k));
}

/**
 * The agent the pop-up or the snip starts the task on: the one the person flipped to (`override`),
 * else the chosen workspace's own (WorkspacesResponse's `agent`), else Claude Code.
 */
export function pickAgent(workspaces, workspace, override = null) {
  if (override === "claude" || override === "codex") return override;
  return agentOf(workspaces.find((w) => w.name === workspace));
}

/** True for the key that flips the agent: Alt+A (the physical key, so any layout and Option on a Mac). */
export const isAgentKey = (event) => Boolean(event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.code === "KeyA" || (!event.code && /^a$/i.test(event.key ?? ""))));

/** The task box's placeholder for the agent: who will do it. */
export const taskPlaceholder = (kind, snip = false) => `What should ${kind === "codex" ? "Codex" : "Claude"} do${snip ? " with this" : ""}?`;
