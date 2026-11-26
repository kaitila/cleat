// Pictures pasted into the pop-up's task (D0056): POST /api/images saves a PNG in the runner's data
// folder, a session started or replied to names it in `images`, and the agent's prompt lists each by
// its "[Image #n]". Anything that isn't a PNG, or a path the runner didn't save, is refused.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventsResponse, ImageUploadResponse } from "../../src/shared/protocol";
import { BAD_IMAGES, IMAGE_NAME, MAX_IMAGES, NOT_A_PNG } from "../../src/runner/images";
import { promptWithImage } from "../../src/runner/sessions";
import { testRunner } from "./helpers";

/** The smallest PNG there is: one transparent pixel. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("pasted pictures", () => {
  const runner = testRunner();
  afterAll(() => runner.stop());

  async function upload(data: unknown): Promise<Response> {
    return runner.post("/api/images", { data });
  }

  test("a PNG is saved in the data folder's images/, under a new name, and served back", async () => {
    const res = await upload(PIXEL);
    expect(res.status).toBe(201);
    const { imagePath } = (await res.json()) as ImageUploadResponse;
    expect(imagePath.endsWith(".png")).toBe(true);
    const name = imagePath.split("/").at(-1)!;
    expect(name).toMatch(IMAGE_NAME);
    expect(existsSync(imagePath)).toBe(true);
    expect(readFileSync(imagePath).equals(Buffer.from(PIXEL, "base64"))).toBe(true);
    const served = await runner.get(`/api/images/${name}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(PIXEL, "base64"))).toBe(true);
  });

  test("anything but a base64 PNG is refused, and only a saved picture's name is served", async () => {
    for (const data of [undefined, 5, "", Buffer.from("GIF89a not a png").toString("base64"), Buffer.from("plain text").toString("base64")]) {
      const res = await upload(data);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(NOT_A_PNG);
    }
    for (const name of ["../config.json", "x.png", "..%2Fconfig.json", "00000000-0000-0000-0000-000000000000.png"]) {
      expect((await runner.get(`/api/images/${name}`)).status).toBe(404);
    }
  });

  test("a session starts with its pictures: the event keeps them apart, the prompt lists each by its number", async () => {
    const a = ((await (await upload(PIXEL)).json()) as ImageUploadResponse).imagePath;
    const b = ((await (await upload(PIXEL)).json()) as ImageUploadResponse).imagePath;
    const res = await runner.post("/api/sessions", { workspace: "work", prompt: "Compare [Image #1] with [Image #2]", images: [a, b] });
    expect(res.status).toBe(201);
    const { session } = (await res.json()) as { session: { id: string } };
    const { events } = (await (await runner.get(`/api/sessions/${session.id}/events`)).json()) as EventsResponse;
    expect(events[0]).toMatchObject({ kind: "user", text: "Compare [Image #1] with [Image #2]", images: [a, b] });
  });

  test("a path the runner didn't save, a list too long, or not a list, is refused", async () => {
    const outside = join(runner.dir, "elsewhere.png");
    writeFileSync(outside, Buffer.from(PIXEL, "base64"));
    const a = ((await (await upload(PIXEL)).json()) as ImageUploadResponse).imagePath;
    for (const images of [[outside], ["/etc/passwd"], [`${a}/../../config.json`], "not a list", Array(MAX_IMAGES + 1).fill(a)]) {
      const res = await runner.post("/api/sessions", { workspace: "work", prompt: "look", images });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(BAD_IMAGES);
    }
  });

  test("the prompt the agent sees: the task, then each picture by its number and its path", () => {
    expect(promptWithImage("Fix it")).toBe("Fix it");
    expect(promptWithImage("Look at [Image #1]", undefined, ["/d/images/a.png"])).toBe("Look at [Image #1]\n\nAttached images (read these files):\n[Image #1]: /d/images/a.png");
    expect(promptWithImage("Snip", "/tmp/cleat/snip.png", ["/d/a.png", "/d/b.png"])).toBe(
      "Snip\n\nAttached image (read this file): /tmp/cleat/snip.png\n\nAttached images (read these files):\n[Image #1]: /d/a.png\n[Image #2]: /d/b.png",
    );
  });
});
