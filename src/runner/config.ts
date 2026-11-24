// The config file and the folders the runner uses. Read configuration only through this file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { AGENTS, DEFAULT_PORT, type AgentKind, type PermissionMode, type Settings, type Workspace } from "../shared/protocol";
import { runnerFolders } from "./legacy";

/** Only these two: every other SDK mode (the ones that allow calls without the classifier or the person) is refused when the config is read. */
const Mode = z.enum(["auto", "default"]);

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

const Agent = z.enum(AGENTS as [AgentKind, ...AgentKind[]]);

export const DEFAULT_AGENT: AgentKind = "claude";

/**
 * The settings in the config file: what loadConfig reads and PUT /api/settings validates (settings.ts).
 * Keys it doesn't know are dropped by the parse but kept in the file when the runner writes it.
 */
export const SettingsSchema = z.object({
  theme: z.enum(["system", "light", "dark"]).default("system"),
  permissionMode: Mode.default(DEFAULT_PERMISSION_MODE),
  agent: Agent.default(DEFAULT_AGENT),
  workspaces: z.array(z.object({ name: z.string().min(1), path: z.string().min(1), permissionMode: Mode.optional(), agent: Agent.nullish().transform((a) => a ?? undefined) })),
  shell: z
    .object({ hotkey: z.string().min(1), snipHotkey: z.string().min(1), dock: z.boolean(), startOnLogin: z.boolean() })
    .nullable()
    .default(null),
});

/** The settings without the port, as stored in Config and written by the runner. */
export type StoredSettings = Omit<Settings, "port" | "agent"> & { agent: AgentKind };

const ConfigFile = SettingsSchema.extend({
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
});

export interface Config {
  port: number;
  workspaces: Workspace[];
  /** The permission mode sessions ask for: config `permissionMode`, "auto" when left out. */
  permissionMode: PermissionMode;
  /** Workspaces whose own `permissionMode` overrides the top-level one, by name. */
  workspaceModes: Record<string, PermissionMode>;
  /** The agent new sessions run on: config `agent`, "claude" when left out. */
  agent: AgentKind;
  /** Workspaces whose own `agent` overrides the top-level one, by name. */
  workspaceAgents: Record<string, AgentKind>;
  /** The settings as the file has them (paths as written). PUT /api/settings replaces them through applySettings. */
  settings: StoredSettings;
  dataDir: string;
  configPath: string;
  /** HOLM_FAKE_AGENT=1: sessions run against the scripted fake (agent-fake.ts), not Claude Code. */
  fakeAgent: boolean;
  /** HOLM_BUILD_ID: the build id the runner reports and `start` expects, instead of the hash of the code (tests only). */
  buildId: string | null;
}

export const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  // None: the first run, `holm setup` and the Settings window ask for them.
  workspaces: [] as { name: string; path: string }[],
};

/** The permission mode a session in this workspace asks for: the workspace's own, else the top-level one. */
export function permissionModeFor(config: Pick<Config, "permissionMode" | "workspaceModes">, workspace: string): PermissionMode {
  return Object.hasOwn(config.workspaceModes, workspace) ? config.workspaceModes[workspace]! : config.permissionMode;
}

/** The agent a new session in this workspace runs on: the workspace's own, else the top-level one. */
export function agentFor(config: Pick<Config, "agent" | "workspaceAgents">, workspace: string): AgentKind {
  return Object.hasOwn(config.workspaceAgents, workspace) ? config.workspaceAgents[workspace]! : config.agent;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  // The default folder is ~/.config/holm, moved there once from its old name (legacy.ts).
  return resolve(expandHome(env.HOLM_CONFIG ?? join(runnerFolders(env).config, "config.json")));
}

/** The index of the first workspace whose name an earlier one has, or null. */
export function duplicateWorkspace(workspaces: { name: string }[]): number | null {
  const names = new Set<string>();
  for (const [i, w] of workspaces.entries()) {
    if (names.has(w.name)) return i;
    names.add(w.name);
  }
  return null;
}

/**
 * Puts new settings into a running config. The workspaces array is changed in place, since the
 * transcript sync holds it; the next turn of any session asks for the new permission mode.
 */
export function applySettings(
  config: Pick<Config, "workspaces" | "permissionMode" | "workspaceModes" | "agent" | "workspaceAgents" | "settings">,
  settings: StoredSettings,
): void {
  config.settings = settings;
  config.permissionMode = settings.permissionMode;
  config.workspaceModes = Object.fromEntries(settings.workspaces.flatMap((w) => (w.permissionMode ? [[w.name, w.permissionMode]] : [])));
  config.agent = settings.agent;
  config.workspaceAgents = Object.fromEntries(settings.workspaces.flatMap((w) => (w.agent ? [[w.name, w.agent]] : [])));
  config.workspaces.splice(
    0,
    config.workspaces.length,
    ...settings.workspaces.map((w) => {
      const p = resolve(expandHome(w.path));
      return { name: w.name, path: p, exists: existsSync(p) };
    }),
  );
}

/** Reads the config file, writing the default one first if there is none. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const path = configPath(env);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  const twice = duplicateWorkspace(parsed.data.workspaces);
  if (twice !== null) throw new Error(`${path}: workspace "${parsed.data.workspaces[twice]!.name}" is listed twice`);
  // The default folder is ~/.local/share/holm, moved there once from its old name (legacy.ts).
  const dataDir = resolve(expandHome(env.HOLM_DATA_DIR ?? runnerFolders(env).data));
  mkdirSync(dataDir, { recursive: true });
  const { port, ...settings } = parsed.data;
  const config: Config = {
    port: env.HOLM_PORT !== undefined ? Number(env.HOLM_PORT) : port,
    workspaces: [],
    permissionMode: settings.permissionMode,
    workspaceModes: {},
    agent: settings.agent,
    workspaceAgents: {},
    settings,
    dataDir,
    configPath: path,
    fakeAgent: env.HOLM_FAKE_AGENT === "1",
    buildId: env.HOLM_BUILD_ID || null,
  };
  applySettings(config, settings);
  return config;
}
