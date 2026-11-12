// Start on login: what Electron's login item settings are given. No Electron imports here.

/** The app user model id. Windows ties toasts to it, and Electron names the login item's registry value after it. */
export const APP_ID = "intuition";

/** What `--login on|off|status` writes to its result file. */
export interface LoginResult {
  /** Whether the shell starts on login now. Null when it could not be read. */
  openAtLogin: boolean | null;
  error: string | null;
}

/**
 * The executable and arguments of the login item: electron.exe on the app folder, as the shell is
 * started by hand. Setting and reading must give the same two, or the reading says "off".
 * Windows stores one command line, so the folder is quoted here: a user name can hold a space.
 */
export function loginItem(execPath: string, appPath: string): { path: string; args: string[] } {
  return { path: execPath, args: [`"${appPath}"`] };
}

export function parseLogin(value: string | undefined): "on" | "off" | "status" | undefined {
  return value === "on" || value === "off" || value === "status" ? value : undefined;
}
