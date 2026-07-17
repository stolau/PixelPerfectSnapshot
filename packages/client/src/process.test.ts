import { afterEach, expect, test, vi } from "vitest";
import { processRun } from "./process.js";

const OPTS = { serverUrl: "http://localhost:8080", runId: "run/1 2" };

afterEach(() => {
  vi.unstubAllGlobals();
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
