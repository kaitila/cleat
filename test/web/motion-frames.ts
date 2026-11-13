// A frame strip of a CSS animation, for the browser scripts (snip-ui.ts, prompt-ui.ts): the
// animations on the elements a selector names are paused and stepped to each time, a clip of the
// page is taken at each, and the clips are laid out in one image, labelled with their time, so a
// person can see the spring's path. The animations are let go to their end afterwards.

interface Rect { x: number; y: number; width: number; height: number }
/** The little of playwright's Page the strip needs. */
export interface FramePage {
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  screenshot(options: { clip?: Rect; path?: string; fullPage?: boolean }): Promise<Uint8Array>;
  setContent(html: string): Promise<unknown>;
  close(): Promise<void>;
}

/** Pauses every animation on the page where it is, so a strip taken after another still finds it running. */
export async function pauseAll(page: FramePage): Promise<void> {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) a.pause();
  }, undefined);
}

/** Steps the animations on `selector` to `t` ms and holds them there; `t` null lets them finish. */
async function hold(page: FramePage, selector: string, t: number | null): Promise<number> {
  return page.evaluate(
    ({ selector, t }) => {
      let n = 0;
      for (const a of document.getAnimations()) {
        const target = (a.effect as KeyframeEffect | null)?.target;
        if (!(target instanceof Element) || !target.matches(selector)) continue;
        n++;
        if (t === null) a.finish();
        else {
          a.pause();
          a.currentTime = t;
        }
      }
      return n;
    },
    { selector, t },
  );
}

/**
 * Saves a strip of `clip` at each of `times` (ms into the animations on `selector`) to `path`.
 * `blank` is an empty page to lay the strip out on; it is closed after. Returns how many
 * animations were stepped (0: nothing was running, and the strip shows the end state only).
 */
export async function frameStrip(page: FramePage, blank: FramePage, options: { selector: string; clip: Rect; times: number[]; path: string; title: string; zoom?: number }): Promise<number> {
  const { selector, clip, times, path, title, zoom = 1 } = options;
  const frames: string[] = [];
  let count = 0;
  for (const t of times) {
    count = Math.max(count, await hold(page, selector, t));
    frames.push(Buffer.from(await page.screenshot({ clip })).toString("base64"));
  }
  await hold(page, selector, null);
  const columns = Math.min(times.length, Math.max(1, Math.floor(2400 / (clip.width * zoom))));
  const cells = frames.map((png, i) => `<figure><img src="data:image/png;base64,${png}"><figcaption>${times[i]} ms</figcaption></figure>`).join("");
  await blank.setContent(
    `<!doctype html><body style="margin:0;padding:12px;background:#777;font:12px system-ui;color:#fff"><div>${title}</div>` +
      `<div style="display:grid;grid-template-columns:repeat(${columns},max-content);gap:8px;margin-top:8px">${cells}</div>` +
      `<style>figure{margin:0}img{display:block;width:${clip.width * zoom}px;height:${clip.height * zoom}px;image-rendering:pixelated}</style></body>`,
  );
  await blank.screenshot({ path, fullPage: true });
  await blank.close();
  return count;
}
