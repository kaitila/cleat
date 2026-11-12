// Smoke check of the clipboard image handoff with real Claude Code: needs this machine's Claude Code
// login and its Windows drive, so it is not part of the test suite or CI. Run it with
// `bun scripts/smoke-image.ts`.
//
// It writes a 64x64 solid red PNG into a new folder under the Windows temp folder, where the shell
// saves its clips, starts the runner in this process on a free port with a temp config and data
// folder, posts the PNG's Windows path to /api/clipboard and checks the stored path is the WSL one.
// Then it starts a session with that imagePath and the prompt below, and exits 0 when the answer
// contains "red". After 180 seconds it exits 1 and says what it saw. It deletes its files either way.
//
// The session's workspace is the image's own new folder, not one under /tmp: a Read of a file
// outside the workspace needs approval, and until approvals exist the runner denies it. Inside the
// workspace Claude Code reads without asking, so this checks the handoff, not the approval.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { ClipboardCapture, ServerMessage, SessionResponse } from "../src/shared/protocol";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";

const TIMEOUT_MS = 180_000;
const PROMPT = "What colour is the attached image? Answer with one word.";
const WINDOWS_TEMP = "/mnt/c/Users/arttu/AppData/Local/Temp/intuition";

/** A PNG of one colour: 8-bit RGB, every row unfiltered, the rows deflated with zlib. */
function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // bit depth 8, colour type 2 (RGB), deflate, no filter method, no interlace
  const row = Buffer.alloc(1 + size * 3); // starts with the filter byte, 0
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

let workspace: string;
try {
  mkdirSync(WINDOWS_TEMP, { recursive: true });
  workspace = mkdtempSync(join(WINDOWS_TEMP, "smoke-image-"));
} catch (e) {
  console.log(`FAIL: no folder could be made under ${WINDOWS_TEMP}: ${(e as Error).message}`);
  process.exit(1);
}
const image = join(workspace, "clip-red.png");
writeFileSync(image, solidPng(64, [255, 0, 0]));
// /mnt/c/Users/... as Windows names it, the way the shell posts it.
const windowsPath = `C:\\${image.slice("/mnt/c/".length).replaceAll("/", "\\")}`;

const dir = mkdtempSync(join(tmpdir(), "intuition-smoke-image-"));
const configFile = join(dir, "config.json");
writeFileSync(configFile, JSON.stringify({ workspaces: [{ name: "smoke", path: workspace }] }));
// Its own environment, so a INTUITION_FAKE_AGENT left in the shell can't turn this into a fake run.
const runner = startServer(loadConfig({ INTUITION_CONFIG: configFile, INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: "0" }));
console.log(`runner on ${runner.url}, workspace ${workspace}`);

const seen = { storedWslPath: false, userEventKeepsThemApart: false, readTheFile: false, answer: "", resultOk: false };
let ws: WebSocket | null = null;
let finished = false;

async function finish(code: number, why: string): Promise<never> {
  finished = true;
  clearTimeout(timer);
  console.log(`${code === 0 ? "PASS" : "FAIL"}: ${why}`);
  console.log(`seen: ${JSON.stringify(seen)}`);
  ws?.close();
  await runner.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  process.exit(code);
}

const timer = setTimeout(() => void finish(1, `not finished after ${TIMEOUT_MS / 1000} seconds`), TIMEOUT_MS);
const post = (path: string, body: unknown) =>
  fetch(runner.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const posted = await post("/api/clipboard", { imagePath: windowsPath });
if (posted.status !== 200) await finish(1, `POST /api/clipboard with ${windowsPath} answered ${posted.status}: ${await posted.text()}`);
const stored = ((await posted.json()) as ClipboardCapture).imagePath;
const latest = ((await (await fetch(`${runner.url}/api/clipboard`)).json()) as Partial<ClipboardCapture>).imagePath;
console.log(`posted ${windowsPath}, stored ${stored}`);
if (stored !== image || latest !== image) await finish(1, `the stored path is not the WSL path ${image}: ${stored} / ${latest}`);
seen.storedWslPath = true;
const thumbnail = await fetch(`${runner.url}/api/clipboard/image`);
if (thumbnail.status !== 200 || (await thumbnail.arrayBuffer()).byteLength === 0) await finish(1, `GET /api/clipboard/image answered ${thumbnail.status}`);

// This runner has only the one session, so every message on /ws is about it.
ws = new WebSocket(`ws://127.0.0.1:${runner.port}/ws`);
ws.onerror = () => void finish(1, "the WebSocket failed");
ws.onmessage = (e) => {
  if (finished) return;
  const message = JSON.parse(String(e.data)) as ServerMessage;
  if (message.type !== "event") return;
  const event = message.event;
  console.log(`event ${JSON.stringify(event).slice(0, 400)}`);
  if (event.kind === "user") seen.userEventKeepsThemApart = event.text === PROMPT && event.imagePath === image;
  if (event.kind === "tool_use" && JSON.stringify(event.input).includes("clip-red.png")) seen.readTheFile = true;
  if (event.kind === "assistant_text") seen.answer += `${event.text}\n`;
  if (event.kind === "error") void finish(1, `the turn failed: ${event.message}`);
  if (event.kind === "result") {
    seen.resultOk = event.ok;
    seen.answer += event.text ?? "";
    if (!event.ok) void finish(1, "the turn failed");
    else if (!seen.userEventKeepsThemApart) void finish(1, "the user event does not keep the text and the imagePath apart");
    else if (!/\bred\b/i.test(seen.answer)) void finish(1, 'the answer does not contain "red"');
    else void finish(0, 'the stored path is the WSL one, and the answer contains "red"');
  }
};
ws.onopen = async () => {
  const res = await post("/api/sessions", { workspace: "smoke", prompt: PROMPT, imagePath: stored });
  if (res.status !== 201) return void finish(1, `POST /api/sessions answered ${res.status}: ${await res.text()}`);
  console.log(`session ${((await res.json()) as SessionResponse).session.id} started`);
};
