// How the command line prints (src/cli/ui.ts): when there is a terminal, colour, the marks, spinners,
// hotkeys as keycaps; and that each command, run into a pipe, prints plain lines with no escape codes.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceleratorError, keycaps, makeUi, marks, paint, stripAnsi, termOf, type Term, wrap } from "../src/cli/ui";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");
const tty = { isTTY: true, columns: 100 };
const pipe = { isTTY: false };

describe("the terminal", () => {
  test("interactive only with stdin and stdout TTYs, CI not set and TERM not dumb", () => {
    expect(termOf({ TERM: "xterm-256color" }, tty, tty)).toMatchObject({ interactive: true, color: true, columns: 100 });
    expect(termOf({}, pipe, tty).interactive).toBe(false);
    expect(termOf({}, tty, pipe).interactive).toBe(false);
    expect(termOf({ CI: "true" }, tty, tty)).toMatchObject({ interactive: false, color: false });
    expect(termOf({ CI: "0" }, tty, tty).interactive).toBe(true);
    expect(termOf({ TERM: "dumb" }, tty, tty)).toMatchObject({ interactive: false, color: false });
  });

  test("colour: FORCE_COLOR wins, else NO_COLOR turns it off, else only to a TTY", () => {
    expect(termOf({ NO_COLOR: "1" }, tty, tty).color).toBe(false);
    expect(termOf({ NO_COLOR: "" }, tty, tty).color).toBe(true);
    expect(termOf({}, tty, pipe).color).toBe(false);
    expect(termOf({ FORCE_COLOR: "1" }, pipe, pipe).color).toBe(true);
    expect(termOf({ FORCE_COLOR: "0" }, tty, tty).color).toBe(false);
    expect(termOf({ FORCE_COLOR: "1", NO_COLOR: "1" }, tty, tty).color).toBe(true);
  });

  test("paint without colour is the text itself; with it, SGR codes that strip back to the text", () => {
    expect(paint(false).green("ok")).toBe("ok");
    expect(paint(true).green("ok")).toBe("\x1b[32mok\x1b[39m");
    expect(stripAnsi(paint(true).bold(paint(true).red("x")))).toBe("x");
    expect(marks(false)).toMatchObject({ ok: "+", fail: "x", skip: "-" });
    expect(marks(true)).toMatchObject({ ok: "✓", fail: "✗", skip: "–" });
  });
});

describe("the ui", () => {
  const plain: Term = { interactive: false, color: false, unicode: true, columns: 80 };
  const live: Term = { interactive: true, color: true, unicode: true, columns: 60 };

  test("without a terminal a spinner prints nothing until it ends, then one line; progress lines are plain lines", async () => {
    let out = "";
    const ui = makeUi({ term: plain, write: (t) => void (out += t), guide: true });
    const s = ui.spin("Installing");
    expect(out).toBe("");
    s.update("downloading Electron");
    s.end("ok", "installed", ["more"]);
    expect(out).toBe("  downloading Electron\n✓ installed\n  more\n");
    out = "";
    await ui.task("Step", async () => {
      throw new Error("broke");
    }, () => ({ state: "ok" }));
    expect(out).toBe("✗ Step: broke\n");
    out = "";
    ui.intro("holm setup");
    ui.step(1, "Requirements");
    ui.outro("done");
    expect(out).toBe("holm setup\n\n\n1. Requirements\n\ndone\n");
  });

  test("on a terminal a spinner redraws one line, hides the cursor and shows it again, and fits the width", async () => {
    let out = "";
    const ui = makeUi({ term: live, write: (t) => void (out += t), guide: true });
    const s = ui.spin("Installing");
    s.update("x".repeat(200));
    await Bun.sleep(100);
    s.end("ok", "installed");
    expect(out).toContain("\x1b[?25l");
    expect(out.endsWith(`\x1b[?25h${paint(true).gray("│")}  ${paint(true).green("✓")} installed\n`)).toBe(true);
    for (const frame of out.split("\r").slice(1, -1)) expect(Bun.stringWidth(stripAnsi(frame).replace("\x1b[2K", ""))).toBeLessThanOrEqual(60);
  });
});

describe("wrapping on a terminal", () => {
  test("at spaces, the continuation under the text after the mark; a word too long is cut; colour is not counted", () => {
    expect(wrap("✓ short", 40)).toEqual(["✓ short"]);
    expect(wrap("✓ command linked: the folder is not on the PATH, add it", 24)).toEqual(["✓ command linked: the", "  folder is not on the", "  PATH, add it"]);
    expect(wrap("x".repeat(50), 20)).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(10)]);
    const green = paint(true).green("✓");
    expect(wrap(`${green} ${"word ".repeat(6).trim()}`, 22).map(stripAnsi)).toEqual(["✓ word word word word", "  word word"]);
  });
});

describe("hotkeys", () => {
  test("an Electron accelerator: modifiers then one key, at least one modifier", () => {
    for (const ok of ["Control+Alt+Space", "Command+Shift+S", "CommandOrControl+K", "Alt+F12", "Super+Plus", "Ctrl+Shift+Up"]) expect(`${ok}: ${acceleratorError(ok)}`).toBe(`${ok}: null`);
    expect(acceleratorError("")).toContain("type a hotkey");
    expect(acceleratorError("Space")).toContain("add a modifier");
    expect(acceleratorError("Control+")).toContain("joined by +");
    expect(acceleratorError("Hyper+K")).toContain("Hyper is not a modifier");
    expect(acceleratorError("Control+Alt")).toContain("end with a key");
    expect(acceleratorError("Control+F25")).toContain("not a key");
    expect(acceleratorError("Control+Ctrl+K")).toBe("each modifier once");
  });

  test("keycaps: [Ctrl] [Alt] [Space] without colour, inverted words with it", () => {
    expect(keycaps("Control+Alt+Space", paint(false), false)).toBe("[Ctrl] [Alt] [Space]");
    expect(keycaps("Command+Shift+S", paint(true), true)).toBe(`${paint(true).inverse(" Cmd ")} ${paint(true).inverse(" Shift ")} ${paint(true).inverse(" S ")}`);
  });
});

describe("every command into a pipe", () => {
  function env() {
    const dir = mkdtempSync(join(tmpdir(), "holm-cli-"));
    return { ...process.env, HOLM_CONFIG: join(dir, "config.json"), HOLM_DATA_DIR: join(dir, "data"), HOLM_PORT: "0", HOLM_PLATFORM: "linux", XDG_DATA_HOME: join(dir, "share"), XDG_CONFIG_HOME: join(dir, "xdg"), HOME: join(dir, "home"), DISPLAY: "", WAYLAND_DISPLAY: "" };
  }
  const run = (words: string[], extra: Record<string, string | undefined> = {}) => {
    const p = Bun.spawnSync([process.execPath, CLI, ...words], { cwd: REPO, env: { ...env(), ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
  };

  test("help, status, stop and doctor print plain lines: no colour, no cursor movement, no spinner frames", () => {
    for (const [words, extra] of [[["help"], {}], [["status"], {}], [["stop"], { NO_COLOR: "1" }], [["doctor"], { TERM: "dumb" }], [["help"], { CI: "1" }]] as [string[], Record<string, string>][]) {
      const r = run(words, extra);
      expect(`${words.join(" ")}: ${JSON.stringify(r.out + r.err).match(/\\u001b|\\r/)}`).toBe(`${words.join(" ")}: null`);
    }
    const status = run(["status"]);
    expect(status).toMatchObject({ code: 1, out: "– not running\n" });
    expect(run(["stop"]).out).toBe("✓ not running\n");
  });

  test("help is grouped, gh-style, and fits 80 columns", () => {
    const { out, code } = run(["help"]);
    expect(code).toBe(0);
    for (const heading of ["USAGE", "GET STARTED", "RUNNER", "SHELL", "MORE", "SETUP FLAGS", "EXAMPLES"]) expect(out).toContain(`\n${heading}`);
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  test("FORCE_COLOR colours even a pipe", () => {
    expect(run(["help"], { FORCE_COLOR: "1" }).out).toContain("\x1b[1mUSAGE\x1b[22m");
  });

  test("doctor --json is one JSON document: the layout, ok, and every check", () => {
    const { out } = run(["doctor", "--json"]);
    const report = JSON.parse(out);
    expect(report.layout).toBe("linux");
    expect(typeof report.ok).toBe("boolean");
    expect(report.checks.map((c: { name: string }) => c.name)).toContain("node and npm");
    for (const c of report.checks) expect(Object.keys(c).sort()).toEqual(["detail", "fix", "name", "needed", "ok"]);
  });

  test("setup without a terminal and without --yes asks nothing: it says to pass --yes or the flags and exits 2, with no config written", () => {
    const e = env();
    const p = Bun.spawnSync([process.execPath, CLI, "setup"], { cwd: REPO, env: { ...e, NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    expect(p.exitCode).toBe(2);
    expect(p.stdout.toString()).toContain("pass --yes to take every default");
    expect(p.stdout.toString()).not.toContain("\x1b");
    expect(existsSync(e.HOLM_CONFIG)).toBe(false);
  });
});
