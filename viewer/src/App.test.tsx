import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import runsFixture from "./fixtures/runs.json";
import runDetailFixture from "./fixtures/run-detail.json";
import snapshotDetailFixture from "./fixtures/snapshot-detail.json";
import snapshotDetailRenderedFixture from "./fixtures/snapshot-detail-rendered.json";
import snapshotHistoryFixture from "./fixtures/snapshot-history.json";

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
    [`GET ${SNAPSHOT_URL}/history`]: { body: { history: [] } },
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

test("run list shows an empty-state message when there are no runs", async () => {
  routes["GET /api/runs"] = { body: { runs: [] } };
  render(<App />);

  await screen.findByText("No runs yet.");
  expect(screen.queryAllByRole("listitem").length).toBe(0);
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

test("process pending POSTs to the process endpoint, refetches, and updates statuses", async () => {
  routes[`POST /api/runs/${RUN_ID}/process`] = { body: runDetailFixture };
  await openRunDetail();
  await screen.findByText("checkout-page — 1280x720 — pending");

  const processedFixture = {
    ...runDetailFixture,
    snapshots: runDetailFixture.snapshots.map((s) => ({ ...s, status: "pass" })),
  };
  routes[`GET /api/runs/${RUN_ID}`] = { body: processedFixture };
  fireEvent.click(screen.getByRole("button", { name: "Process pending" }));

  await screen.findByText("checkout-page — 1280x720 — pass");
  expect(requests()).toContainEqual({ method: "POST", url: `/api/runs/${RUN_ID}/process` });
  const runGets = requests().filter(
    (r) => r.method === "GET" && r.url === `/api/runs/${RUN_ID}`,
  );
  expect(runGets.length).toBe(2); // mount fetch + post-process refetch
  expect(screen.queryByRole("button", { name: "Process pending" })).toBeNull();
});

test("process 500 shows the error and leaves statuses unchanged", async () => {
  routes[`POST /api/runs/${RUN_ID}/process`] = {
    status: 500,
    body: { error: "render engine unavailable" },
  };
  await openRunDetail();
  await screen.findByText("checkout-page — 1280x720 — pending");

  fireEvent.click(screen.getByRole("button", { name: "Process pending" }));

  await screen.findByText("Process failed (500): render engine unavailable");
  expect(screen.getByText("checkout-page — 1280x720 — pending")).toBeDefined();
});

test("approve success POSTs to the approve endpoint, refetches, and shows the new baseline", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = {
    body: {
      ...snapshotDetailRenderedFixture,
      status: "approved-baseline-missing",
      baselineUrl: null,
      diffUrl: null,
    },
  };
  routes[`POST ${SNAPSHOT_URL}/approve`] = { body: { name: SNAPSHOT_NAME, status: "pass" } };
  await openSnapshotDetail();
  await screen.findByText("Status: approved-baseline-missing");
  expect(screen.queryByAltText("baseline")).toBeNull();
  expect(screen.getAllByText("not available").length).toBe(2); // baseline + diff panes

  // After approve, the server reports "pass" with a real baseline image.
  routes[`GET ${SNAPSHOT_URL}`] = {
    body: { ...snapshotDetailRenderedFixture, status: "pass", diffUrl: null },
  };
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));

  await screen.findByText("Status: pass");
  expect(requests()).toContainEqual({ method: "POST", url: `${SNAPSHOT_URL}/approve` });
  const detailGets = requests().filter((r) => r.method === "GET" && r.url === SNAPSHOT_URL);
  expect(detailGets.length).toBe(2); // approve refetched the detail
  expect(screen.getByAltText("baseline").getAttribute("src")).toMatch(/\/images\/baseline$/);
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

test("snapshot detail renders history entries newest-first with correct image URLs", async () => {
  routes[`GET ${SNAPSHOT_URL}/history`] = { body: snapshotHistoryFixture };
  await openSnapshotDetail();

  const timestamps = snapshotHistoryFixture.history.map((entry) => entry.timestamp);
  // The fixture itself must be newest-first, matching the API contract.
  expect(timestamps).toEqual([...timestamps].sort().reverse());

  await screen.findByText(timestamps[0]);
  expect(requests()).toContainEqual({ method: "GET", url: `${SNAPSHOT_URL}/history` });
  expect(screen.queryByText("No history yet.")).toBeNull();

  const images = screen.getAllByAltText(/^history /);
  expect(images.length).toBe(timestamps.length);
  images.forEach((img, i) => {
    expect(img.getAttribute("src")).toBe(`${SNAPSHOT_URL}/history/${timestamps[i]}`);
  });

  // Entries render in the same (newest-first) order the API provided them.
  const renderedTimestamps = timestamps.map((ts) => screen.getByText(ts));
  const container = renderedTimestamps[0].parentElement!.parentElement!;
  const entryDivs = Array.from(container.children);
  renderedTimestamps.forEach((p, i) => {
    expect(entryDivs[i].contains(p)).toBe(true);
  });
});
