// The working indicator at the end of a stream while a turn runs (D0051, D0053, D0055), shared by
// the chat view and the dock. The Ledge whose dot hops; beside it the step under way (its icon and
// its label, "Gamma search organizations") or, between steps, a word of island lingo that changes
// every few seconds; and how long the turn has run. A label that changes cross-fades in; a light
// sweeps across it; the mark pops in, fades out when the turn ends, and hops higher when pointed at.
// The element comes from the page's #working-template; its text is set as textContent.
import { elapsedLabel, toolLabelText, workingWord } from "./chat-format.js";
import { toolIcon } from "./tool-icons.js";

/** How long an island word stays before the next one cross-fades in. */
export const WORD_MS = 4000;
/** How often the time and the word are looked at. */
const TICK_MS = 250;

/** Plays a one-off animation class again from its start. */
function replay(node, name) {
  node.classList.remove(name);
  void node.offsetWidth;
  node.classList.add(name);
}

/**
 * A new working indicator: { el, update({ step, since }), leave() }. `step`: the tool name of the call
 * under way, or null; `since`: when the turn began (ms), or null for no time. `leave` fades it out
 * and removes it.
 */
export function workingIndicator(doc) {
  const el = doc.getElementById("working-template").content.firstElementChild.cloneNode(true);
  const icon = el.querySelector(".working-step");
  const label = el.querySelector(".working-word");
  const time = el.querySelector(".working-time");
  let step = null;
  let since = null;
  let word = workingWord();
  let wordAt = Date.now();
  let shown = "";
  let shownIcon = "";

  function draw() {
    const now = Date.now();
    if (!step && now - wordAt >= WORD_MS) {
      word = workingWord(Math.random(), word);
      wordAt = now;
    }
    const text = step ? toolLabelText(step) : word;
    if (text !== shown) {
      shown = text;
      label.textContent = text;
      replay(label, "swap");
    }
    const iconName = step ?? "";
    if (iconName !== shownIcon) {
      shownIcon = iconName;
      icon.replaceChildren(...(step ? [toolIcon(doc, step)] : []));
      icon.hidden = !step;
      if (step) replay(icon, "swap");
    }
    const elapsed = since === null ? "" : elapsedLabel(now - since);
    if (time.textContent !== elapsed) time.textContent = elapsed;
    time.hidden = elapsed === "";
  }

  const timer = setInterval(draw, TICK_MS);
  // Pointed at, the dot hops higher, once.
  el.addEventListener("pointerenter", () => replay(el, "poke"));
  el.addEventListener("animationend", (e) => {
    if (e.animationName === "poke") el.classList.remove("poke");
  });

  return {
    el,
    update(next) {
      // Back between steps: the island word starts its own few seconds again.
      if (step && !next.step) wordAt = Date.now();
      step = next.step ?? null;
      since = Number.isFinite(next.since) ? next.since : null;
      draw();
    },
    leave() {
      clearInterval(timer);
      if (!el.isConnected) return;
      el.classList.add("leaving");
      const gone = () => el.remove();
      el.addEventListener("animationend", (e) => e.target === el && gone());
      setTimeout(gone, 600);
    },
  };
}
