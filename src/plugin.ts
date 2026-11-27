// The plugin API: what a plugin file (plugins/<id>/plugin.ts) exports. A plugin is a tab in the
// notch's open dock, with an optional hotkey: a view worked out when the tab opens (a calendar's day),
// a search (a CRM's people), or both. It gives back plain data, sections of rows, and the dock draws
// them: no HTML or CSS per plugin. How to write one: docs/plugins.md. Why it is built so: D0057.
import type { PluginIcon, PluginRow, PluginSection, PluginView } from "./shared/protocol";

export type { PluginIcon, PluginRow, PluginSection, PluginView };

/** What the runner hands a plugin's view() and search(). */
export interface PluginContext {
  /** The plugin's id: its folder's name. */
  id: string;
  /** The plugin's own options, from the config file's `plugins.<id>.options` ({} when none). */
  options: Record<string, unknown>;
  /** A folder of the plugin's own, under the runner's data folder, for files it keeps. */
  dataDir: string;
  /** Ends when the person has moved on (a newer search, the runner stopping): pass it to fetch(). */
  signal: AbortSignal;
  /**
   * Calls one MCP tool, such as a claude.ai connector's (`mcp__claude_ai_Google_Calendar__list_events`),
   * with exactly these arguments, and gives back its result: parsed JSON when the result is JSON,
   * else its text. The tool must be in the plugin's `tools`. It runs through Claude Code with the
   * person's login and connectors, and nothing but that one tool can run (D0057). Takes some seconds.
   */
  tool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /**
   * Asks Claude, allowed only the plugin's `tools` (or the ones given), for an answer of the JSON
   * schema's shape. For what a single tool call can't do: several calls, sorting, summing up.
   * Slower than tool(): tens of seconds on a large model.
   */
  ask<T = unknown>(prompt: string, schema: Record<string, unknown>, options?: { tools?: string[]; model?: string }): Promise<T>;
  /** Writes a line to the runner's log, with the plugin's id. */
  log(...parts: unknown[]): void;
}

export interface PluginSearch {
  /** The find field's placeholder. Default: "Search <title>". */
  placeholder?: string;
  /**
   * Search as the person types, a moment after they stop: only for a cheap search (a fetch of an
   * API). Off by default: a search that calls a tool runs when the person presses Enter.
   */
  live?: boolean;
  run(query: string, ctx: PluginContext): Promise<PluginView>;
}

export interface PluginDefinition {
  /** The tab's name. */
  title: string;
  /** The tab's glyph. Default: "list". */
  icon?: PluginIcon;
  /**
   * An Electron accelerator ("CommandOrControl+Alt+C") that opens the dock on this tab, and puts it
   * away when pressed again. The config's `plugins.<id>.hotkey` replaces it (null: none).
   */
  hotkey?: string;
  /** The MCP tools ctx.tool() and ctx.ask() may call, by full name. Nothing else runs for the plugin. */
  tools?: string[];
  /** Whether the plugin is on before the config says either way. Default: true for the person's own, false for the built-in ones. */
  enabled?: boolean;
  /** How long a view is shown before opening the tab works it out again. Default: five minutes. */
  refreshMs?: number;
  /** The tab's content when it opens (and while the find field is empty). */
  view?(ctx: PluginContext): Promise<PluginView>;
  search?: PluginSearch;
}

/** Marks a plugin's definition, for the types: `export default definePlugin({ ... })`. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
