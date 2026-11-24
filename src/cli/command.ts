// Which command a line of words names. Kept apart from src/cli.ts, which runs on import.

/** What `holm` alone does. */
export const DEFAULT_COMMAND = "up";
const HELP_WORDS = ["help", "--help", "-h"];

export interface Picked {
  name: string;
  /** The words after the command's name. */
  rest: string[];
}

/**
 * The command the words name, out of `names` (one or two words each), or null when they name none.
 * No words is the default command; `help`, `--help` and `-h` are all `help`.
 */
export function pick(words: string[], names: string[]): Picked | null {
  if (words.length === 0) return { name: DEFAULT_COMMAND, rest: [] };
  if (HELP_WORDS.includes(words[0]!)) return { name: "help", rest: words.slice(1) };
  const name = [words.slice(0, 2).join(" "), words[0]!].find((n) => names.includes(n));
  return name === undefined ? null : { name, rest: words.slice(name.split(" ").length) };
}
