// Start on login: what Electron's login item settings are given. No Electron imports here.

/** The app user model id. Windows ties toasts to it, and Electron names the login item's registry value after it. */
export const APP_ID = "cleat";

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

// --- macOS and Linux ---
// Electron's login item does nothing on Linux, and on macOS it registers Electron.app itself, which
// would start Electron's default app without the shell's folder. Both get a file that runs the
// installed Electron on the app folder, as `shell start` does.

/** The XDG autostart file that starts the shell at login on Linux. */
export function autostartFile(home: string, env: Record<string, string | undefined> = process.env): string {
  return `${env.XDG_CONFIG_HOME || `${home}/.config`}/autostart/cleat.desktop`;
}

/** One argument of a .desktop file's Exec line: quoted, with ", `, $ and \ escaped, and % doubled. */
function execArg(arg: string): string {
  return `"${arg.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/%/g, "%%")}"`;
}

/** The autostart entry: the installed Electron on the app folder, as `shell start` runs it. */
export function autostartEntry(exe: string, args: string[]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Cleat",
    "Comment=Fire tasks at Claude Code from a hotkey",
    `Exec=${[exe, ...args].map(execArg).join(" ")}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** The launchd agent's label, and its file's name under ~/Library/LaunchAgents. */
export const LAUNCH_AGENT = "dev.cleat.shell";

/** The launch agent that starts the shell at login on macOS. */
export function launchAgentFile(home: string): string {
  return `${home}/Library/LaunchAgents/${LAUNCH_AGENT}.plist`;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The launch agent: run the installed Electron on the app folder once, at login. launchd reads it at the next login. */
export function launchAgentPlist(exe: string, args: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LAUNCH_AGENT}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[exe, ...args].map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>ProcessType</key><string>Interactive</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
