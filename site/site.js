// The landing page: the install line's Copy button, the sections that arrive as they scroll into
// view, and the dock in the hero, which goes round its idle, peek and open on sample sessions the
// way the app's dock does (src/web/dock.js): its clip is sized to each state's content and springs
// there (site.css), and each state's content keeps its size and place while it fades in.

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
    // No clipboard API (an insecure context, an old browser): select the line for Ctrl+C.
    const range = document.createRange();
    if (line) range.selectNodeContents(line);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  }
  copy.textContent = done ? "Copied" : "Press Ctrl+C";
  clearTimeout(Number(copy.dataset.timer));
  copy.dataset.timer = String(setTimeout(() => (copy.textContent = "Copy"), 2000));
});

// ---------- sections arrive as they come into view ----------
// What is below the fold when the page opens waits, and fades and rises in once its top comes into
// view, or once it has been scrolled past (a jump to the end shows everything on the way).
const waiting = [...document.querySelectorAll(".reveal")].filter((el) => el.getBoundingClientRect().top > innerHeight);
for (const el of waiting) /** @type {HTMLElement} */ (el).dataset.hidden = "";
let queued = false;
const reveal = () => {
  queued = false;
  for (const el of waiting.splice(0)) {
    if (el.getBoundingClientRect().top < innerHeight * 0.9) {
      delete /** @type {HTMLElement} */ (el).dataset.hidden;
      /** @type {HTMLElement} */ (el).dataset.shown = "";
    } else waiting.push(el);
  }
  if (!waiting.length) removeEventListener("scroll", onScroll);
};
const onScroll = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(reveal);
};
if (waiting.length) {
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll, { passive: true });
}

// ---------- the dock ----------
const island = document.getElementById("island");
if (island) runDock(island);

/** @param {HTMLElement} island */
function runDock(island) {
  /** @type {Record<string, HTMLElement>} */
  const layers = {};
  for (const el of island.querySelectorAll("[data-layer]")) layers[/** @type {HTMLElement} */ (el).dataset.layer ?? ""] = /** @type {HTMLElement} */ (el);
  const approval = island.querySelector(".approval");
  const approvalState = island.querySelector(".approval-state");
  const allow = island.querySelector("[data-press]");
  const surface = island.querySelector(".surface");

  /** Sizes the clip to a state's content: as wide and tall as its layer. */
  const shape = (state) => {
    const layer = layers[state];
    if (!layer) return;
    const w = `${layer.offsetWidth}px`;
    const h = `${layer.offsetHeight}px`;
    for (const el of [island, surface]) {
      /** @type {HTMLElement} */ (el).style.setProperty("--island-w", w);
      /** @type {HTMLElement} */ (el).style.setProperty("--island-h", h);
    }
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
  const decide = (allowed) => {
    approval?.setAttribute("data-state", allowed ? "allow" : "open");
    if (approvalState) approvalState.textContent = allowed ? "Allowed" : "Needs your approval";
  };

  // The story, round and round: a session runs, it asks, the dock is opened, Allow, it closes.
  const steps = [
    { at: 0, run: () => { decide(false); show("idle"); } },
    { at: 1800, run: () => show("peek") },
    { at: 4400, run: () => show("open") },
    { at: 6600, run: () => allow?.setAttribute("data-pressed", "") },
    { at: 6800, run: () => { allow?.removeAttribute("data-pressed"); decide(true); } },
    { at: 8200, run: () => show("idle") },
  ];
  const LOOP = 10000;
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

  // Its first shape at once, with no spring: the quiet pill.
  island.style.transition = "none";
  surface && (/** @type {HTMLElement} */ (surface).style.transition = "none");
  document.fonts.ready.then(() => {
    shape("idle");
    requestAnimationFrame(() => {
      island.style.transition = "";
      if (surface) /** @type {HTMLElement} */ (surface).style.transition = "";
    });
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
