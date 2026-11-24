// The pages' localStorage keys from before the rename (D0043): each intuition.<key> becomes
// holm.<key>, once. A plain script, loaded right after theme.js by the chat and the dock: it runs
// before the pages' modules read their keys. All the pages share one origin, so one page moving
// them is enough. A value already under the new key is kept; the old key goes either way.
(() => {
  const KEYS = ["theme", "dock.session", "dock.workspace", "chat.folded"];
  try {
    for (const key of KEYS) {
      const old = `intuition.${key}`;
      const value = localStorage.getItem(old);
      if (value === null) continue;
      if (localStorage.getItem(`holm.${key}`) === null) localStorage.setItem(`holm.${key}`, value);
      localStorage.removeItem(old);
    }
  } catch {
    // No storage: nothing to move.
  }
})();
