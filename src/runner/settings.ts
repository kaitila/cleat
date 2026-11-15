// PUT /api/settings: validate a whole Settings and write it to the config file (docs/protocol.md, "Settings").
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Settings } from "../shared/protocol";
import { SettingsSchema, duplicateWorkspace, expandHome, type StoredSettings } from "./config";

/** Why a settings body is refused: the first bad field as a dotted path, and the reason. */
export interface SettingsRefusal {
  field: string;
  error: string;
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The settings a PUT body asks for, or why it is refused. The body is checked with the schema
 * loadConfig reads the file with; a `port` in it is ignored. A workspace path must be absolute
 * (~/ counts) and an existing folder, unless the current settings already have that path: a folder
 * that went missing must not block every other change.
 */
export function validateSettings(body: unknown, current: StoredSettings): StoredSettings | SettingsRefusal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { field: "", error: "the body must be a JSON object" };
  const { port: _port, ...rest } = body as Record<string, unknown>;
  const parsed = SettingsSchema.safeParse(rest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { field: issue.path.join("."), error: issue.message };
  }
  const settings = parsed.data;
  const twice = duplicateWorkspace(settings.workspaces);
  if (twice !== null) return { field: `workspaces.${twice}.name`, error: `workspace "${settings.workspaces[twice]!.name}" is listed twice` };
  const known = new Set(current.workspaces.map((w) => w.path));
  for (const [i, w] of settings.workspaces.entries()) {
    if (known.has(w.path)) continue;
    const path = expandHome(w.path);
    if (!isAbsolute(path)) return { field: `workspaces.${i}.path`, error: "the path must be absolute" };
    if (!isFolder(path)) return { field: `workspaces.${i}.path`, error: `no folder at ${w.path}` };
  }
  return settings;
}

/**
 * Writes the settings into the config file, atomically (a temp file renamed over it). Keys the
 * runner doesn't know are kept, at the top and on a workspace of the same name; `port` is left as it is.
 */
export function writeSettings(path: string, settings: StoredSettings): void {
  let raw: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) raw = value as Record<string, unknown>;
  } catch {
    // A missing or broken file is replaced by the settings alone.
  }
  const before = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw.workspaces)) {
    for (const w of raw.workspaces) {
      if (typeof w === "object" && w !== null && typeof w.name === "string") before.set(w.name, w as Record<string, unknown>);
    }
  }
  const workspaces = settings.workspaces.map((w) => {
    const { name: _n, path: _p, permissionMode: _m, ...unknown } = before.get(w.name) ?? {};
    return { name: w.name, path: w.path, ...(w.permissionMode ? { permissionMode: w.permissionMode } : {}), ...unknown };
  });
  const file = { ...raw, theme: settings.theme, permissionMode: settings.permissionMode, workspaces, shell: settings.shell };
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(file, null, 2) + "\n");
  renameSync(temp, path);
}

/** The Settings GET /api/settings answers and the 'settings' message carries. */
export function settingsOf(stored: StoredSettings, port: number): Settings {
  return { ...stored, port };
}
