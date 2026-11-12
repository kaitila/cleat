import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/runner/config";
import { startServer } from "../src/runner/server";

const dir = mkdtempSync(join(tmpdir(), "intuition-test-"));
const env = { INTUITION_CONFIG: join(dir, "config.json"), INTUITION_DATA_DIR: join(dir, "data"), INTUITION_PORT: "0" };

describe("config", () => {
  test("writes the default file with the two workspaces, and marks a missing folder", () => {
    const config = loadConfig(env);
    expect(config.workspaces.map((w) => w.name)).toEqual(["agents", "theta"]);
    expect(JSON.parse(readFileSync(env.INTUITION_CONFIG, "utf8")).workspaces).toHaveLength(2);
    expect(config.workspaces.every((w) => w.path.startsWith("/"))).toBe(true);
    expect(loadConfig({ ...env, INTUITION_CONFIG: join(dir, "c2.json") }).port).toBe(0);
  });
});

describe("server", () => {
  const runner = startServer(loadConfig(env));
  afterAll(() => runner.stop());

  test("answers /health on 127.0.0.1", async () => {
    const res = await fetch(`${runner.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test("refuses another site's origin, another host, and a form post", async () => {
    expect((await fetch(`${runner.url}/health`, { headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(`${runner.url}/health`, { headers: { host: "evil.test" } })).status).toBe(403);
    expect((await fetch(`${runner.url}/api/sessions`, { method: "POST", body: "a=1", headers: { "content-type": "text/plain" } })).status).toBe(403);
    expect((await fetch(`${runner.url}/health`, { headers: { origin: runner.url } })).status).toBe(200);
  });

  test("does not serve files outside src/web", async () => {
    expect((await fetch(`${runner.url}/assets/..%2Frunner%2Fmain.ts`)).status).toBe(404);
  });
});
