// The app's own commands: `bun src/cli.ts <command>`.
import { install, start, stop } from "./shell/install";

const USAGE = `usage: bun src/cli.ts <command>

  shell install   bundle the Windows shell and install it, with Electron, under the Windows user's AppData\\Local\\intuition
  shell start     start the Windows shell (tray icon and hotkey)
  shell stop      quit the Windows shell
  shell selftest  install the shell and run its self-test against a stub runner`;

const commands: Record<string, () => Promise<void> | void> = {
  "shell install": () => install(),
  "shell start": () => {
    start();
    console.log("the shell is starting: look for its icon in the tray");
  },
  "shell stop": async () => {
    await stop();
    console.log("the shell was asked to quit");
  },
  "shell selftest": async () => {
    process.exitCode = await (await import("./shell/selftest-run")).selfTestRun();
  },
};

const command = commands[process.argv.slice(2).join(" ")];
if (!command) {
  console.error(USAGE);
  process.exit(process.argv.length > 2 ? 1 : 0);
}
try {
  await command();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
