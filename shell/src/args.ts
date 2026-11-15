// The shell's command line. No Electron imports here.
import { parseLogin } from "./login";

export interface Args {
  /** --self-test <result file>: run the self-test, write its JSON there, quit. */
  selfTest?: string;
  /** --runner-url <url>: use this runner instead of the one in the settings (the self-test's stub). */
  runnerUrl?: string;
  /** --session <id>: open the chat view on this session. */
  session?: string;
  /** --prompt: open the pop-up (setup ends with it). */
  prompt: boolean;
  /** --quit: ask the running shell to quit. */
  quit: boolean;
  /** --login on|off|status: set or read start on login, write the outcome to --login-result, quit. */
  login?: "on" | "off" | "status";
  /** --login-result <file>: where --login writes its JSON (a LoginResult). */
  loginResult?: string;
}

export function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const v = argv[argv.indexOf(flag) + 1];
    return argv.includes(flag) && v !== undefined && !v.startsWith("--") ? v : undefined;
  };
  return { selfTest: value("--self-test"), runnerUrl: value("--runner-url"), session: value("--session"), prompt: argv.includes("--prompt"), quit: argv.includes("--quit"), login: parseLogin(value("--login")), loginResult: value("--login-result") };
}
