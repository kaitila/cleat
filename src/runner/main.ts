import { loadConfig } from "./config";
import { startServer } from "./server";

const config = loadConfig();
const runner = startServer(config);
console.log(`intuition runner on ${runner.url}`);
console.log(`config: ${config.configPath}`);
for (const w of config.workspaces) console.log(`workspace ${w.name}: ${w.path}${w.exists ? "" : " (missing)"}`);
