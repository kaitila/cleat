// The shell's part of the rename from intuition to holm (D0043). Importing this file takes the old
// INTUITION_* environment variables as HOLM_*, for one release.
//
// Start on login on Windows is a registry value named after the app id, which was "intuition". The
// shell removes it at every start (removing a value that is not there does nothing); the new one,
// "holm", is written as before when the runner's settings say start on login is on. The folders and
// the macOS and Linux login files are moved by `holm shell install` (src/shell/legacy.ts).
import { adoptLegacyEnv, OLD_APP_ID } from "../../src/shared/legacy";

adoptLegacyEnv(process.env);

export { OLD_APP_ID };

/** Removes the old Windows login item. Electron deletes the Run value (and its StartupApproved one) by name. */
export function dropOldLoginItem(app: { setLoginItemSettings(settings: { openAtLogin: boolean; name: string; path: string; args: string[] }): void }, execPath: string): void {
  try {
    app.setLoginItemSettings({ openAtLogin: false, name: OLD_APP_ID, path: execPath, args: [] });
  } catch (e) {
    console.error("removing the old login item failed", e);
  }
}
