// The build id: what /health reports, and when it changes.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildId } from "../../src/runner/build";
import { loadConfig } from "../../src/runner/config";
import { startServer } from "../../src/runner/server";
import type { HealthResponse } from "../../src/shared/protocol";
import { testRunner } from "./helpers";

function fakeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "cleat-build-"));
  for (const dir of ["src/runner", "src/shared", "src/web", "src/cli"]) mkdirSync(join(repo, dir), { recursive: true });
  writeFileSync(join(repo, "src/runner/server.ts"), "one");
  writeFileSync(join(repo, "src/web/dock.html"), "<p>");
  writeFileSync(join(repo, "package.json"), "{}");
  return repo;
}

describe("the build id", () => {
  test("is a short hash, the same for the same code", () => {
    const repo = fakeRepo();
    expect(buildId(null, repo)).toMatch(/^[0-9a-f]{12}$/);
    expect(buildId(null, repo)).toBe(buildId(null, repo));
    expect(buildId()).toMatch(/^[0-9a-f]{12}$/);
  });

  test("changes when the runner's code, the pages, the contract or the dependencies change, or a file is added", () => {
    const repo = fakeRepo();
    const seen = new Set([buildId(null, repo)]);
    const change = (file: string, text: string) => {
      writeFileSync(join(repo, file), text);
      const id = buildId(null, repo);
      expect(`${file}: ${seen.has(id)}`).toBe(`${file}: false`);
      seen.add(id);
    };
    change("src/runner/server.ts", "two");
    change("src/web/dock.html", "<p>dock");
    change("src/shared/protocol.ts", "contract");
    change("package.json", '{"a":1}');
    change("bun.lock", "lock");
    change("src/runner/new.ts", "");
  });

  test("does not change when a file is only touched, or when the command line's code changes", () => {
    const repo = fakeRepo();
    const before = buildId(null, repo);
    utimesSync(join(repo, "src/runner/server.ts"), new Date(), new Date(Date.now() + 60_000));
    writeFileSync(join(repo, "src/cli/runner.ts"), "the command, not the runner");
    expect(buildId(null, repo)).toBe(before);
  });

  test("CLEAT_BUILD_ID replaces it, through the config", async () => {
    expect(buildId("given")).toBe("given");
    const runner = testRunner();
    await runner.stop();
    expect(loadConfig({ ...runner.env, CLEAT_BUILD_ID: "given" }).buildId).toBe("given");
    expect(loadConfig(runner.env).buildId).toBeNull();
  });
});

describe("GET /health", () => {
  const runner = testRunner();
  const dir = mkdtempSync(join(tmpdir(), "cleat-build-runner-"));
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ workspaces: [{ name: "work", path: join(dir, "work") }] }));
  const given = startServer(loadConfig({ CLEAT_CONFIG: join(dir, "config.json"), CLEAT_DATA_DIR: join(dir, "data"), CLEAT_PORT: "0", CLEAT_BUILD_ID: "given" }));
  afterAll(async () => {
    await runner.stop();
    await given.stop();
  });

  test("says ok, the version and the build id of the code the runner loaded", async () => {
    const body = (await (await runner.get("/health")).json()) as HealthResponse;
    expect(body).toEqual({ ok: true, version: expect.any(String), build: buildId() });
  });

  test("a runner started with CLEAT_BUILD_ID reports that", async () => {
    expect(((await (await fetch(`${given.url}/health`)).json()) as HealthResponse).build).toBe("given");
  });
});
