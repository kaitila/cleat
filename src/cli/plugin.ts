// `cleat plugin new <name>`: a working plugin to start from, in plugins/<name>/plugin.ts beside the
// config file (D0057, docs/plugins.md). It searches Hacker News as the person types (a plain fetch,
// no connector), and shows in comments how a view calls a connector's tool.
// `cleat plugin login <id>`: runs a plugin's login() in the terminal (D0059), such as Calendar's
// Google sign-in.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginLoginContext } from "../plugin";
import { configPath, loadConfig, PLUGIN_ID } from "../runner/config";
import { BUILT_IN_DIR, definitionOf, PLUGIN_FILE } from "../runner/plugins";
import { detectLayout, type Layout } from "../shell/platform";

/** The program that opens a link in the person's browser, per layout (an argument array, no shell). */
export function openCommand(url: string, layout: Layout): string[] {
  if (layout === "macos") return ["open", url];
  // From WSL the browser is Windows': explorer.exe takes a URL as is (cmd's start would split it at &).
  if (layout === "windows-wsl") return ["explorer.exe", url];
  return ["xdg-open", url];
}

/** A plugin's file by id: the person's own first (it replaces a built-in one), else the built-in one. */
export function pluginFile(id: string, userDir: string, builtInDir = BUILT_IN_DIR): string | null {
  for (const dir of [userDir, builtInDir]) {
    const file = join(dir, id, PLUGIN_FILE);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Runs plugin `id`'s login(): the plugin's options from the config, its data folder as the runner
 * gives it, the browser and the terminal for the person. Gives back its line, or why it could not.
 */
export async function loginPlugin(
  id: string,
  io: Pick<PluginLoginContext, "openUrl" | "input" | "log">,
  env: Record<string, string | undefined> = process.env,
  builtInDir = BUILT_IN_DIR,
): Promise<{ done: string } | { error: string }> {
  if (!PLUGIN_ID.test(id)) return { error: `no plugin is called "${id}"` };
  const config = loadConfig(env);
  const file = pluginFile(id, config.pluginsDir, builtInDir);
  if (!file) return { error: `no plugin is called "${id}" (looked in ${config.pluginsDir} and the built-in ones)` };
  const definition = definitionOf(await import(file));
  if ("error" in definition) return { error: `${file}: ${definition.error}` };
  if (!definition.login) return { error: `the ${id} plugin has no sign-in: it needs no login` };
  const dataDir = join(config.dataDir, "plugins", id);
  mkdirSync(dataDir, { recursive: true });
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt);
  try {
    const done = await definition.login({ id, options: config.plugins[id]?.options ?? {}, dataDir, signal: stop.signal, ...io });
    return { done };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    process.off("SIGINT", interrupt);
  }
}

/** Opens a link in the browser for this machine's layout; the link is printed too, for when no browser opens. */
export async function openUrl(url: string, log: (line: string) => void): Promise<void> {
  log(`Opening your browser. If it doesn't open, go to:\n  ${url}`);
  try {
    const p = Bun.spawn(openCommand(url, detectLayout()), { stdout: "ignore", stderr: "ignore" });
    await p.exited;
  } catch {
    // No opener here: the printed link is the way.
  }
}

/** The plugin API's file in this install: the template imports its types from there. */
export const PLUGIN_API = join(import.meta.dir, "..", "plugin.ts");

/** A name as a plugin's title: "hacker-news" is "Hacker news". */
export function titleOf(id: string): string {
  const words = id.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The new plugin's file. Its import is of types only, erased when bun runs it, so it works even if this install moves. */
export function template(id: string, api = PLUGIN_API): string {
  return `// ${titleOf(id)}: a tab in Cleat's dock. How plugins work: docs/plugins.md in Cleat's repo.
// Save this file, then Settings → Plugins → Reload plugins (or \`cleat restart\`).
import type { PluginDefinition } from ${JSON.stringify(api.replace(/\.ts$/, ""))};

interface Hit {
  objectID: string;
  title?: string | null;
  url?: string | null;
  author?: string;
  points?: number | null;
  num_comments?: number | null;
}

export default {
  title: ${JSON.stringify(titleOf(id))},
  icon: "search",
  // An Electron accelerator that opens the dock on this tab (change it in Settings).
  // hotkey: "CommandOrControl+Alt+H",

  // MCP tools this plugin may call with ctx.tool() or ctx.ask(), by full name. Nothing else runs for it.
  // tools: ["mcp__claude_ai_Google_Calendar__list_events"],

  // What the tab shows when it opens (kept for refreshMs, five minutes by default). With a connector:
  //   async view(ctx) {
  //     const answer = await ctx.tool<{ events?: { summary?: string }[] }>("mcp__claude_ai_Google_Calendar__list_events", { pageSize: 10 });
  //     return { sections: [{ title: "Next", rows: (answer.events ?? []).map((e) => ({ title: e.summary ?? "(no title)" })) }] };
  //   },

  search: {
    placeholder: "Search Hacker News",
    // A cheap search (a plain fetch) can run as the person types; one that calls a tool waits for Enter.
    live: true,
    async run(query, ctx) {
      if (!query) return { sections: [], note: "Type to search Hacker News." };
      const res = await fetch(\`https://hn.algolia.com/api/v1/search?hitsPerPage=15&query=\${encodeURIComponent(query)}\`, { signal: ctx.signal });
      if (!res.ok) throw new Error(\`Hacker News answered \${res.status}\`);
      const { hits = [] } = (await res.json()) as { hits?: Hit[] };
      return {
        sections: [
          {
            rows: hits
              .filter((h) => h.title)
              .map((h) => ({
                title: h.title!,
                detail: \`\${h.points ?? 0} points · \${h.num_comments ?? 0} comments · \${h.author ?? ""}\`,
                url: h.url || \`https://news.ycombinator.com/item?id=\${h.objectID}\`,
                task: \`Read \${h.url || \`https://news.ycombinator.com/item?id=\${h.objectID}\`} and tell me what matters in it.\`,
              })),
            empty: "Nothing found.",
          },
        ],
      };
    },
  },
} satisfies PluginDefinition;
`;
}

/** Writes plugins/<id>/plugin.ts beside the config file. Refuses a bad name or one that is taken. */
export function newPlugin(id: string, env: Record<string, string | undefined> = process.env): { file: string } | { error: string } {
  if (!PLUGIN_ID.test(id)) return { error: `a plugin's name is lowercase letters, digits and dashes, such as hacker-news: not "${id}"` };
  const dir = join(dirname(configPath(env)), "plugins", id);
  const file = join(dir, PLUGIN_FILE);
  if (existsSync(file)) return { error: `${file} is there already` };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, template(id));
  return { file };
}
