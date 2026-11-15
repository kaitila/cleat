// The shell's report for the Setup section and the shell_action it takes from its socket (shell/src/report.ts).
import { describe, expect, test } from "bun:test";
import { REPORT_PATH, shellAction, shellReport, shellSocketUrl } from "../../shell/src/report";
import { parseReport } from "../../src/runner/platform";

const base = {
  startOnLogin: true,
  hotkey: { wanted: "Control+Alt+Space", active: "Control+Alt+Space" },
  snipHotkey: { wanted: "Control+Alt+S", active: "Control+Alt+S" },
  dockTransparent: true,
  screen: "denied" as const,
};

describe("the report", () => {
  test("a hotkey is registered only when the one held is the one wanted", () => {
    expect(shellReport({ ...base, os: "windows" }).hotkeys).toEqual({ hotkey: true, snipHotkey: true });
    // A change the shell could not register keeps the old one working: that is not the wanted one.
    expect(shellReport({ ...base, os: "windows", hotkey: { wanted: "Alt+Space", active: "Control+Alt+Space" } }).hotkeys.hotkey).toBe(false);
    expect(shellReport({ ...base, os: "windows", snipHotkey: { wanted: "Control+Alt+S", active: null } }).hotkeys.snipHotkey).toBe(false);
  });

  test("Screen Recording only on macOS", () => {
    expect(shellReport({ ...base, os: "macos" }).screenRecording).toBe("denied");
    expect("screenRecording" in shellReport({ ...base, os: "linux" })).toBe(false);
    expect("screenRecording" in shellReport({ ...base, os: "windows" })).toBe(false);
  });

  test("the runner takes what the shell sends", () => {
    for (const os of ["windows", "macos", "linux"] as const) {
      for (const startOnLogin of [true, false, null]) {
        const report = shellReport({ ...base, os, startOnLogin, dockTransparent: os !== "linux" });
        expect(parseReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
      }
    }
  });

  test("goes to the runner's PUT route, and the socket says it is the shell", () => {
    expect(REPORT_PATH).toBe("/api/platform/shell");
    expect(shellSocketUrl("http://127.0.0.1:4777")).toBe("ws://127.0.0.1:4777/ws?client=shell");
  });
});

describe("shell_action", () => {
  test("takes the one action it knows, and nothing else", () => {
    expect(shellAction(JSON.stringify({ type: "shell_action", action: "open_screen_recording" }))).toBe("open_screen_recording");
    for (const other of [
      JSON.stringify({ type: "shell_action", action: "open_url", url: "https://example.com" }),
      JSON.stringify({ type: "settings", action: "open_screen_recording" }),
      JSON.stringify({ type: "shell_action" }),
      JSON.stringify(null),
      "not json",
    ]) {
      expect(shellAction(other)).toBeNull();
    }
    expect(shellAction(undefined)).toBeNull();
  });
});
