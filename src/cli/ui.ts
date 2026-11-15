// How every command prints: the same marks, colours and spinners, and plain lines when there is no terminal.
// A terminal (stdin and stdout TTYs, no CI, TERM not dumb) gets spinners and prompts; colour follows
// NO_COLOR, FORCE_COLOR and whether stdout is a TTY. Without a terminal nothing moves the cursor.
import { Writable } from "node:stream";

type Env = Record<string, string | undefined>;

export interface Term {
  /** Spinners, cursor movement and prompts: stdin and stdout are TTYs, CI is not set, TERM is not dumb. */
  interactive: boolean;
  /** Colour codes: FORCE_COLOR, else none with NO_COLOR, else only to a TTY outside CI with a TERM that is not dumb. */
  color: boolean;
  /** Unicode marks; plain ASCII ones on a Windows console without a modern terminal, or TERM=linux. */
  unicode: boolean;
  /** The terminal's width, for spinner lines that must not wrap. */
  columns: number;
}

interface Tty {
  isTTY?: boolean;
  columns?: number;
}

/** What this process's terminal allows. */
export function termOf(env: Env = process.env, stdin: Tty = process.stdin, stdout: Tty = process.stdout): Term {
  const dumb = env.TERM === "dumb";
  const ci = env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false";
  const tty = stdout.isTTY === true;
  let color: boolean;
  const force = env.FORCE_COLOR;
  if (force !== undefined) color = force !== "0" && force !== "false";
  else if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") color = false;
  else color = tty && !dumb && !ci;
  const unicode = process.platform !== "win32" ? env.TERM !== "linux" : Boolean(env.WT_SESSION || env.TERM_PROGRAM);
  return { interactive: stdin.isTTY === true && tty && !ci && !dumb, color, unicode, columns: stdout.columns || 80 };
}

export interface Paint {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  gray(s: string): string;
  inverse(s: string): string;
}

const sgr = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const same = (s: string) => s;

export function paint(color: boolean): Paint {
  if (!color) return { bold: same, dim: same, green: same, red: same, yellow: same, cyan: same, gray: same, inverse: same };
  return { bold: sgr(1, 22), dim: sgr(2, 22), green: sgr(32, 39), red: sgr(31, 39), yellow: sgr(33, 39), cyan: sgr(36, 39), gray: sgr(90, 39), inverse: sgr(7, 27) };
}

/** Colour codes (SGR), and every other escape sequence. */
const SGR = /\x1b\[[0-9;]*m/g;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function stripColor(s: string): string {
  return s.replace(SGR, "");
}

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** How a step or check ended: done, failed, skipped (or optional and missing), or done with something to notice. */
export type State = "ok" | "fail" | "skip" | "warn";

export interface Marks {
  ok: string;
  fail: string;
  skip: string;
  warn: string;
  bar: string;
  start: string;
  end: string;
  step: string;
  cancel: string;
  frames: string[];
}

export function marks(unicode: boolean): Marks {
  return unicode
    ? { ok: "✓", fail: "✗", skip: "–", warn: "▲", bar: "│", start: "┌", end: "└", step: "◇", cancel: "■", frames: ["◒", "◐", "◓", "◑"] }
    : { ok: "+", fail: "x", skip: "-", warn: "!", bar: "|", start: "T", end: "-", step: "o", cancel: "x", frames: ["-", "\\", "|", "/"] };
}

export interface Spinner {
  /** A progress line beside the title: the newest line a step printed. Without a terminal it is printed on its own line. */
  update(line: string): void;
  /** Ends it: the mark for the state, then the text (the title when none), and under it the extra lines. */
  end(state: State, text?: string, more?: string[]): void;
  /** Ends it without a line: for a spinner that only showed something is happening. */
  clear(): void;
}

export interface Ui {
  readonly term: Term;
  readonly c: Paint;
  readonly m: Marks;
  /** Prints one line (with the guide bar in front, when the ui has one). */
  line(text?: string): void;
  /** The mark for a state, coloured. */
  mark(state: State): string;
  /** A spinner on a terminal; without one, nothing until it ends, then one line. */
  spin(title: string): Spinner;
  /** The frame's first line: the name, and what this run is. */
  intro(title: string): void;
  /** A numbered step's heading. */
  step(n: number, title: string): void;
  /** The frame's last line. */
  outro(text: string): void;
  /** Runs one step under a spinner; what it returns ends the spinner. A throw ends it as a failure with the error's message. */
  task<T>(title: string, run: (update: (line: string) => void) => Promise<T>, done: (value: T) => Outcome, failed?: (error: unknown) => Outcome): Promise<T | undefined>;
}

export interface Outcome {
  state: State;
  text?: string;
  more?: string[];
}

export interface UiOptions {
  term?: Term;
  /** Where the text goes; stdout by default. */
  write?: (text: string) => void;
  /** Lines start with the guide bar (setup's frame) on a terminal. */
  guide?: boolean;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The visible width of a string: its colour and cursor codes left out. */
function width(s: string): number {
  return Bun.stringWidth(stripAnsi(s));
}

/** Cut to `max` visible columns (plain text only), with an ellipsis. */
function fit(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = "";
  for (const ch of stripAnsi(s)) {
    if (width(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

let cursorHidden = false;
function showCursorOnExit(write: (t: string) => void) {
  if (cursorHidden) return;
  cursorHidden = true;
  process.once("exit", () => write("\x1b[?25h"));
}

export function makeUi(options: UiOptions = {}): Ui {
  const term = options.term ?? termOf();
  const write = options.write ?? ((t: string) => void process.stdout.write(t));
  const c = paint(term.color);
  const m = marks(term.unicode);
  const guide = options.guide === true && term.interactive;
  const prefix = guide ? `${c.gray(m.bar)}  ` : "";
  const mark = (state: State) => ({ ok: c.green(m.ok), fail: c.red(m.fail), skip: c.dim(m.skip), warn: c.yellow(m.warn) })[state];
  const line = (text = "") => write(text === "" ? `${guide ? c.gray(m.bar) : ""}\n` : `${text.split("\n").map((l) => prefix + l).join("\n")}\n`);
  const finish = (state: State, text: string, more: string[] = []) => {
    line(`${mark(state)} ${text}`);
    for (const l of more) line(`  ${c.dim(l)}`);
  };

  const spin = (title: string): Spinner => {
    if (!term.interactive) {
      return {
        update: (l) => {
          if (l.trim() !== "") line(`  ${l}`);
        },
        end: (state, text, more) => finish(state, text ?? title, more),
        clear: () => {},
      };
    }
    let frame = 0;
    let detail = "";
    const began = Date.now();
    showCursorOnExit(write);
    const draw = () => {
      const secs = Math.floor((Date.now() - began) / 1000);
      const head = `${c.cyan(m.frames[frame % m.frames.length]!)} ${title}${secs >= 3 ? c.dim(` ${secs}s`) : ""}`;
      const room = term.columns - width(prefix) - width(head) - 3;
      const tail = detail && room > 8 ? `  ${c.dim(fit(detail, room))}` : "";
      write(`\r\x1b[2K${prefix}${head}${tail}`);
    };
    write("\x1b[?25l");
    draw();
    const timer = setInterval(() => {
      frame++;
      draw();
    }, 80);
    const onInt = () => {
      clearInterval(timer);
      write(`\r\x1b[2K${prefix}${c.red(m.cancel)} ${title}: cancelled\n\x1b[?25h`);
      process.exit(130);
    };
    process.once("SIGINT", onInt);
    return {
      update: (l) => {
        const t = stripAnsi(l).trim();
        if (t !== "") detail = t;
        draw();
      },
      end: (state, text, more) => {
        clearInterval(timer);
        process.removeListener("SIGINT", onInt);
        write("\r\x1b[2K\x1b[?25h");
        finish(state, text ?? title, more);
      },
      clear: () => {
        clearInterval(timer);
        process.removeListener("SIGINT", onInt);
        write("\r\x1b[2K\x1b[?25h");
      },
    };
  };

  return {
    term,
    c,
    m,
    line,
    mark,
    spin,
    intro: (title) => write(guide ? `${c.gray(m.start)}  ${c.bold(title)}\n${c.gray(m.bar)}\n` : `${title}\n\n`),
    step: (n, title) => {
      if (guide) write(`${c.gray(m.bar)}\n${c.cyan(m.step)}  ${c.bold(`${n}  ${title}`)}\n`);
      else write(`\n${n}. ${title}\n`);
    },
    outro: (text) => {
      if (guide) write(`${c.gray(m.bar)}\n${c.gray(m.end)}  ${text.split("\n").join(`\n   `)}\n`);
      else write(`\n${text}\n`);
    },
    task: async (title, run, done, failed) => {
      const s = spin(title);
      let value;
      try {
        value = await run((l) => s.update(l));
      } catch (e) {
        const o = failed ? failed(e) : { state: "fail" as const, text: `${title}: ${errorText(e)}` };
        s.end(o.state, o.text, o.more);
        return undefined;
      }
      const o = done(value);
      s.end(o.state, o.text, o.more);
      return value;
    },
  };
}

/**
 * The stream clack's prompts write to: stdout itself, or, when colour is off, stdout with the colour codes
 * taken out (clack colours through node:util's styleText, which bun does not stop for NO_COLOR).
 */
export function promptOutput(term: Term): NodeJS.WriteStream | Writable {
  if (term.color) return process.stdout;
  const out = new Writable({
    write(chunk, _enc, cb) {
      process.stdout.write(stripColor(String(chunk)), cb);
    },
  });
  Object.defineProperties(out, {
    isTTY: { get: () => process.stdout.isTTY },
    columns: { get: () => process.stdout.columns },
    rows: { get: () => process.stdout.rows },
  });
  process.stdout.on("resize", () => out.emit("resize"));
  return out;
}

/** Electron's modifier names, and the short words keycaps show for them. */
const MODIFIERS: Record<string, string> = {
  command: "Cmd",
  cmd: "Cmd",
  control: "Ctrl",
  ctrl: "Ctrl",
  commandorcontrol: "Ctrl/Cmd",
  cmdorctrl: "Ctrl/Cmd",
  alt: "Alt",
  option: "Option",
  altgr: "AltGr",
  shift: "Shift",
  super: "Super",
  meta: "Meta",
};

const NAMED_KEYS = new Set(
  [
    "Plus", "Space", "Tab", "Capslock", "Numlock", "Scrolllock", "Backspace", "Delete", "Insert", "Return", "Enter",
    "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "Escape", "Esc", "VolumeUp", "VolumeDown",
    "VolumeMute", "MediaNextTrack", "MediaPreviousTrack", "MediaStop", "MediaPlayPause", "PrintScreen",
    "numdec", "numadd", "numsub", "nummult", "numdiv",
  ].map((k) => k.toLowerCase()),
);

function isKey(key: string): boolean {
  const k = key.toLowerCase();
  if (/^[a-z0-9]$/.test(k)) return true;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) return true;
  if (/^num[0-9]$/.test(k)) return true;
  if (NAMED_KEYS.has(k)) return true;
  return key.length === 1 && ")!@#$%^&*(:;:+=<,_->.?/~`{][|\\}\"'".includes(key);
}

/**
 * Why a string is not an Electron accelerator (docs: "Accelerator"), or null when it is one: modifiers
 * joined by "+", then exactly one key. A global hotkey needs at least one modifier.
 */
export function acceleratorError(value: string): string | null {
  const text = value.trim();
  if (text === "") return "type a hotkey, such as Control+Alt+Space";
  // "+" as the key is written Plus; a trailing "+" alone would be an empty part.
  const parts = text.split("+").map((p) => p.trim());
  if (parts.some((p) => p === "")) return "a hotkey is keys joined by +, such as Control+Alt+Space (the + key is Plus)";
  const key = parts.at(-1)!;
  const mods = parts.slice(0, -1);
  for (const mod of mods) if (!(mod.toLowerCase() in MODIFIERS)) return `${mod} is not a modifier: use Control, Alt, Shift, Command, Super or CommandOrControl`;
  if (key.toLowerCase() in MODIFIERS) return "end with a key, such as Space or K, after the modifiers";
  if (!isKey(key)) return `${key} is not a key Electron knows: use a letter, a digit, F1 to F24, or a name such as Space or Up`;
  if (mods.length === 0) return "add a modifier, such as Control or Alt: a key alone would be taken from every program";
  if (new Set(mods.map((m) => MODIFIERS[m.toLowerCase()])).size !== mods.length) return "each modifier once";
  return null;
}

/** A hotkey as keycaps: inverted words with colour, else [Ctrl] [Alt] [Space]. */
export function keycaps(accelerator: string, c: Paint, color: boolean): string {
  const keys = accelerator.split("+").map((p) => MODIFIERS[p.trim().toLowerCase()] ?? p.trim());
  return keys.map((k) => (color ? c.inverse(` ${k} `) : `[${k}]`)).join(" ");
}
