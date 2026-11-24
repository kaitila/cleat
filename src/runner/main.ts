import { adoptLegacyEnv } from "../shared/legacy";
import { loadConfig } from "./config";
import { startServer } from "./server";

// The environment variables' names from before the renames, for one release (D0043, D0048, shared/legacy.ts).
adoptLegacyEnv();
const config = loadConfig();
const runner = startServer(config);
console.log(`cleat runner on ${runner.url}`);
console.log(`config: ${config.configPath}`);
for (const w of config.workspaces) console.log(`workspace ${w.name}: ${w.path}${w.exists ? "" : " (missing)"}`);
