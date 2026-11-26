// The pop-up's task box (D0056): a plain-text editable area that takes what is pasted or dropped in,
// at the caret. Text goes in as plain text (undo keeps working); a long paste becomes a chip, "Pasted
// text · 42 lines", that a click opens back into the text; a picture becomes a chip with its thumbnail,
// numbered "Image 1", "Image 2" in reading order, uploaded to the runner (POST /api/images) as a PNG
// while the person goes on typing. A chip goes with one Backspace, or its × under the pointer. What it
// holds is sent as one prompt, each picture as "[Image #n]" in its place, and the pictures' paths.
// The pure part is exported for the tests; composer() is the page's.
import { iconByKey } from "./tool-icons.js";

/** A paste longer than this many lines, or characters, becomes a chip rather than text. */
export const LONG_PASTE_LINES = 8;
export const LONG_PASTE_CHARS = 1200;
/** A picture is drawn no larger than this many pixels on its longer side before it is sent. */
export const MAX_IMAGE_SIDE = 3000;

/** Pasted text with Windows and old Mac line ends made plain \n, and a lone final newline dropped. */
export function cleanPaste(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

/** Whether a paste becomes a chip: more than LONG_PASTE_LINES lines, or LONG_PASTE_CHARS characters. */
export function isLongPaste(text) {
  return text.split("\n").length > LONG_PASTE_LINES || text.length > LONG_PASTE_CHARS;
}

/** A pasted text's chip: "Pasted text · 42 lines", or its characters for a long single line. */
export function pastedLabel(text) {
  const lines = text.split("\n").length;
  return lines > 1 ? `Pasted text · ${lines} lines` : `Pasted text · ${text.length.toLocaleString("en-US")} characters`;
}

/**
 * What the box holds, as parts in reading order ({ kind: "text", text }, { kind: "image", path },
 * { kind: "paste", text }), turned into what is sent: the prompt, with each picture as "[Image #n]"
 * in its place and each pasted text in full, and the pictures' paths in that order.
 */
export function serializeParts(parts) {
  let prompt = "";
  const images = [];
  for (const part of parts) {
    if (part.kind === "image") {
      images.push(part.path);
      prompt += `[Image #${images.length}]`;
    } else prompt += part.text;
  }
  return { prompt: prompt.replace(/​/g, ""), images };
}

/** The body of POST /api/sessions: the task, its pictures when there are any, and the agent on the switch. */
export function sessionBody(workspace, prompt, images = [], agent = null) {
  return {
    workspace,
    prompt,
    ...(images.length ? { images } : {}),
    ...(agent === "claude" || agent === "codex" ? { agent } : {}),
  };
}

/** A picture as a base64 PNG, drawn no larger than MAX_IMAGE_SIDE on its longer side. */
async function pngBase64(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const png = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the picture could not be read"))), "image/png"));
  const bytes = new Uint8Array(await png.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Makes `box` (a contenteditable element) the task box. `changed()` is called after anything that can
 * change its size; `upload(base64)` posts a picture and resolves to its path. Returns { read(),
 * clear(), isEmpty(), focus() }; read() waits for pictures still uploading and throws the line to show
 * when one failed.
 */
export function composer(box, { changed = () => {}, upload }) {
  const doc = box.ownerDocument;
  // Plain text only, where the browser has it; elsewhere the paste is taken by hand all the same.
  box.contentEditable = "plaintext-only";
  if (box.contentEditable !== "plaintext-only") box.contentEditable = "true";
  /** chip -> { kind, text?, path?, pending?, failed?, url? } */
  const chips = new WeakMap();

  const isChip = (node) => node?.nodeType === 1 && node.classList.contains("chip");

  /** Where an insert goes: the selection when it is inside the box, else the box's end. */
  function caretRange() {
    const sel = doc.getSelection();
    if (sel && sel.rangeCount > 0 && box.contains(sel.getRangeAt(0).commonAncestorContainer)) return sel.getRangeAt(0);
    const range = doc.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    return range;
  }

  /** Puts a chip at the range, a space after it when no space follows, and the caret after that. */
  function place(chip, range = caretRange()) {
    range.deleteContents();
    range.insertNode(chip);
    let after = chip.nextSibling;
    if (!(after?.nodeType === 3 && /^\s/.test(after.data))) {
      after = doc.createTextNode(" ");
      chip.after(after);
    }
    const sel = doc.getSelection();
    const caret = doc.createRange();
    caret.setStart(after, 1);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
    tidy();
  }

  function removeButton(chip, label) {
    const remove = doc.createElement("button");
    remove.type = "button";
    remove.className = "chip-remove";
    remove.tabIndex = -1;
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${label}`);
    remove.addEventListener("mousedown", (e) => e.preventDefault());
    remove.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop(chip);
    });
    return remove;
  }

  /** Takes a chip out, with the space after it, and puts the caret where it was. */
  function drop(chip) {
    const next = chip.nextSibling;
    if (next?.nodeType === 3 && next.data.startsWith(" ")) next.data = next.data.slice(1);
    const range = doc.createRange();
    range.setStartBefore(chip);
    range.collapse(true);
    const info = chips.get(chip);
    if (info?.url) URL.revokeObjectURL(info.url);
    chip.remove();
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    box.focus();
    tidy();
  }

  function pasteChip(text) {
    const chip = doc.createElement("span");
    chip.className = "chip";
    chip.contentEditable = "false";
    chip.dataset.kind = "paste";
    const label = doc.createElement("span");
    label.className = "chip-label";
    label.textContent = pastedLabel(text);
    chip.append(iconByKey(doc, "page"), label, removeButton(chip, "the pasted text"));
    chip.title = "Click to show the text";
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-label", pastedLabel(text));
    // A click opens it back into the text, where it stood.
    chip.addEventListener("click", () => {
      const range = doc.createRange();
      range.setStartBefore(chip);
      range.collapse(true);
      chip.remove();
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      box.focus();
      doc.execCommand("insertText", false, text);
      tidy();
    });
    chips.set(chip, { kind: "paste", text });
    return chip;
  }

  function imageChip(blob) {
    const chip = doc.createElement("span");
    chip.className = "chip";
    chip.contentEditable = "false";
    chip.dataset.kind = "image";
    chip.dataset.state = "uploading";
    chip.setAttribute("role", "img");
    const url = URL.createObjectURL(blob);
    const thumb = doc.createElement("img");
    thumb.className = "chip-thumb";
    thumb.alt = "";
    thumb.src = url;
    thumb.addEventListener("load", changed);
    const label = doc.createElement("span");
    label.className = "chip-label";
    chip.append(thumb, label, removeButton(chip, "the picture"));
    const info = { kind: "image", url, path: null, failed: false, pending: null };
    info.pending = pngBase64(blob)
      .then((data) => upload(data))
      .then((path) => {
        info.path = path;
        delete chip.dataset.state;
      })
      .catch((e) => {
        info.failed = true;
        chip.dataset.state = "failed";
        chip.title = `This picture didn't upload: ${e?.message ?? e}. Remove it, or paste it again.`;
      })
      // Its label says how it went.
      .finally(() => tidy());
    chips.set(chip, info);
    return chip;
  }

  /** After a change: the pictures numbered in reading order, an emptied box truly empty (so its placeholder shows), the size. */
  function tidy() {
    let n = 0;
    for (const chip of box.querySelectorAll(".chip[data-kind='image']")) {
      n += 1;
      const name = `Image ${n}`;
      const label = chip.querySelector(".chip-label");
      if (label.textContent !== name) label.textContent = name;
      const state = chip.dataset.state === "uploading" ? ", uploading" : chip.dataset.state === "failed" ? ", didn't upload" : "";
      chip.setAttribute("aria-label", `${name}${state}`);
    }
    if (!box.querySelector(".chip") && box.textContent.replace(/​/g, "") === "" && box.childNodes.length > 0) box.replaceChildren();
    box.classList.toggle("empty", box.childNodes.length === 0);
    changed();
  }

  function images(files) {
    return [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
  }

  box.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    const pictures = images(data.files);
    if (pictures.length > 0) {
      for (const picture of pictures) place(imageChip(picture));
      return;
    }
    const text = cleanPaste(data.getData("text/plain"));
    if (!text) return;
    if (isLongPaste(text)) place(pasteChip(text));
    else doc.execCommand("insertText", false, text);
  });

  // A picture dragged over the pop-up: the card says it can take it, and it goes where it is dropped.
  const card = box.closest("form") ?? box;
  let dragDepth = 0;
  const carries = (e) => [...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file" && i.type.startsWith("image/"));
  card.addEventListener("dragenter", (e) => {
    if (!carries(e)) return;
    e.preventDefault();
    dragDepth += 1;
    card.dataset.drop = "";
  });
  card.addEventListener("dragover", (e) => {
    if (!carries(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  card.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) delete card.dataset.drop;
  });
  card.addEventListener("drop", (e) => {
    dragDepth = 0;
    delete card.dataset.drop;
    const pictures = images(e.dataTransfer?.files);
    if (pictures.length === 0) return;
    e.preventDefault();
    const at = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    let range = at && box.contains(at.startContainer) ? at : caretRange();
    for (const picture of pictures) {
      place(imageChip(picture), range);
      range = caretRange();
    }
    box.focus();
  });

  box.addEventListener("input", tidy);

  /** The box's contents as parts, in reading order. */
  function parts() {
    const out = [];
    const walk = (node, first) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out.push({ kind: "text", text: child.data });
        else if (isChip(child)) {
          const info = chips.get(child);
          if (info?.kind === "paste") out.push({ kind: "paste", text: info.text });
          else if (info?.kind === "image") out.push({ kind: "image", path: info.path, info });
        } else if (child.nodeName === "BR") out.push({ kind: "text", text: "\n" });
        else if (child.nodeType === 1) {
          // A line the browser wrapped in a block (outside plaintext-only): a new line before it.
          if (/^(DIV|P)$/.test(child.nodeName) && !(first && child === node.firstChild)) out.push({ kind: "text", text: "\n" });
          walk(child, false);
        }
      }
    };
    walk(box, true);
    return out;
  }

  return {
    async read() {
      const now = parts();
      const pictures = now.filter((p) => p.kind === "image");
      await Promise.all(pictures.map((p) => p.info.pending));
      if (pictures.some((p) => p.info.failed)) throw new Error("a picture didn't upload: remove it, or paste it again");
      return serializeParts(parts());
    },
    clear() {
      for (const chip of box.querySelectorAll(".chip")) {
        const info = chips.get(chip);
        if (info?.url) URL.revokeObjectURL(info.url);
      }
      box.replaceChildren();
      tidy();
    },
    isEmpty() {
      return !box.querySelector(".chip") && box.textContent.trim() === "";
    },
    focus() {
      box.focus();
      const range = caretRange();
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    },
  };
}
