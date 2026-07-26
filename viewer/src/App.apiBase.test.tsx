import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import runsFixture from "./fixtures/runs.json";
import runDetailFixture from "./fixtures/run-detail.json";
import snapshotDetailRenderedFixture from "./fixtures/snapshot-detail-rendered.json";

const RUN_ID = runDetailFixture.id; // "run-2", first (newest) entry in runs.json
const SNAPSHOT_NAME = snapshotDetailRenderedFixture.name; // "checkout-page"

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

test("with VITE_API_BASE=/backend, API calls and image srcs carry the prefix", async () => {
  // API_BASE is read at api.ts module scope, so stub the env before a fresh import.
  vi.stubEnv("VITE_API_BASE", "/backend");
  vi.resetModules();
  const { App } = await import("./App.js");

  const routes: Record<string, { body?: unknown; blob?: boolean }> = {
    "GET /backend/api/runs": { body: runsFixture },
    [`GET /backend/api/runs/${RUN_ID}`]: { body: runDetailFixture },
    [`GET /backend/api/runs/${RUN_ID}/snapshots/${SNAPSHOT_NAME}`]: {
      body: snapshotDetailRenderedFixture,
    },
    [`GET /backend${snapshotDetailRenderedFixture.baselineUrl}`]: { blob: true },
    [`GET /backend${snapshotDetailRenderedFixture.candidateUrl}`]: { blob: true },
    [`GET /backend${snapshotDetailRenderedFixture.diffUrl}`]: { blob: true },
  };
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const route = routes[`${init?.method ?? "GET"} ${url}`];
      if (route === undefined) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (route.blob === true) {
        return new Response(new Blob(["fake-image-bytes"]), { status: 200 });
      }
      return new Response(JSON.stringify(route.body), { status: 200 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);

  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Jul 15, 09:30/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^checkout-page/ }));

  await screen.findByText("Status: fail");
  // The rendered <img> src becomes a blob: object URL (see AuthenticatedImage); what proves the
  // prefix was actually applied is the underlying fetch URL.
  await waitFor(() => {
    for (const img of screen.getAllByRole("img")) {
      expect(img.getAttribute("src")).toMatch(/^blob:/);
    }
  });
  expect(fetchMock.mock.calls.map((c) => c[0])).toContain(
    `/backend${snapshotDetailRenderedFixture.baselineUrl}`,
  );
  expect(fetchMock.mock.calls.map((c) => c[0])).toContain(
    `/backend${snapshotDetailRenderedFixture.candidateUrl}`,
  );
  // Diff isn't fetched by default (dual view shows baseline + candidate only); the prefix
  // behavior for it is already proven by the candidate/baseline assertions above.
});
