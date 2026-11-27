// The plugins' hotkeys (D0057): each plugin that is on may have an Electron accelerator that opens
// the dock on its tab. The shell reads them from GET /api/plugins when its socket opens and from each
// 'plugins' message, and registers them beside its own three. Pure, so the tests can reach it.

export const PLUGINS_PATH = "/api/plugins";

/** A plugin's hotkey: which plugin, and its accelerator. */
export interface PluginKey {
  id: string;
  hotkey: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The hotkeys in a plugin list (GET /api/plugins's `plugins`): the plugins that are on, have no error
 * and have a hotkey. An accelerator is taken once, by the first plugin that asks for it, and never
 * one of `taken` (the shell's own hotkeys).
 */
export function pluginKeys(plugins: unknown, taken: string[] = []): PluginKey[] {
  if (!Array.isArray(plugins)) return [];
  const seen = new Set(taken.map((k) => k.toLowerCase()));
  const keys: PluginKey[] = [];
  for (const p of plugins) {
    if (!isObject(p) || typeof p.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(p.id)) continue;
    if (p.enabled !== true || p.error || typeof p.hotkey !== "string" || !p.hotkey.trim()) continue;
    const hotkey = p.hotkey.trim();
    if (seen.has(hotkey.toLowerCase())) continue;
    seen.add(hotkey.toLowerCase());
    keys.push({ id: p.id, hotkey });
  }
  return keys;
}

/** The plugin list in a message on /ws, or null for every other message. */
export function pluginsMessage(data: unknown): unknown[] | null {
  if (typeof data !== "string" || !data.includes('"plugins"')) return null;
  try {
    const m: unknown = JSON.parse(data);
    return isObject(m) && m.type === "plugins" && Array.isArray(m.plugins) ? m.plugins : null;
  } catch {
    return null;
  }
}
