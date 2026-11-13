# D0013: Our own small markdown renderer, building DOM nodes; links only to http(s) and mailto; a synthesised italic

Date: 2026-11-13. Status: active.

## Decision
- The assistant's messages are drawn by `src/web/markdown.js`, one module both pages import: `renderMarkdown(text, document, { streaming })` returns a `DocumentFragment`. It is about 400 lines, written here; no library.
- It builds nodes only, with `createElement`, `createTextNode` and `textContent`. Nothing in it parses HTML, so markup in the model's text is text. A unit test greps the module for `innerHTML` and the like.
- A link keeps its `href` only when it starts with `http:`, `https:` or `mailto:`; any other link (javascript:, data:, a relative path) stays as the markdown it was written as. Links get `target="_blank"` and `rel="noopener noreferrer"`; what opening one does is the shell's (another task). Images are not drawn: the pages ask no other host for anything.
- What it understands: paragraphs (each line break kept, as in a chat), `**bold**`, `*italic*`, `_italic_`, `~~strike~~`, code spans, fenced code blocks (the language on `data-lang`, shown as a quiet label by CSS, no highlighting), headings 1 to 6, bullet, numbered and task lists (nested, and right after a paragraph line), block quotes, rules, links, `<url>` and bare http(s) URLs, and tables with a header row and alignment. Anything else is plain text. Nested emphasis is resolved by a simple left-to-right search, not CommonMark's delimiter algorithm.
- Streaming text is drawn again at most once per animation frame. With `streaming: true` an emphasis or code span still open at the very end of the text is drawn as if closed there, so `**bol` shows bold while it arrives; an open fence always runs to the end. The complete `assistant_text` event replaces the streamed drawing.
- `<em>` is italic by the browser's synthesised oblique (`font-synthesis: style` on `.md em` only). Weights are still never synthesised.
- The styles are a `.md` component in `base.css`, so both pages share them; the dock only puts inline code on `--bg`, since its own surface is `--sunken`.

## Why
- No dependencies without a person's approval, and the pages have no build step: a library would have to be vendored. The subset a chat needs is small, and a renderer that never touches HTML is easier to trust than a sanitiser after a full one.
- Keeping the source of a refused link, instead of only its label, shows the person what the model wrote.
- Line breaks kept: a model's message is a chat message, and lines like "Time: 17:00" next to each other are meant as lines.
- The synthesised italic: the alternative is shipping Inter's italic files (another 100 KB or so, and a change to the fonts D0007 fetched). A slanted Inter reads as emphasis at 13px, which is all `*x*` asks for. This replaces D0007's "nothing on the pages is italic".

## Not done here
- Opening a link in the person's browser from the shell's windows: another task.
- Images, footnotes, HTML blocks, setext headings, indented code blocks and reference links stay as text.
