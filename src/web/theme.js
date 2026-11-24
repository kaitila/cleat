// The theme the person chose in Settings: "system", "light" or "dark" (docs/design.md, "Themes";
// D0018). Every page loads this first, as a plain script in <head> before its stylesheets, so the
// page is drawn in its theme from the first frame: a module would run only after the first paint.
// It sets data-theme on <html> (light or dark; none for "system", which leaves it to
// prefers-color-scheme), from the value cached in localStorage at once, then from GET
// /api/settings, and from then on from each { type: "settings" } message on /ws.
(() => {
  const KEY = "cleat.theme";
  const THEMES = ["system", "light", "dark"];
  const root = document.documentElement;

  /** Sets the page's theme and remembers it for the next page that opens. Unknown values are ignored. */
  function apply(theme) {
    if (!THEMES.includes(theme)) return;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Storage may be off: the page still follows the runner.
    }
  }

  try {
    const cached = localStorage.getItem(KEY);
    if (cached) apply(cached);
  } catch {
    // No storage: the runner's answer below sets it.
  }

  /** Bumped by every answer and message, so a slow GET can't undo a newer message. */
  let generation = 0;
  function load() {
    const mine = ++generation;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((settings) => {
        if (mine === generation && settings) apply(settings.theme);
      })
      .catch(() => {});
  }

  let attempt = 0;
  function connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    // Whatever changed while it was away: ask again on every connection.
    ws.addEventListener("open", () => {
      attempt = 0;
      load();
    });
    ws.addEventListener("message", (e) => {
      let message;
      try {
        message = JSON.parse(e.data);
      } catch {
        return;
      }
      if (message?.type !== "settings" || !message.settings) return;
      generation++;
      apply(message.settings.theme);
    });
    ws.addEventListener("close", () => {
      setTimeout(connect, Math.min(5000, 500 * 2 ** attempt));
      attempt += 1;
    });
  }

  // Another page of the runner's changed it (the settings page while the runner is away).
  addEventListener("storage", (e) => {
    if (e.key === KEY && e.newValue) apply(e.newValue);
  });

  /** For the settings page: apply a choice at once, before the runner has answered. */
  window.cleatTheme = { apply, current: () => root.getAttribute("data-theme") ?? "system" };
  connect();
})();
