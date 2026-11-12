// The wsl.exe command line that starts the runner from Windows. No Electron imports here.
// The values come from a settings file anyone can edit, so they are checked, and the command is an
// array of arguments handed to wsl.exe --exec: no shell, on either side, ever reads them as code.

/** Where the runner lives in WSL. Written into the shell's settings by `bun src/cli.ts shell install`. */
export interface WslSettings {
  /** The distribution's name, from WSL_DISTRO_NAME. */
  distro: string;
  /** The repo's folder, as a WSL path. */
  repo: string;
  /** bun's executable, as a WSL path. */
  bun: string;
}

/** A distribution name: letters, digits, dot, dash, underscore. It cannot start with a dash, so it is never read as an option. */
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An absolute WSL path without control characters. It starts with a slash, so it is never read as an option. */
function absolute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length < 4096 && !/[\u0000-\u001f]/.test(value);
}

/** The `wsl` object of the settings, or undefined unless all three values are usable. */
export function parseWsl(value: unknown): WslSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { distro, repo, bun } = value as Record<string, unknown>;
  if (typeof distro !== "string" || !DISTRO.test(distro) || !absolute(repo) || !absolute(bun)) return undefined;
  return { distro, repo, bun };
}

/**
 * `wsl.exe -d <distro> --exec <bun> <repo>/src/cli.ts start --login-env`.
 * --exec runs bun directly, without the distribution's shell. --login-env makes `start` take the
 * person's environment (PATH and the rest) from their login shell, which a start from Windows lacks.
 */
export function runnerCommand(wsl: WslSettings, systemRoot = "C:\\Windows"): { file: string; args: string[] } {
  return {
    file: `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\wsl.exe`,
    args: ["-d", wsl.distro, "--exec", wsl.bun, `${wsl.repo.replace(/\/+$/, "")}/src/cli.ts`, "start", "--login-env"],
  };
}

/** How long the shell waits for /health after starting the runner. */
export const RUNNER_START_MS = 10_000;
