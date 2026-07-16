import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import runsFixture from "./fixtures/runs.json";
import runDetailFixture from "./fixtures/run-detail.json";
import snapshotDetailFixture from "./fixtures/snapshot-detail.json";
import snapshotDetailRenderedFixture from "./fixtures/snapshot-detail-rendered.json";

const RUN_ID = runDetailFixture.id; // "run-2", first (newest) entry in runs.json
const SNAPSHOT_NAME = snapshotDetailFixture.name; // "checkout-page"
const SNAPSHOT_URL = `/api/runs/${RUN_ID}/snapshots/${SNAPSHOT_NAME}`;

interface Route {
  status?: number;
  body: unknown;
}

let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {
    "GET /api/runs": { body: runsFixture },
    [`GET /api/runs/${RUN_ID}`]: { body: runDetailFixture },
    [`GET ${SNAPSHOT_URL}`]: { body: snapshotDetailFixture },
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const route = routes[`${method} ${url}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every (method, url) pair the app actually sent. */
function requests(): { method: string; url: string }[] {
  return fetchMock.mock.calls.map((call) => {
    const [input, init] = call as [RequestInfo | URL, RequestInit | undefined];
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return { method: init?.method ?? "GET", url };
  });
}

async function openRunDetail() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /2026-07-15T09:30:00Z/ }));
}

async function openSnapshotDetail() {
  await openRunDetail();
  fireEvent.click(await screen.findByRole("button", { name: /^checkout-page/ }));
}

test("renders the app heading", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "PixelPerfectSnapshot" })).toBeDefined();
});

test("run list renders runs from GET /api/runs, newest first", async () => {
  render(<App />);

  await screen.findByText("2026-07-15T09:30:00Z — 3 snapshots");
  await screen.findByText("2026-07-14T18:00:00Z — 1 snapshots");
  expect(requests()).toContainEqual({ method: "GET", url: "/api/runs" });

  const items = screen.getAllByRole("listitem");
  expect(items.length).toBe(2);
  expect(items[0].textContent).toContain("2026-07-15T09:30:00Z");
  expect(items[1].textContent).toContain("2026-07-14T18:00:00Z");
});

test("run detail renders each snapshot's name and status", async () => {
  await openRunDetail();

  await screen.findByText("checkout-page — 1280x720 — pending");
  screen.getByText("login-page — 1280x720 — fail");
  screen.getByText("landing-page — 375x812 — approved-baseline-missing");
  expect(requests()).toContainEqual({ method: "GET", url: `/api/runs/${RUN_ID}` });
});

test("snapshot detail with null URLs shows three placeholders and no images", async () => {
  await openSnapshotDetail();

  await screen.findByText("Status: pending");
  expect(requests()).toContainEqual({ method: "GET", url: SNAPSHOT_URL });
  expect(screen.getAllByText("not available").length).toBe(3);
  expect(document.querySelectorAll("img").length).toBe(0);
});

test("snapshot detail with rendered URLs shows baseline, candidate, and diff images", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  await openSnapshotDetail();

  await screen.findByText("Status: fail");
  const images = screen.getAllByRole("img");
  expect(images.length).toBe(3);
  expect(screen.getByAltText("baseline").getAttribute("src")).toMatch(/\/images\/baseline$/);
  expect(screen.getByAltText("candidate").getAttribute("src")).toMatch(/\/images\/candidate$/);
  expect(screen.getByAltText("diff").getAttribute("src")).toMatch(/\/images\/diff$/);
  expect(screen.queryAllByText("not available").length).toBe(0);
});

test("approve success POSTs to the approve endpoint and updates status to pass", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  routes[`POST ${SNAPSHOT_URL}/approve`] = { body: { name: SNAPSHOT_NAME, status: "pass" } };
  await openSnapshotDetail();
  await screen.findByText("Status: fail");

  fireEvent.click(screen.getByRole("button", { name: "Approve" }));

  await screen.findByText("Status: pass");
  expect(requests()).toContainEqual({ method: "POST", url: `${SNAPSHOT_URL}/approve` });
});

test("approve 501 shows the error and leaves status unchanged", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  routes[`POST ${SNAPSHOT_URL}/approve`] = {
    status: 501,
    body: { error: "Not Implemented" },
  };
  await openSnapshotDetail();
  await screen.findByText("Status: fail");

  fireEvent.click(screen.getByRole("button", { name: "Approve" }));

  await screen.findByText("Approve failed (501): Not Implemented");
  expect(screen.getByText("Status: fail")).toBeDefined();
  expect(screen.queryByText("Status: pass")).toBeNull();
});
