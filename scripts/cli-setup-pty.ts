#!/usr/bin/env bun
// `cleat setup` for real, in a pseudo-terminal: util-linux `script` gives it a TTY, this script types the
// keystrokes, and a small screen emulator renders what the person would see, at 80 and at 120 columns.
// Everything runs in a temp HOME, config and data folder, with a fake `claude` on the PATH (logged in), no
// display (so no Electron is downloaded or started) and the fake agent. The runner it starts is stopped at the end.
// It checks: the whole flow with every kind of prompt (and a refused hotkey), then Esc and Ctrl+C cancelling
// with exit 130 and no config written.
//   env -u CI bun scripts/cli-setup-pty.ts            (the rendered screens go to stdout)
//   PTY_OUT=<folder> keeps them as files too. Skipped when CI is set, or without `script` (Linux's util-linux).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");

if (process.env.CI) {
  console.log("skipped: CI is set (run with env -u CI)");
  process.exit(0);
}
if (process.platform !== "linux" || !Bun.which("script")) {
  console.log("skipped: needs Linux's script (util-linux)");
  process.exit(0);
}

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", space: " ", esc: "\x1b", ctrlC: "\x03", backspace: "\x7f" };

/** A screen that keeps every line (no scrolling away): enough of a terminal for what clack and the ui write. */
export function render(raw: string, cols: number): string {
  const rows: string[][] = [[]];
  let x = 0;
  let y = 0;
  const row = (n: number) => {
    while (rows.length <= n) rows.push([]);
    return rows[n]!;
  };
  const put = (ch: string) => {
    if (x >= cols) {
      x = 0;
      y++;
    }
    const r = row(y);
    while (r.length < x) r.push(" ");
    r[x] = ch;
    x += Math.max(1, Bun.stringWidth(ch));
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\x1b") {
      const csi = /^\x1b\[([?0-9;]*)([A-Za-z])/.exec(raw.slice(i, i + 16));
      if (csi) {
        i += csi[0].length - 1;
        const n = Number(csi[1]?.replace("?", "").split(";")[0] || 1);
        const r = row(y);
        switch (csi[2]) {
          case "A": y = Math.max(0, y - n); break;
          case "B": y += n; break;
          case "C": x += n; break;
          case "D": x = Math.max(0, x - n); break;
          case "G": x = n - 1; break;
          case "H": { const [a = 1, b = 1] = (csi[1] ?? "").split(";").map((v) => Number(v || 1)); y = a - 1; x = b - 1; break; }
          case "K": if (csi[1] === "2") r.length = 0; else if (csi[1] === "1") r.fill(" ", 0, x); else r.length = Math.min(r.length, x); break;
          case "J": r.length = Math.min(r.length, x); rows.length = Math.min(rows.length, y + 1); break;
          default: break; // m (colour), l and h (cursor shown or hidden)
        }
        continue;
      }
      const osc = /^\x1b\][^\x07]*\x07/.exec(raw.slice(i));
      if (osc) i += osc[0].length - 1;
      else if (/[78()]/.test(raw[i + 1] ?? "")) i += raw[i + 1] === "(" || raw[i + 1] === ")" ? 2 : 1;
      continue;
    }
    if (ch === "\r") x = 0;
    else if (ch === "\n") y++;
    else if (ch === "\b") x = Math.max(0, x - 1);
    else if (ch >= " ") put(ch);
  }
  return rows.map((r) => r.join("").trimEnd()).join("\n").replace(/\n+$/, "\n");
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "cleat-pty-"));
  const home = join(dir, "home");
  const at = (p: string, t: number) => utimesSync(join(home, p), t, t);
  for (const p of ["code/web/.git", "notes", "elsewhere/site"]) mkdirSync(join(home, p), { recursive: true });
  writeFileSync(join(home, "notes", "CLAUDE.md"), "# notes\n");
  at("notes/CLAUDE.md", 1_700_000_000);
  at("notes", 1_700_000_000);
  at("code/web/.git", 1_700_100_000);
  at("code/web", 1_700_100_000);
  // A fake Claude Code, logged in: setup checks it, and never runs a real one.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!${process.execPath}\nconst a = process.argv.slice(2).join(" ");\nif (a === "--version") console.log("2.1.0 (Claude Code)");\nelse if (a === "auth status") console.log('{ "loggedIn": true }');\nelse process.exit(1);\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const linkDir = join(dir, "link");
  mkdirSync(linkDir);
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    TERM: "xterm-256color",
    LANG: process.env.LANG || "C.UTF-8",
    CLEAT_CONFIG: join(dir, "config", "config.json"),
    CLEAT_DATA_DIR: join(dir, "data"),
    CLEAT_PORT: "0",
    CLEAT_FAKE_AGENT: "1",
    CLEAT_PLATFORM: "linux",
    XDG_CONFIG_HOME: join(dir, "xdg-config"),
    XDG_DATA_HOME: join(dir, "xdg-data"),
  };
  return { dir, home, env, linkDir };
}

/** Runs setup under `script` at a width, with a driver that waits for text on the screen and types. */
function session(cols: number, box: ReturnType<typeof sandbox>, words: string[] = []) {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const command = `stty cols ${cols} rows 60; exec ${[process.execPath, CLI, "setup", "--link-dir", box.linkDir, ...words].map(quote).join(" ")}`;
  const p = Bun.spawn(["script", "-qfec", command, "/dev/null"], { env: box.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let raw = "";
  let seen = 0;
  const done = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of p.stdout) raw += decoder.decode(chunk, { stream: true });
  })();
  /** Waits until `text` is on the screen after what was already waited for. */
  const until = async (text: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const at = raw.indexOf(text, seen);
      if (at >= 0) {
        seen = at + text.length;
        await Bun.sleep(150);
        return;
      }
      await Bun.sleep(30);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(text)} at ${cols} columns. The screen:\n${render(raw, cols)}`);
  };
  const type = async (...keys: string[]) => {
    for (const k of keys) {
      p.stdin.write(k);
      p.stdin.flush();
      await Bun.sleep(k === KEY.esc ? 300 : 60);
    }
  };
  const exited = async () => {
    const code = await p.exited;
    await done;
    return { code, raw, screen: render(raw, cols) };
  };
  return { until, type, exited };
}

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`failed: ${what}`);
  console.error(`ok: ${what}`);
}

async function stopRunner(env: Record<string, string>) {
  Bun.spawnSync([process.execPath, CLI, "stop"], { env: { ...process.env, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}

const out = process.env.PTY_OUT;
if (out) mkdirSync(out, { recursive: true });

for (const cols of [80, 120]) {
  // The whole flow.
  const box = sandbox();
  const s = session(cols, box);
  try {
    await s.until("Which folders");
    // ~/code/web (newest), ~/notes, then Add a folder…: tick all three.
    await s.type(KEY.space, KEY.down, KEY.space, KEY.down, KEY.space, KEY.enter);
    await s.until("Folder path");
    await s.type(join(box.home, "nowhere"), KEY.enter);
    await s.until("no folder at");
    await s.type(...Array(join(box.home, "nowhere").length).fill(KEY.backspace), "~/elsewhere/site", KEY.enter);
    await s.until("Name for");
    await s.type(KEY.enter);
    await s.until("Add another folder?");
    await s.type(KEY.enter);
    await s.until("pick first?");
    await s.type(KEY.down, KEY.enter);
    await s.until("Keep these hotkeys?");
    await s.type(KEY.down, KEY.enter);
    await s.until("New task hotkey");
    await s.type(...Array(20).fill(KEY.backspace), "Space", KEY.enter);
    await s.until("add a modifier");
    await s.type(...Array(10).fill(KEY.backspace), "Control+Shift+K", KEY.enter);
    await s.until("Snip hotkey");
    await s.type(KEY.enter);
    await s.until("Chat hotkey");
    await s.type(KEY.enter);
    await s.until("ask for permission?");
    await s.type(KEY.enter);
    await s.until("log in?");
    await s.type(KEY.enter);
    const r = await s.exited();
    if (out) writeFileSync(join(out, `setup-${cols}.txt`), r.screen);
    console.log(`\n===== cleat setup, ${cols} columns =====\n${r.screen}`);
    check(r.code === 0, `${cols} columns: setup exits 0 (got ${r.code})`);
    const config = JSON.parse(readFileSync(box.env.CLEAT_CONFIG!, "utf8"));
    check(
      JSON.stringify(config.workspaces.map((w: { name: string }) => w.name)) === JSON.stringify(["notes", "web", "site"]),
      `${cols} columns: the workspaces picked, the default first (${config.workspaces.map((w: { name: string }) => w.name)})`,
    );
    check(config.shell.hotkey === "Control+Shift+K" && config.shell.snipHotkey === "Control+Alt+S" && config.shell.startOnLogin === true && config.permissionMode === "auto", `${cols} columns: the hotkeys, permission mode and start at login`);
    check(existsSync(join(box.linkDir, "cleat")), `${cols} columns: the command was linked`);
    const widest = Math.max(...r.screen.split("\n").map((l) => Bun.stringWidth(l)));
    check(widest <= cols, `${cols} columns: no line is wider than the terminal (widest ${widest})`);
  } finally {
    await stopRunner(box.env);
  }

  // Esc at the first question, and Ctrl+C at a later one: exit 130, nothing written.
  for (const [key, at, name] of [[KEY.esc, "Which folders", "Esc"], [KEY.ctrlC, "Keep these hotkeys?", "Ctrl+C"]] as const) {
    const b = sandbox();
    const c = session(cols, b);
    await c.until("Which folders");
    if (at !== "Which folders") {
      await c.type(KEY.space, KEY.enter);
      await c.until(at);
    }
    await c.type(key);
    const r = await c.exited();
    if (out) writeFileSync(join(out, `cancel-${name}-${cols}.txt`), r.screen);
    check(r.code === 130, `${cols} columns: ${name} at "${at}" exits 130 (got ${r.code})`);
    check(!existsSync(b.env.CLEAT_CONFIG!), `${cols} columns: ${name} wrote no config`);
    check(r.screen.includes("cancelled: nothing was written"), `${cols} columns: ${name} says nothing was written`);
    if (cols === 80 && name === "Ctrl+C") console.log(`\n===== Ctrl+C, ${cols} columns =====\n${r.screen}`);
  }
}
console.error("all good");
