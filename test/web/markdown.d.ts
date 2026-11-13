// Types for src/web/markdown.js, so the tests typecheck (see chat-format.d.ts for why they live here).
declare module "*/web/markdown.js" {
  /** The few parts of a document the renderer uses. */
  export interface DocLike {
    createElement(tag: string): unknown;
    createTextNode(text: string): unknown;
    createDocumentFragment(): unknown;
  }
  export function renderMarkdown<D extends DocLike>(text: string, doc: D, options?: { streaming?: boolean }): ReturnType<D["createDocumentFragment"]>;
}
