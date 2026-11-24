// The pages' own hotkeys are on the command key: ⌘ on a Mac, Ctrl elsewhere (D0040). Never Option
// or Alt with a digit: on many layouts (Finnish, German, Swedish, …) Option+2 is @, and Option with
// other digits types brackets and braces, so a hotkey there takes a character from the person.

/** True on a Mac, where the command key is ⌘ (Meta) and Ctrl is free for the system. */
export const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

/** True when the command key alone is held with the key: ⌘ on a Mac, Ctrl elsewhere, and no Shift or Alt. */
export function commandOnly(event, mac = MAC) {
  if (!event || event.isComposing || event.altKey || event.shiftKey) return false;
  return mac ? event.metaKey === true && !event.ctrlKey : event.ctrlKey === true && !event.metaKey;
}

/**
 * The digit of ⌘1..9 (Ctrl+1..9 off a Mac), or null for any other key. The physical key first, so a
 * layout that has the digits on Shift (French) still counts.
 */
export function commandDigit(event, mac = MAC) {
  if (!commandOnly(event, mac)) return null;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code ?? "")?.[1] ?? (/^[1-9]$/.test(event.key ?? "") ? event.key : null);
  return digit ? Number(digit) : null;
}

/** True for ⌘K (Ctrl+K off a Mac): the physical key, so any layout. */
export function commandK(event, mac = MAC) {
  return commandOnly(event, mac) && (event.code === "KeyK" || (!event.code && /^k$/i.test(event.key ?? "")));
}

/** How a page writes the command key before another: "⌘" on a Mac, "Ctrl+" elsewhere. */
export function commandLabel(mac = MAC) {
  return mac ? "⌘" : "Ctrl+";
}

/** The command key as aria-keyshortcuts names it: "Meta" on a Mac, "Control" elsewhere. */
export function commandAria(mac = MAC) {
  return mac ? "Meta" : "Control";
}
