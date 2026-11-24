// The landing page: the install line's Copy button, the keys written for the visitor's computer,
// and the notch, which goes round its idle, peek and open on sample sessions the way the app's dock
// does (src/web/dock.js): its clip is sized to each state's content and springs there (site.css),
// and each state's content keeps its size and place while it fades in.

// ---------- Copy ----------
const copy = document.getElementById("copy");
const line = document.getElementById("install-line");
copy?.addEventListener("click", async () => {
  const text = line?.textContent ?? "";
  let done = false;
  try {
    await navigator.clipboard.writeText(text);
    done = true;
  } catch {
    // No clipboard API (an insecure context, an old browser): select the line to copy by hand.
    const range = document.createRange();
    if (line) range.selectNodeContents(line);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }
  copy.textContent = done ? "Copied" : "Selected";
  clearTimeout(Number(copy.dataset.timer));
  copy.dataset.timer = String(setTimeout(() => (copy.textContent = "Copy"), 2000));
});

// ---------- the keys, as on this computer ----------
// A Mac's by default (Cmd+Shift); Windows and Linux press Ctrl+Alt (the app's defaults on each).
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
if (!mac) {
  for (const key of document.querySelectorAll("kbd[data-other]")) key.textContent = /** @type {HTMLElement} */ (key).dataset.other ?? "";
}

// ---------- the notch ----------
const island = document.getElementById("island");
if (island) runNotch(island);

/** @param {HTMLElement} island */
function runNotch(island) {
  /** @type {Record<string, HTMLElement>} */
  const layers = {};
  for (const el of island.querySelectorAll("[data-layer]")) layers[/** @type {HTMLElement} */ (el).dataset.layer ?? ""] = /** @type {HTMLElement} */ (el);
  const approval = island.querySelector(".approval");
  const approvalState = island.querySelector(".approval-state");
  const allow = island.querySelector("[data-press]");

  /** Sizes the clip to a state's content: as wide and tall as its layer. */
  const shape = (state) => {
    const layer = layers[state];
    if (!layer) return;
    island.style.setProperty("--island-w", `${layer.offsetWidth}px`);
    island.style.setProperty("--island-h", `${layer.offsetHeight}px`);
  };
  /** Shows one state: the old content fades out, the new one comes in as the shape springs to it. */
  const show = (state) => {
    for (const [name, layer] of Object.entries(layers)) {
      if (name === state) {
        layer.classList.remove("leaving");
        layer.hidden = false;
        // Restart its arrival.
        layer.style.animation = "none";
        void layer.offsetWidth;
        layer.style.animation = "";
      } else if (!layer.hidden && !layer.classList.contains("leaving")) {
        layer.classList.add("leaving");
        const gone = () => {
          if (!layer.classList.contains("leaving")) return;
          layer.classList.remove("leaving");
          layer.hidden = true;
        };
        layer.addEventListener("animationend", gone, { once: true });
        // Where nothing animates (animations off in the browser), it goes all the same.
        setTimeout(gone, 400);
      }
    }
    island.dataset.state = state;
    shape(state);
  };
  const switchDot = island.querySelector(".switch .dot");
  const wide = matchMedia("(min-width: 761px)");
  const decide = (allowed) => {
    approval?.setAttribute("data-state", allowed ? "allow" : "open");
    // Allowed, the session runs again.
    switchDot?.setAttribute("data-status", allowed ? "running" : "waiting_approval");
    if (approvalState) approvalState.textContent = allowed ? "Allowed" : "Needs your approval";
  };

  // The story, round and round: sessions run, one asks, the dock opens, Allow, it closes.
  const steps = [
    { at: 0, run: () => { decide(false); show("idle"); } },
    { at: 2200, run: () => show("peek") },
    { at: 4800, run: () => show("open") },
    { at: 7600, run: () => allow?.setAttribute("data-pressed", "") },
    { at: 7900, run: () => { allow?.removeAttribute("data-pressed"); decide(true); shape("open"); } },
    // One click (or Cmd+Shift+J): the same notch grows into the whole chat. Not on a narrow screen,
    // where the chat would not fit.
    { at: 9400, run: () => show(wide.matches ? "chat" : "idle") },
    { at: 13600, run: () => show("idle") },
  ];
  const LOOP = 15800;
  /** @type {number[]} */
  let timers = [];
  let playing = false;
  const play = () => {
    if (playing) return;
    playing = true;
    const round = () => {
      timers = steps.map((s) => setTimeout(s.run, s.at));
      timers.push(setTimeout(round, LOOP));
    };
    round();
  };
  const pause = () => {
    playing = false;
    for (const t of timers) clearTimeout(t);
    timers = [];
  };

  // Its first shape at once, with no spring: the notch with its wings.
  island.style.transition = "none";
  document.fonts.ready.then(() => {
    shape("idle");
    requestAnimationFrame(() => (island.style.transition = ""));
  });
  addEventListener("resize", () => shape(island.dataset.state ?? "idle"));

  // It plays only while it can be seen.
  let visible = true;
  const update = () => (visible && !document.hidden ? play() : pause());
  document.addEventListener("visibilitychange", update);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      update();
    }).observe(island);
  } else update();
}
