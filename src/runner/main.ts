import { adoptLegacyEnv } from "../shared/legacy";
import { loadConfig } from "./config";
import { startServer } from "./server";

// The environment variables' names from before the rename, for one release (D0043, shared/legacy.ts).
adoptLegacyEnv();
const config = loadConfig();
const runner = startServer(config);
console.log(`holm runner on ${runner.url}`);
console.log(`config: ${config.configPath}`);
for (const w of config.workspaces) console.log(`workspace ${w.name}: ${w.path}${w.exists ? "" : " (missing)"}`);
