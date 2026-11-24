// The keyboard-shortcuts sheet, the guide's rows as Settings shows them, and the small tooltip the
// pages draw themselves (D0046). The list is shortcuts.js's; this file only draws it.
//
// The tooltip is the page's own, not the OS's: on a Mac the dock is a non-activating panel of an app
// that is not the active one, where a native tooltip may never show, and inside the black notch an
// OS tooltip box would sit half outside the island, where the shell lets the mouse through. This one
// stays inside the element it is given (the island's panel, the page), uses the tokens, and fades
// only where motion is allowed (base.css turns transitions off under reduced motion).

import { isGuideKey, typingIn } from "./shortcuts.js";

const h = (document, tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

/** A compact hint line (shortcuts.js, hintLine) into `into`: each key's caps, then its word. */
export function renderHint(document, into, parts) {
  into.replaceChildren(...parts.flatMap(({ caps, word }) => [...caps.map((cap) => h(document, "kbd", "", cap)), h(document, "span", "", word)]));
}

/** The guide's sections as a list: a label per section, a row per key, its combos as keycaps. */
export function renderGuide(document, sections) {
  const root = h(document, "div", "guide");
  for (const section of sections) {
    const part = h(document, "section", "guide-section");
    part.dataset.section = section.id;
    const title = h(document, "h3", "guide-title label", section.title);
    title.id = `guide-${section.id}`;
    part.setAttribute("aria-labelledby", title.id);
    const rows = h(document, "dl", "guide-rows");
    for (const row of section.rows) {
      const line = h(document, "div", "guide-row");
      line.dataset.key = row.id;
      const keys = h(document, "dd", "guide-keys");
      row.keys.forEach((caps, i) => {
        if (i > 0) keys.append(h(document, "span", "guide-or muted", "or"));
        const combo = h(document, "span", "combo");
        combo.append(...caps.map((cap) => h(document, "kbd", "", cap)));
        keys.append(combo);
      });
      line.append(h(document, "dt", "guide-what", row.what), keys);
      rows.append(line);
    }
    part.append(title, rows);
    root.append(part);
  }
  return root;
}

/**
 * The sheet: a panel over `within` with every shortcut, opened by ? (when the focus is not in a text
 * box), by a menu item or a button, and closed by Esc, its close button or a press beside it.
 * `sections()` gives the guide at the moment it opens, so the person's recorded keys are current.
 * `onChange(open)` hears each opening and closing; `keys()` says whether ? may open it now.
 */
export function shortcutsSheet(document, within, { sections, onChange = () => {}, keys = () => true } = {}) {
  const el = h(document, "div", "sheet glass-float");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "sheet-title");
  el.hidden = true;
  const head = h(document, "header", "sheet-head");
  const title = h(document, "h2", "sheet-title strong", "Keyboard shortcuts");
  title.id = "sheet-title";
  const close = h(document, "button", "sheet-close quiet small", "Close");
  close.type = "button";
  close.title = "Close (Esc)";
  head.append(title, close);
  const body = h(document, "div", "sheet-body");
  el.append(head, body);
  within.append(el);

  let back = null;
  const api = {
    el,
    get isOpen() {
      return !el.hidden;
    },
    open() {
      body.replaceChildren(renderGuide(document, sections()));
      if (!el.hidden) return;
      back = document.activeElement;
      el.hidden = false;
      body.scrollTop = 0;
      close.focus({ preventScroll: true });
      onChange(true);
    },
    close(refocus = true) {
      if (el.hidden) return;
      el.hidden = true;
      if (refocus && back?.isConnected && typeof back.focus === "function") back.focus({ preventScroll: true });
      back = null;
      onChange(false);
    },
    toggle() {
      if (el.hidden) api.open();
      else api.close();
    },
  };
  close.addEventListener("click", () => api.close());
  // First of all key handlers: Esc closes the sheet and nothing else (not the switch, not the dock).
  document.defaultView?.addEventListener("keydown", (e) => {
    if (!el.hidden && e.key === "Escape" && !e.isComposing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      api.close();
      return;
    }
    if (isGuideKey(e) && keys() && !typingIn(document.activeElement)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      api.toggle();
    }
  }, true);
  document.addEventListener("pointerdown", (e) => {
    if (!el.hidden && !el.contains(e.target)) api.close(false);
  }, true);
  return api;
}

/**
 * Tooltips for every control with a `title` (or `data-tip`) inside `within`: shown after a short
 * rest of the pointer, or at once for a keyboard focus, placed under the control (over it when there
 * is no room) and kept inside `within`. A `title` is moved to `data-tip` when first pointed at, so
 * the OS's tooltip doesn't show as well; a control named only by its title keeps it as aria-label.
 * `enabled()` can turn them off (the dock while it is a pill).
 */
export function tooltips(document, within, { delay = 500, enabled = () => true } = {}) {
  const tipEl = h(document, "div", "tip small");
  tipEl.setAttribute("role", "tooltip");
  tipEl.id = "tip";
  tipEl.hidden = true;
  within.append(tipEl);
  let timer = 0;
  let target = null;

  const take = (el) => {
    const title = el.getAttribute("title");
    if (title !== null) {
      if (title && !el.getAttribute("aria-label") && !el.textContent.trim()) el.setAttribute("aria-label", title);
      el.dataset.tip = title;
      el.removeAttribute("title");
    }
    return el.dataset.tip ?? "";
  };
  const hide = () => {
    clearTimeout(timer);
    if (target) target.removeAttribute("aria-describedby");
    target = null;
    tipEl.hidden = true;
  };
  const show = (el) => {
    const text = take(el);
    if (!text || !enabled() || !el.isConnected) return;
    target = el;
    tipEl.textContent = text;
    tipEl.hidden = false;
    el.setAttribute("aria-describedby", tipEl.id);
    const box = within.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const gap = 6;
    const w = tipEl.offsetWidth;
    const ht = tipEl.offsetHeight;
    let x = r.left + r.width / 2 - w / 2 - box.left;
    x = Math.max(gap, Math.min(x, box.width - w - gap));
    let y = r.bottom + gap - box.top;
    if (y + ht > box.height - gap) y = r.top - gap - ht - box.top;
    y = Math.max(gap, y);
    tipEl.style.left = `${Math.round(x)}px`;
    tipEl.style.top = `${Math.round(y)}px`;
  };
  const owner = (node) => {
    const el = node instanceof Element ? node.closest("[title], [data-tip]") : null;
    return el && within.contains(el) && el !== tipEl ? el : null;
  };
  document.addEventListener("pointerover", (e) => {
    const el = owner(e.target);
    if (el === target) return;
    hide();
    if (!el) return;
    take(el);
    timer = setTimeout(() => show(el), delay);
  });
  document.addEventListener("pointerout", (e) => {
    if (target && e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) return;
    if (!e.relatedTarget || owner(e.relatedTarget) !== owner(e.target)) hide();
  });
  document.addEventListener("focusin", (e) => {
    const el = owner(e.target);
    hide();
    if (el && el.matches(":focus-visible")) show(el);
  });
  document.addEventListener("focusout", hide);
  for (const type of ["pointerdown", "keydown", "wheel"]) document.addEventListener(type, hide, true);
  document.defaultView?.addEventListener("blur", hide);
  return { el: tipEl, hide };
}
