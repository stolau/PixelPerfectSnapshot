import { afterEach, expect, test, vi } from "vitest";
import { createRun } from "./run.js";

const OPTS = { serverUrl: "http://localhost:8080" };

afterEach(() => {
  vi.unstubAllGlobals();
});

test("POSTs once to the runs URL and resolves to the created run", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"id":"run-1","createdAt":"2026-01-01T00:00:00Z"}', {
      status: 201,
    });
  });

  await expect(createRun(OPTS)).resolves.toEqual({
    id: "run-1",
    createdAt: "2026-01-01T00:00:00Z",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://localhost:8080/api/runs");
  expect(calls[0].init.method).toBe("POST");
});

test("throws on a non-2xx response with the status and body text in the message", async () => {
  vi.stubGlobal("fetch", async () => new Response('{"error":"boom"}', { status: 500 }));

  const err = await createRun(OPTS).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toContain("500");
  expect(err!.message).toContain('{"error":"boom"}');
});
