import { afterEach, expect, test, vi } from "vitest";
import { processRun } from "./process.js";

const OPTS = { serverUrl: "http://localhost:8080", runId: "run/1 2" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("POSTs once to the run's process URL with the runId encoded", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"id":"run/1 2","createdAt":"2026-01-01T00:00:00Z","snapshots":[]}', {
      status: 200,
    });
  });

  await expect(processRun(OPTS)).resolves.toBeUndefined();

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://localhost:8080/api/runs/run%2F1%202/process");
  expect(calls[0].init.method).toBe("POST");
});

test("throws on a non-2xx response with the status, body text and run id in the message", async () => {
  vi.stubGlobal(
    "fetch",
    async () => new Response('{"error":"run not found"}', { status: 404 }),
  );

  const err = await processRun(OPTS).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toContain("404");
  expect(err!.message).toContain('{"error":"run not found"}');
  expect(err!.message).toContain("run/1 2");
});

test("an explicit serverUrl wins even when PPS_SERVER_URL is also set", async () => {
  vi.stubEnv("PPS_SERVER_URL", "http://env-server");
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return new Response('{"id":"run/1 2","createdAt":"2026-01-01T00:00:00Z","snapshots":[]}', {
      status: 200,
    });
  });

  await processRun(OPTS);

  expect(calls[0]).toBe("http://localhost:8080/api/runs/run%2F1%202/process");
});

test("falls back to PPS_SERVER_URL when opts.serverUrl is omitted", async () => {
  vi.stubEnv("PPS_SERVER_URL", "http://env-server");
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return new Response('{"id":"run/1 2","createdAt":"2026-01-01T00:00:00Z","snapshots":[]}', {
      status: 200,
    });
  });

  await processRun({ runId: OPTS.runId });

  expect(calls[0]).toBe("http://env-server/api/runs/run%2F1%202/process");
});

test("throws a clear error when neither opts.serverUrl nor PPS_SERVER_URL is set", async () => {
  vi.stubEnv("PPS_SERVER_URL", undefined);

  const err = await processRun({ runId: OPTS.runId }).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toContain("serverUrl");
  expect(err!.message).toContain("PPS_SERVER_URL");
});

test("sends no Authorization header when neither opts.token nor PPS_API_TOKEN is set", async () => {
  vi.stubEnv("PPS_API_TOKEN", undefined);
  const calls: { init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push({ init });
    return new Response('{"id":"run/1 2","createdAt":"2026-01-01T00:00:00Z","snapshots":[]}', {
      status: 200,
    });
  });

  await processRun(OPTS);

  expect(calls[0].init.headers).toBeUndefined();
});

test("an explicit token wins even when PPS_API_TOKEN is also set", async () => {
  vi.stubEnv("PPS_API_TOKEN", "env-token");
  const calls: { init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push({ init });
    return new Response('{"id":"run/1 2","createdAt":"2026-01-01T00:00:00Z","snapshots":[]}', {
      status: 200,
    });
  });

  await processRun({ ...OPTS, token: "explicit-token" });

  expect(calls[0].init.headers).toEqual({ Authorization: "Bearer explicit-token" });
});

test("falls back to PPS_API_TOKEN when opts.token is omitted", async () => {
  vi.stubEnv("PPS_API_TOKEN", "env-token");
  const calls: { init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push({ init });
    return new Response('{"id":"run/1 2","createdAt":"2026-01-01T00:00:00Z","snapshots":[]}', {
      status: 200,
    });
  });

  await processRun(OPTS);

  expect(calls[0].init.headers).toEqual({ Authorization: "Bearer env-token" });
});
