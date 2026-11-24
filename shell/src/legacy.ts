// The shell's part of the renames from intuition to holm (D0043) and from holm to cleat (D0048).
// Importing this file takes the old HOLM_* and INTUITION_* environment variables as CLEAT_*, for one release.
//
// Start on login on Windows is a registry value named after the app id, which was "intuition", then
// "holm". The shell removes both at every start (removing a value that is not there does nothing); the
// new one, "cleat", is written as before when the runner's settings say start on login is on. The
// folders and the macOS and Linux login files are moved by `cleat shell install` (src/shell/legacy.ts).
import { adoptLegacyEnv, OLD_NAMES } from "../../src/shared/legacy";

adoptLegacyEnv(process.env);

/** The old Windows login items' names, newest first. */
export const OLD_APP_IDS = OLD_NAMES.map((o) => o.appId);

/** Removes the old Windows login items. Electron deletes a Run value (and its StartupApproved one) by name. */
export function dropOldLoginItem(app: { setLoginItemSettings(settings: { openAtLogin: boolean; name: string; path: string; args: string[] }): void }, execPath: string): void {
  for (const name of OLD_APP_IDS) {
    try {
      app.setLoginItemSettings({ openAtLogin: false, name, path: execPath, args: [] });
    } catch (e) {
      console.error(`removing the old login item ${name} failed`, e);
    }
  }
}
