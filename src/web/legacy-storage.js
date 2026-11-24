// The pages' localStorage keys from before the renames (D0043, D0048): each holm.<key> and
// intuition.<key> becomes cleat.<key>, once. A plain script, loaded right after theme.js by the chat and
// the dock: it runs before the pages' modules read their keys. All the pages share one origin, so one
// page moving them is enough. A value already under the new key is kept, and holm's comes before
// intuition's; the old keys go either way.
(() => {
  const KEYS = ["theme", "dock.session", "dock.workspace", "chat.folded"];
  const OLD = ["holm", "intuition"];
  try {
    for (const key of KEYS) {
      for (const name of OLD) {
        const old = `${name}.${key}`;
        const value = localStorage.getItem(old);
        if (value === null) continue;
        if (localStorage.getItem(`cleat.${key}`) === null) localStorage.setItem(`cleat.${key}`, value);
        localStorage.removeItem(old);
      }
    }
  } catch {
    // No storage: nothing to move.
  }
})();
