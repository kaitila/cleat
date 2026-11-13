// The config file and the folders the runner uses. Read configuration only through this file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_PORT, type PermissionMode, type Workspace } from "../shared/protocol";

/** Only these two: every other SDK mode (the ones that allow calls without the classifier or the person) is refused when the config is read. */
const Mode = z.enum(["auto", "default"]);

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

const ConfigFile = z.object({
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  permissionMode: Mode.default(DEFAULT_PERMISSION_MODE),
  workspaces: z.array(z.object({ name: z.string().min(1), path: z.string().min(1), permissionMode: Mode.optional() })).min(1),
});

export interface Config {
  port: number;
  workspaces: Workspace[];
  /** The permission mode sessions ask for: config `permissionMode`, "auto" when left out. */
  permissionMode: PermissionMode;
  /** Workspaces whose own `permissionMode` overrides the top-level one, by name. */
  workspaceModes: Record<string, PermissionMode>;
  dataDir: string;
  configPath: string;
  /** INTUITION_FAKE_AGENT=1: sessions run against the scripted fake (agent-fake.ts), not Claude Code. */
  fakeAgent: boolean;
  /** INTUITION_BUILD_ID: the build id the runner reports and `start` expects, instead of the hash of the code (tests only). */
  buildId: string | null;
}

export const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  workspaces: [
    { name: "agents", path: "/root/agents" },
    { name: "theta", path: "~/.projects/theta" },
  ],
};

/** The permission mode a session in this workspace asks for: the workspace's own, else the top-level one. */
export function permissionModeFor(config: Pick<Config, "permissionMode" | "workspaceModes">, workspace: string): PermissionMode {
  return Object.hasOwn(config.workspaceModes, workspace) ? config.workspaceModes[workspace]! : config.permissionMode;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return resolve(expandHome(env.INTUITION_CONFIG ?? "~/.config/intuition/config.json"));
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
  const names = new Set<string>();
  for (const w of parsed.data.workspaces) {
    if (names.has(w.name)) throw new Error(`${path}: workspace "${w.name}" is listed twice`);
    names.add(w.name);
  }
  const dataDir = resolve(expandHome(env.INTUITION_DATA_DIR ?? "~/.local/share/intuition"));
  mkdirSync(dataDir, { recursive: true });
  return {
    port: env.INTUITION_PORT !== undefined ? Number(env.INTUITION_PORT) : parsed.data.port,
    workspaces: parsed.data.workspaces.map((w) => {
      const p = resolve(expandHome(w.path));
      return { name: w.name, path: p, exists: existsSync(p) };
    }),
    permissionMode: parsed.data.permissionMode,
    workspaceModes: Object.fromEntries(parsed.data.workspaces.flatMap((w) => (w.permissionMode ? [[w.name, w.permissionMode]] : []))),
    dataDir,
    configPath: path,
    fakeAgent: env.INTUITION_FAKE_AGENT === "1",
    buildId: env.INTUITION_BUILD_ID || null,
  };
}
