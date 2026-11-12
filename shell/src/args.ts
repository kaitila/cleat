// The shell's command line. No Electron imports here.

export interface Args {
  /** --self-test <result file>: run the self-test, write its JSON there, quit. */
  selfTest?: string;
  /** --runner-url <url>: use this runner instead of the one in the settings (the self-test's stub). */
  runnerUrl?: string;
  /** --session <id>: open the chat view on this session. */
  session?: string;
  /** --quit: ask the running shell to quit. */
  quit: boolean;
}

export function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const v = argv[argv.indexOf(flag) + 1];
    return argv.includes(flag) && v !== undefined && !v.startsWith("--") ? v : undefined;
  };
  return { selfTest: value("--self-test"), runnerUrl: value("--runner-url"), session: value("--session"), quit: argv.includes("--quit") };
}
