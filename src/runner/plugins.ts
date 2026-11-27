// The plugins (D0057, docs/plugins.md): plugins/<id>/plugin.ts in the repo (built in) and beside the
// config file (the person's own), each a tab in the notch. This file finds and loads them, checks what
// they define and what they give back, keeps each one's last view (on disk too, so a tab shows at once
// after a restart), and runs their searches. A plugin is code the person chose to run: it runs in the
// runner's process, but whatever it throws or returns stays its own problem, never the runner's.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { PluginContext, PluginDefinition } from "../plugin";
import { PLUGIN_ICONS, type PluginInfo, type PluginView, type PluginViewResponse, type ServerMessage } from "../shared/protocol";
import { PLUGIN_ID, type PluginSettings } from "./config";
import { MCP_TOOL, type PluginAgent } from "./plugin-agent";

/** The built-in plugins: the repo's plugins/ folder. */
export const BUILT_IN_DIR = join(import.meta.dir, "..", "..", "plugins");
/** The file a plugin's folder holds. */
export const PLUGIN_FILE = "plugin.ts";
export const DEFAULT_REFRESH_MS = 5 * 60_000;
/** A view() or a search that takes longer is given up. */
export const PLUGIN_TIMEOUT_MS = 90_000;
/** What a view may hold: more is cut off. */
export const MAX_SECTIONS = 20;
export const MAX_ROWS = 200;
export const MAX_TEXT = 500;
export const MAX_TASK = 8000;
export const MAX_QUERY = 500;

const Definition = z.object({
  title: z.string().trim().min(1).max(40),
  icon: z.enum(PLUGIN_ICONS).optional(),
  hotkey: z.string().min(1).max(80).optional(),
  tools: z.array(z.string().regex(MCP_TOOL, "a tool is an MCP tool's full name, mcp__<server>__<tool>")).max(50).optional(),
  enabled: z.boolean().optional(),
  refreshMs: z.number().int().min(1000).optional(),
  view: z.custom<NonNullable<PluginDefinition["view"]>>((v) => typeof v === "function", "view must be a function").optional(),
  search: z
    .object({
      placeholder: z.string().max(80).optional(),
      live: z.boolean().optional(),
      run: z.custom<NonNullable<PluginDefinition["search"]>["run"]>((v) => typeof v === "function", "search.run must be a function"),
    })
    .optional(),
});

const text = (max = MAX_TEXT) => z.string().transform((s) => (s.length > max ? s.slice(0, max - 1) + "…" : s));
/** A link the dock may open: http or https only; anything else is dropped. */
const link = z.string().transform((s) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
});
const Row = z.object({
  title: text(),
  detail: text().optional(),
  meta: text(60).optional(),
  tone: z.enum(["accent", "muted", "error"]).optional(),
  url: link.optional(),
  task: text(MAX_TASK).optional(),
});
const View = z.object({
  sections: z
    .array(z.object({ title: text(80).optional(), rows: z.array(Row).transform((r) => r.slice(0, MAX_ROWS)), empty: text().optional() }))
    .transform((s) => s.slice(0, MAX_SECTIONS)),
  note: text().optional(),
});

/** A plugin's view as the pages get it: checked, cut to size, and with only http(s) links; or why it is not one. */
export function cleanView(value: unknown): PluginView | { error: string } {
  const parsed = View.safeParse(value);
  if (!parsed.success) return { error: `the plugin gave back something that is not a view: ${z.prettifyError(parsed.error)}` };
  const view: PluginView = {
    sections: parsed.data.sections.map((s) => ({
      ...(s.title ? { title: s.title } : {}),
      rows: s.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v !== "")) as unknown as PluginView["sections"][number]["rows"][number]),
      ...(s.empty ? { empty: s.empty } : {}),
    })),
    ...(parsed.data.note ? { note: parsed.data.note } : {}),
  };
  return view;
}

/** A plugin's definition from its module's default export, or why it is not one. */
export function definitionOf(module: unknown): PluginDefinition | { error: string } {
  const value = (module as { default?: unknown } | null)?.default;
  if (value === undefined) return { error: `${PLUGIN_FILE} has no default export` };
  const parsed = Definition.safeParse(value);
  if (!parsed.success) return { error: z.prettifyError(parsed.error) };
  if (!parsed.data.view && !parsed.data.search) return { error: "a plugin needs a view(), a search, or both" };
  return parsed.data as PluginDefinition;
}

interface Loaded {
  id: string;
  dir: string;
  builtIn: boolean;
  definition: PluginDefinition | null;
  error: string | null;
}

interface Cached {
  view: PluginView | null;
  at: string | null;
  error: string | null;
  running: Promise<void> | null;
}

export interface PluginsOptions {
  builtInDir: string;
  userDir: string;
  /** The config's `plugins`, as it is now. */
  settings: () => PluginSettings;
  dataDir: string;
  agent: PluginAgent;
  send: (message: ServerMessage) => void;
  log?: (...parts: unknown[]) => void;
}

/** The plugin folders in `dir`: each folder with a plugin.ts and an id-shaped name. */
function folders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && PLUGIN_ID.test(d.name) && existsSync(join(dir, d.name, PLUGIN_FILE)))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Plugins {
  private loaded = new Map<string, Loaded>();
  private cache = new Map<string, Cached>();
  /** Each plugin's search under way, aborted by a newer one. */
  private searches = new Map<string, AbortController>();
  private stopping = new AbortController();
  private loads = 0;

  constructor(private readonly options: PluginsOptions) {}

  /** Finds and imports every plugin, again on each call (a changed file is imported afresh), and sends the new list. */
  async load(): Promise<void> {
    const load = ++this.loads;
    const found = new Map<string, Loaded>();
    const dirs: [string, boolean][] = [
      [this.options.builtInDir, true],
      [this.options.userDir, false],
    ];
    for (const [dir, builtIn] of dirs) {
      for (const id of folders(dir)) {
        // The person's own plugin of a built-in one's id takes its place.
        const file = join(dir, id, PLUGIN_FILE);
        let definition: PluginDefinition | null = null;
        let error: string | null = null;
        try {
          // The file's time in the address: Bun keeps a module once imported, and a changed one must load anew.
          const module: unknown = await import(`${pathToFileURL(file).href}?t=${statSync(file).mtimeMs}`);
          const d = definitionOf(module);
          if ("error" in d) error = d.error;
          else definition = d;
        } catch (e) {
          error = `${PLUGIN_FILE} could not be loaded: ${message(e)}`;
        }
        found.set(id, { id, dir: join(dir, id), builtIn, definition, error });
      }
    }
    if (load !== this.loads) return;
    this.loaded = found;
    for (const id of this.cache.keys()) if (!found.has(id)) this.cache.delete(id);
    this.changed();
  }

  /** Sends the list again (after a load, or a plugin's settings changed). */
  changed(): void {
    this.options.send({ type: "plugins", plugins: this.list() });
  }

  list(): PluginInfo[] {
    const settings = this.options.settings();
    return [...this.loaded.values()]
      .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.id.localeCompare(b.id))
      .map((p) => {
        const d = p.definition;
        const s = settings[p.id] ?? {};
        return {
          id: p.id,
          title: d?.title ?? p.id,
          icon: d?.icon ?? "list",
          builtIn: p.builtIn,
          enabled: p.error === null && (s.enabled ?? d?.enabled ?? !p.builtIn),
          hotkey: s.hotkey !== undefined ? s.hotkey : (d?.hotkey ?? null),
          view: Boolean(d?.view),
          search: Boolean(d?.search),
          placeholder: d?.search ? (d.search.placeholder ?? `Search ${d.title}`) : null,
          live: d?.search?.live === true,
          tools: d?.tools ?? [],
          error: p.error,
        } satisfies PluginInfo;
      });
  }

  has(id: string): boolean {
    return this.loaded.has(id);
  }

  /** The plugin, when it is loaded, has no error and is on. */
  private usable(id: string): { loaded: Loaded; definition: PluginDefinition } | null {
    const loaded = this.loaded.get(id);
    const info = this.list().find((p) => p.id === id);
    if (!loaded?.definition || !info?.enabled) return null;
    return { loaded, definition: loaded.definition };
  }

  private folder(id: string): string {
    const dir = join(this.options.dataDir, "plugins", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private context(id: string, definition: PluginDefinition, signal: AbortSignal): PluginContext {
    const allowed = definition.tools ?? [];
    const dataDir = this.folder(id);
    const log = this.options.log ?? console.log;
    return {
      id,
      options: this.options.settings()[id]?.options ?? {},
      dataDir,
      signal,
      tool: async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
        if (!allowed.includes(name)) throw new Error(`${name} is not in the plugin's tools`);
        const result = await this.options.agent.tool({ tool: name, args, cwd: dataDir, signal });
        try {
          return JSON.parse(result) as T;
        } catch {
          return result as T;
        }
      },
      ask: async <T>(prompt: string, schema: Record<string, unknown>, opts: { tools?: string[]; model?: string } = {}): Promise<T> => {
        const tools = opts.tools ?? allowed;
        const stray = tools.find((t) => !allowed.includes(t));
        if (stray) throw new Error(`${stray} is not in the plugin's tools`);
        return (await this.options.agent.ask({ prompt, schema, tools, cwd: dataDir, signal, ...(opts.model ? { model: opts.model } : {}) })) as T;
      },
      log: (...parts: unknown[]) => log(`plugin ${id}:`, ...parts),
    };
  }

  private cached(id: string): Cached {
    let c = this.cache.get(id);
    if (!c) {
      c = { view: null, at: null, error: null, running: null };
      // The last view from before a restart, so the tab shows something at once.
      try {
        const saved = JSON.parse(readFileSync(join(this.options.dataDir, "plugins", id, "view.json"), "utf8")) as { view?: unknown; at?: unknown };
        const view = cleanView(saved.view);
        if (!("error" in view) && typeof saved.at === "string") {
          c.view = view;
          c.at = saved.at;
        }
      } catch {
        // None kept.
      }
      this.cache.set(id, c);
    }
    return c;
  }

  private answer(c: Cached): PluginViewResponse {
    return { view: c.view, at: c.at, loading: c.running !== null, error: c.error };
  }

  /**
   * GET /api/plugins/:id/view: the last view at once, and a new one worked out in the background when
   * there is none yet, it is older than the plugin's refreshMs, or `fresh` asks; a 'plugin_view'
   * message carries it when it is done. Null for a plugin that is not loaded, on, or has no view.
   */
  view(id: string, fresh = false, now = Date.now()): PluginViewResponse | null {
    const p = this.usable(id);
    if (!p?.definition.view) return null;
    const c = this.cached(id);
    const stale = c.at === null || now - Date.parse(c.at) >= (p.definition.refreshMs ?? DEFAULT_REFRESH_MS);
    if ((fresh || stale || c.error !== null) && !c.running) c.running = this.refresh(id, p.definition, c);
    return this.answer(c);
  }

  /** Waits for the view being worked out now, if any (tests). */
  async settled(id: string): Promise<void> {
    await this.cache.get(id)?.running;
  }

  private async refresh(id: string, definition: PluginDefinition, c: Cached): Promise<void> {
    // Let the answer that started this go out first, saying it loads.
    await Promise.resolve();
    try {
      const value = await withTimeout(definition.view!(this.context(id, definition, this.stopping.signal)), PLUGIN_TIMEOUT_MS, "the view");
      const view = cleanView(value);
      if ("error" in view) throw new Error(view.error);
      c.view = view;
      c.at = new Date().toISOString();
      c.error = null;
      try {
        writeFileSync(join(this.folder(id), "view.json"), JSON.stringify({ view, at: c.at }));
      } catch {
        // Kept in memory all the same.
      }
    } catch (e) {
      c.error = message(e);
      (this.options.log ?? console.error)(`plugin ${id}: view failed: ${c.error}`);
    } finally {
      c.running = null;
      if (this.cache.get(id) === c) this.options.send({ type: "plugin_view", plugin: id, view: this.answer(c) });
    }
  }

  /**
   * POST /api/plugins/:id/search: the plugin's search for `query`. A newer search of the same plugin
   * aborts this one (its signal), which then answers "stopped". Null for a plugin without a search.
   */
  async search(id: string, query: string): Promise<PluginView | null> {
    const p = this.usable(id);
    if (!p?.definition.search) return null;
    this.searches.get(id)?.abort();
    const controller = new AbortController();
    this.searches.set(id, controller);
    const signal = AbortSignal.any([controller.signal, this.stopping.signal]);
    try {
      const value = await withTimeout(p.definition.search.run(query, this.context(id, p.definition, signal)), PLUGIN_TIMEOUT_MS, "the search");
      if (signal.aborted) throw new Error("stopped");
      const view = cleanView(value);
      if ("error" in view) throw new Error(view.error);
      return view;
    } finally {
      if (this.searches.get(id) === controller) this.searches.delete(id);
    }
  }

  stop(): void {
    this.stopping.abort();
  }
}
