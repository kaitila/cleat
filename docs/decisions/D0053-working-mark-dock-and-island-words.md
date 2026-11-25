# D0053: The working mark in the dock too, with a word of island lingo

Date: 2026-11-25. Status: active. Task T-0008. Extends [D0051](D0051-quiet-tool-calls-and-working-mark.md).

## Context
After D0051 shipped, the owner said: "i dont see the logo hopping at the end". The mark was only in the chat view (`chat.js`). The panel that opens when you hover the notch is the dock's own page (`dock.js`), with its own stream, and it had no mark; its streaming text was still muted, too. Then: "also maybe add a small text label, just like other apps use, maybe a random 'island lingo'".

## Decision
- **The dock's panel draws the working mark too**, the same way: a `#working-template` in `dock.html`, kept as the last thing in the stream while the selected session's status is `running` (`renderWorking`, from `renderHead`), with the streaming text before it. The dock's streaming text is the text's colour, as in the chat.
- **A word beside the mark**, `.working-word`: small and `--muted`, picked at random from `WORKING_WORDS` in `chat-format.js` each time the mark appears, and kept while it stays. The words are island and harbour lingo, as a cleat is the fitting a boat is tied to: "Island-hopping…", "Reading the tides…", "Casting off…", "Coiling rope…". They are calm on purpose: nothing about sinking or storms.

## Alternatives
- **A fixed word ("Working…")**: the owner asked for something random, as other agent apps do.
- **Changing the word every few seconds**: livelier, but it pulls the eye away from the text that is arriving.

## Risk
- The words are play, not status: what the agent is doing is in the run of steps above the mark.
