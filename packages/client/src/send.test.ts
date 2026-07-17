import { afterEach, expect, test, vi } from "vitest";
import type { Snapshot } from "./index.js";
import { sendSnapshots } from "./send.js";

function snap(name: string): Snapshot {
  return {
    formatVersion: 0,
    name,
    viewport: { width: 800, height: 600 },
    html: `<html><body>${name}</body></html>`,
    stylesheets: [{ href: "http://localhost/main.css", content: "body{margin:0}" }],
  };
}

const OPTS = { serverUrl: "http://localhost:8080", runId: "run/1 2" };

afterEach(() => {
  vi.unstubAllGlobals();
});

test("POSTs each snapshot as JSON to the run's snapshots URL with the runId encoded", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('{"name":"x","status":"pending"}', { status: 201 });
  });

  await expect(sendSnapshots([snap("a"), snap("b")], OPTS)).resolves.toBeUndefined();

  expect(calls.map((c) => c.url)).toEqual([
    "http://localhost:8080/api/runs/run%2F1%202/snapshots",
    "http://localhost:8080/api/runs/run%2F1%202/snapshots",
  ]);
  for (const { init } of calls) {
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  }
  expect(JSON.parse(calls[0].init.body as string)).toEqual(snap("a"));
  expect(JSON.parse(calls[1].init.body as string)).toEqual(snap("b"));
});

test("uploads sequentially: second POST does not start before the first resolves", async () => {
  let resolveFirst!: (res: Response) => void;
  const urls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    urls.push(url);
    if (urls.length === 1) {
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Promise.resolve(new Response("", { status: 201 }));
  });

  const done = sendSnapshots([snap("a"), snap("b")], OPTS);
  // Give any (incorrect) parallel second POST every chance to fire.
  await new Promise((r) => setTimeout(r, 20));
  expect(urls).toHaveLength(1);

  resolveFirst(new Response("", { status: 201 }));
  await done;
  expect(urls).toHaveLength(2);
});

test("throws on a non-2xx response with the status and the body text in the message", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return new Response('{"error":"duplicate snapshot name in run"}', { status: 409 });
  });

  const err = await sendSnapshots([snap("dup"), snap("never-sent")], OPTS).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toContain("409");
  expect(err!.message).toContain("duplicate snapshot name in run");
  expect(err!.message).toContain("dup");
  // Failed first upload stops the batch.
  expect(urls).toHaveLength(1);
});
