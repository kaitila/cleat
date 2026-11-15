# D0027: The dropdown is a styled `<select>` (`appearance: base-select`), not a listbox built in JavaScript

Date: 2026-11-15. Status: active. Task: T-0046. Builds on [D0007](D0007-design-system.md).

## Context
The chat view's workspace filter and the settings page's permission mode were plain `<select>`s, so their open list was drawn by the OS: white rows and a light-blue highlight in a dark window. The owner wanted a dropdown that matches the design.

## Decision
- **`.select` in `base.css`, on a real `<select>`.** Where the browser can style the select's list (`appearance: base-select`, Chromium 135 and later; the shell's Electron 45 is Chromium 140), base.css draws it like a menu: a surface with `--shadow` and `--radius`, a hair below the button and at least as wide, rows that highlight under the pointer or the keys, and a check at the end of the chosen one. The button has a chevron that turns over while the list is open. `.quiet` and `.small` give the sidebar's quiet 20px filter.
- **No JavaScript.** Keys, typing to jump, the `change` event, `select.value`, `options` and what a screen reader hears all stay the browser's, so `chat.js`, `settings.js` and the UI tests that call `selectOption` are unchanged.
- **Elsewhere the OS's list shows.** Everything that styles the list sits in `@supports (appearance: base-select)`; a browser without it keeps the closed control's look and its own list.

## Alternatives
- A listbox built in JavaScript (a button, a popup with `role="listbox"`, focus and keys by hand): a new module and every page's code and tests moved to it, for what the browser now does itself.

## Risk
- Opening the chat view in Firefox or Safari shows the OS's list. The app's windows are Electron's, so that is only for someone who opens the runner's page in another browser.
