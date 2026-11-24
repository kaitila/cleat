// The pages' command-key hotkeys (src/web/keys.js, D0040): ⌘ on a Mac, Ctrl elsewhere, never Alt.
import { describe, expect, test } from "bun:test";
import { commandAria, commandDigit, commandK, commandLabel, commandOnly } from "../../src/web/keys.js";

describe("the command key", () => {
  test("is ⌘ alone on a Mac and Ctrl alone elsewhere", () => {
    expect(commandOnly({ metaKey: true }, true)).toBe(true);
    expect(commandOnly({ ctrlKey: true }, false)).toBe(true);
    expect(commandOnly({ ctrlKey: true }, true)).toBe(false);
    expect(commandOnly({ metaKey: true }, false)).toBe(false);
    for (const e of [{ metaKey: true, shiftKey: true }, { metaKey: true, altKey: true }, { metaKey: true, ctrlKey: true }, { metaKey: true, isComposing: true }]) expect(commandOnly(e, true)).toBe(false);
    expect(commandOnly(null, true)).toBe(false);
  });

  test("⌘1..9 is its digit by the physical key; ⌘0 and Alt+digit are not", () => {
    expect(commandDigit({ metaKey: true, code: "Digit4", key: "4" }, true)).toBe(4);
    expect(commandDigit({ ctrlKey: true, code: "Numpad9", key: "9" }, false)).toBe(9);
    expect(commandDigit({ metaKey: true, code: "Digit0", key: "0" }, true)).toBeNull();
    expect(commandDigit({ altKey: true, code: "Digit2", key: "@" }, true)).toBeNull();
  });

  test("⌘K by the physical key", () => {
    expect(commandK({ metaKey: true, code: "KeyK", key: "k" }, true)).toBe(true);
    expect(commandK({ ctrlKey: true, key: "K" }, false)).toBe(true);
    expect(commandK({ metaKey: true, code: "KeyJ", key: "j" }, true)).toBe(false);
    expect(commandK({ altKey: true, code: "KeyK", key: "˚" }, true)).toBe(false);
  });

  test("is written ⌘ on a Mac and Ctrl+ elsewhere", () => {
    expect(commandLabel(true)).toBe("⌘");
    expect(commandLabel(false)).toBe("Ctrl+");
    expect(commandAria(true)).toBe("Meta");
    expect(commandAria(false)).toBe("Control");
  });
});
