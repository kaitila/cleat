# D0018: Themes and the settings page

Date: 2026-11-15. Status: active. Task: T-0039.

## Context
The owner on 2026-11-15: "add a settings page ... and light mode etc." The pages followed `prefers-color-scheme` only. The settings contract (`GET`/`PUT /api/settings`, the `settings` message on `/ws`) is built by T-0030 at the same time, so the page was built and checked against a stub of that contract.

## Decision
- **theme.js is a classic script, first in `<head>`.** A module runs after the first paint, so the page would show the scheme's colours for a frame before the chosen ones. A plain script before the stylesheets sets `data-theme` before anything is drawn.
- **A cached value first, then the runner.** The last theme seen is kept in `localStorage` (`intuition.theme`) and applied at once; `GET /api/settings` follows, then each `settings` message. A newer message wins over a slower GET. The `storage` event carries a change to the runner's other open pages without the runner.
- **Each page opens its own WebSocket for the theme.** theme.js stays independent of each page's script, at the cost of one more local connection per page.
- **`data-theme` on `<html>`, none for system.** The forced sets in `base.css` are `:root[data-theme=…]`, which outrank the media rule's `:root`. They repeat the schemes' values rather than being new palettes: one design per scheme, its contrasts checked once, and a test that fails when the copies differ.
- **The settings page saves on change, the whole Settings each time.** One PUT at a time, and the newest state again if an edit came meanwhile. A text field saves when it is left or on Enter, not on each key. A new workspace row is held back until it has a name and a folder, so adding one doesn't show an error before it is written.
- **A 400 is shown at its field.** The `field` is read as dotted, bracketed or slash-separated (`workspaces[1].path`, `workspaces.1.path`, `/shell/hotkey`), mapped to the row on the page, and the most precise element that exists gets the error; otherwise the top status says it.
- **Shell settings are off until the shell has sent them.** While `shell` is null the shortcuts, dock and startup controls are disabled with a note. Writing defaults from the page would overwrite the person's own values before the shell's one-time migration.
- **Shortcuts are recorded from the keys pressed**, in Electron's accelerator form (`Control+Alt+Space`), and need Ctrl, Alt or Win: a global shortcut on a plain key would take that key from every app.

## Risk
- When the shell holds a shortcut globally, pressing that same shortcut on the settings page triggers it instead of recording it. Recording a different one works.
- If T-0030's 400 names fields in another form, errors fall back to the section or the top status until the mapping is updated.
