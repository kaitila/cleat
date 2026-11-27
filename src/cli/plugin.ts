// `cleat plugin new <name>`: a working plugin to start from, in plugins/<name>/plugin.ts beside the
// config file (D0057, docs/plugins.md). It searches Hacker News as the person types (a plain fetch,
// no connector), and shows in comments how a view calls a connector's tool.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath, PLUGIN_ID } from "../runner/config";
import { PLUGIN_FILE } from "../runner/plugins";

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
