// The "Continue in terminal" control of the chat view's and the dock's session head: it copies
// `cd <cwd> && claude --resume <claudeSessionId>` to the clipboard and says so for a moment.
// Hidden while the session has no Claude Code session id. Shared by chat.js and dock.js.
import { resumeCommand } from "./chat-format.js";

const LABEL = "Continue in terminal";
/** How long the button says "Copied" (or that it couldn't). */
export const COPIED_MS = 1500;

/** A button for the head, and `show(session)` to call whenever the session shown or its metadata changes. */
export function resumeControl(document) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "resume quiet small";
  button.textContent = LABEL;
  button.hidden = true;
  let command = null;
  let timer = 0;
  const say = (text) => {
    clearTimeout(timer);
    button.textContent = text;
    timer = setTimeout(() => (button.textContent = LABEL), COPIED_MS);
  };
  button.addEventListener("click", async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      say("Copied");
    } catch {
      say("Couldn't copy");
    }
  });
  return {
    el: button,
    show(session) {
      const next = resumeCommand(session);
      if (next !== command) {
        clearTimeout(timer);
        button.textContent = LABEL;
      }
      command = next;
      button.hidden = !command;
      button.title = command ? `Copies: ${command}` : "";
    },
  };
}
