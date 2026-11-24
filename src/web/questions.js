// An agent's questions (Claude Code's AskUserQuestion) in an approval card: each question with its
// options to pick and a line for the person's own words. Their answers go back as the approval's
// `answers` (docs/protocol.md, D0039). The chat view and the dock draw the same card.
// Every text is set as textContent, so nothing the agent wrote is parsed.

export const ASK_USER_QUESTION = "AskUserQuestion";
/** One answer is at most this long (the runner's MAX_ANSWER). */
export const MAX_ANSWER = 4000;

/**
 * The questions of an AskUserQuestion input, as the card draws them, or null when the input is not
 * one it can draw (then the card is the usual Allow and Deny).
 */
export function questionsOf(toolName, input) {
  if (toolName !== ASK_USER_QUESTION || typeof input !== "object" || input === null) return null;
  const list = input.questions;
  if (!Array.isArray(list) || list.length === 0) return null;
  const seen = new Set();
  const out = [];
  for (const q of list) {
    if (typeof q !== "object" || q === null || typeof q.question !== "string" || !q.question || seen.has(q.question)) return null;
    seen.add(q.question);
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter((o) => typeof o === "object" && o !== null && typeof o.label === "string" && o.label)
      .map((o) => ({ label: o.label, description: typeof o.description === "string" ? o.description : "" }));
    out.push({ question: q.question, header: typeof q.header === "string" ? q.header : "", multiSelect: q.multiSelect === true, options });
  }
  return out;
}

/**
 * One question's answer: the labels picked, then the person's own words, ", " between them, as
 * Claude Code joins a multiSelect answer. "" when nothing is picked or written.
 */
export function answerOf(picked, own) {
  const words = own.trim();
  return [...picked, ...(words ? [words] : [])].join(", ");
}

const DECIDED = { allow: "Answered", deny: "Skipped" };

/** What a decided question card says. One nobody answered (its turn is over) is "Not answered". */
export function questionDecidedLabel(decision) {
  return Object.hasOwn(DECIDED, decision) ? DECIDED[decision] : "Not answered";
}

function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

let forms = 0;

/**
 * The questions as a form: a fieldset each, its options as radio buttons (checkboxes for a
 * multiSelect one), then a line for the person's own words. With one option picked, typing there
 * clears it, and picking one clears the words: the answer is one or the other. `onChange` runs on
 * every change, `onSubmit` on Enter in a line of words.
 * Returns { el, answers() (null until every question has an answer), setDisabled(flag) }.
 */
export function questionForm(questions, { onChange = () => {}, onSubmit = () => {} } = {}) {
  const el = h("div", "questions");
  const id = ++forms;
  const reads = [];
  const sets = [];
  questions.forEach((q, i) => {
    const set = h("fieldset", "question");
    const legend = h("legend", "question-text");
    if (q.header) legend.append(h("span", "question-header small", q.header));
    legend.append(h("span", "", q.question));
    set.append(legend);
    const boxes = [];
    for (const o of q.options) {
      const row = h("label", "option");
      const box = h("input");
      box.type = q.multiSelect ? "checkbox" : "radio";
      box.name = `question-${id}-${i}`;
      box.value = o.label;
      const words = h("span", "option-words");
      words.append(h("span", "option-label", o.label));
      if (o.description) words.append(h("span", "option-description muted small", o.description));
      row.append(box, words);
      set.append(row);
      boxes.push(box);
    }
    const own = h("input", "input option-own");
    own.type = "text";
    own.maxLength = MAX_ANSWER;
    own.placeholder = q.options.length === 0 ? "Your answer" : q.multiSelect ? "Something else too" : "Or in your own words";
    own.setAttribute("aria-label", `${q.question}: your own answer`);
    own.addEventListener("input", () => {
      if (!q.multiSelect && own.value.trim()) for (const b of boxes) b.checked = false;
      onChange();
    });
    own.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      onSubmit();
    });
    for (const b of boxes) {
      b.addEventListener("change", () => {
        if (!q.multiSelect && b.checked) own.value = "";
        onChange();
      });
    }
    set.append(own);
    el.append(set);
    sets.push(set);
    reads.push(() => answerOf(boxes.filter((b) => b.checked).map((b) => b.value), own.value));
  });
  return {
    el,
    answers() {
      const out = {};
      for (let i = 0; i < questions.length; i++) {
        const answer = reads[i]();
        if (!answer) return null;
        out[questions[i].question] = answer;
      }
      return out;
    },
    setDisabled(flag) {
      for (const set of sets) set.disabled = flag;
    },
  };
}

/** A decided card's questions and what was answered: each question, then its answer (none when skipped). */
export function answersList(questions, answers) {
  const list = h("dl", "question-answers");
  for (const q of questions) {
    list.append(h("dt", "small muted", q.question));
    const answer = answers && typeof answers[q.question] === "string" ? answers[q.question] : "";
    if (answer) list.append(h("dd", "", answer));
  }
  return list;
}
