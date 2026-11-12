// The config file and the folders the runner uses. Read configuration only through this file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_PORT, type Workspace } from "../shared/protocol";

const ConfigFile = z.object({
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  workspaces: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })).min(1),
});

export interface Config {
  port: number;
  workspaces: Workspace[];
  dataDir: string;
  configPath: string;
}

export const DEFAULT_CONFIG = {
  port: DEFAULT_PORT,
  workspaces: [
    { name: "agents", path: "/root/agents" },
    { name: "theta", path: "~/.projects/theta" },
  ],
};

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
    dataDir,
    configPath: path,
  };
}
