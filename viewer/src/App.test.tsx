import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import { AuthenticatedImage } from "./AuthenticatedImage.js";
import { setAuthToken } from "./authToken.js";
import { categoryColor } from "./categoryColor.js";
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
  body?: unknown;
  /** When true, respond with a Blob body instead of JSON — for AuthenticatedImage fetches. */
  blob?: boolean;
}

function blobRoute(status?: number): Route {
  return { blob: true, status };
}

let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {
    "GET /api/runs": { body: runsFixture },
    [`GET /api/runs/${RUN_ID}`]: { body: runDetailFixture },
    [`GET ${SNAPSHOT_URL}`]: { body: snapshotDetailFixture },
    [`GET ${SNAPSHOT_URL}/history`]: { body: { history: [] } },
    [`GET ${SNAPSHOT_URL}/masks`]: { body: { masks: [] } },
    [`GET ${SNAPSHOT_URL}/masks/own`]: { body: { masks: [] } },
    "GET /api/masks": { body: { masks: [] } },
    "GET /api/categories": { body: { categories: [] } },
    // AuthenticatedImage fetches these directly; most tests that swap in the rendered snapshot
    // fixture render baseline/candidate/diff images and need them to resolve successfully.
    [`GET ${snapshotDetailRenderedFixture.baselineUrl}`]: blobRoute(),
    [`GET ${snapshotDetailRenderedFixture.candidateUrl}`]: blobRoute(),
    [`GET ${snapshotDetailRenderedFixture.diffUrl}`]: blobRoute(),
  };
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const route = routes[`${method} ${url}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    if (route.blob === true) {
      return new Response(new Blob(["fake-image-bytes"]), { status: route.status ?? 200 });
    }
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
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
  fireEvent.click(await screen.findByRole("button", { name: /Jul 15, 09:30/ }));
}

async function openSnapshotDetail() {
  await openRunDetail();
  fireEvent.click(await screen.findByRole("button", { name: /^checkout-page/ }));
}

/**
 * jsdom has no real layout engine: getBoundingClientRect() and clientWidth/clientHeight
 * are 0 by default on every element. Stub them on HTMLDivElement.prototype so the
 * mask-overlay div (and only it, in practice, since it's the only div these tests
 * interact with) reports a concrete size, giving the drag math a real, non-degenerate
 * scale factor to work with. Returns a restore function to undo the stubbing.
 */
function stubOverlayLayout(): () => void {
  const rectSpy = vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  } as DOMRect);
  Object.defineProperty(HTMLDivElement.prototype, "clientWidth", {
    configurable: true,
    value: 200,
  });
  Object.defineProperty(HTMLDivElement.prototype, "clientHeight", {
    configurable: true,
    value: 100,
  });
  return () => {
    rectSpy.mockRestore();
    delete (HTMLDivElement.prototype as { clientWidth?: number }).clientWidth;
    delete (HTMLDivElement.prototype as { clientHeight?: number }).clientHeight;
  };
}

/** Fires load on the candidate <img> with a fixed natural size (100x50, i.e. a 2x scale
 * against the 200x100 overlay stubbed by stubOverlayLayout). */
function loadCandidateImage(img: HTMLElement) {
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: 100 });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: 50 });
  fireEvent.load(img);
}

/** Drags from displayed-space (0,0) to (100,50), which at the 2x scale set up by
 * stubOverlayLayout + loadCandidateImage resolves to the native rect (0,0,50,25). */
function dragOverlay(overlay: HTMLElement) {
  fireEvent.mouseDown(overlay, { clientX: 0, clientY: 0 });
  fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });
  fireEvent.mouseUp(overlay);
}

/** Finds the (method, url) POST/DELETE call and returns its parsed JSON body. */
function requestBody(method: string, url: string): unknown {
  const call = fetchMock.mock.calls.find((c) => {
    const [input, init] = c as [RequestInfo | URL, RequestInit | undefined];
    const callUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return callUrl === url && (init?.method ?? "GET") === method;
  });
  if (call === undefined) throw new Error(`no ${method} ${url} call found`);
  const init = call[1] as RequestInit | undefined;
  return JSON.parse(init?.body as string);
}

test("renders the app heading", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "PixelPerfectSnapshot" })).toBeDefined();
});

test("run list renders runs from GET /api/runs, newest first, with verdict/build number/counts", async () => {
  render(<App />);

  await screen.findByText(/Jul 15, 09:30/);
  expect(requests()).toContainEqual({ method: "GET", url: "/api/runs" });

  const items = screen.getAllByRole("listitem");
  expect(items.length).toBe(2);

  // Newest first: run-2 is item 0 (build number 2, since it's the more recent of 2 runs).
  expect(items[0].textContent).toContain("Run #2");
  expect(items[0].textContent).toContain("Jul 15, 09:30");
  expect(items[0].textContent).toContain("3 snapshots");
  expect(items[0].textContent).toContain("fail");
  expect(items[0].textContent).toContain("+1 new");
  expect(items[0].textContent).not.toContain("missing");

  // Oldest run is #1.
  expect(items[1].textContent).toContain("Run #1");
  expect(items[1].textContent).toContain("Jul 14, 18:00");
  expect(items[1].textContent).toContain("1 snapshots");
  expect(items[1].textContent).toContain("pending");
  expect(items[1].textContent).toContain("-2 missing");
  expect(items[1].textContent).not.toContain("new");
});

test("run list shows a color-coded verdict pill per run", async () => {
  render(<App />);
  await screen.findByText(/Jul 15, 09:30/);

  const failPill = screen.getByTestId("run-status-pill-run-2");
  const pendingPill = screen.getByTestId("run-status-pill-run-1");
  expect(failPill.textContent).toBe("fail");
  expect(pendingPill.textContent).toBe("pending");
  expect(failPill.className).not.toBe(pendingPill.className);
});

test("run list hides the new/removed summary when both counts are zero", async () => {
  routes["GET /api/runs"] = {
    body: {
      runs: [
        {
          id: "run-3",
          createdAt: "2026-07-16T10:00:00Z",
          scope: null,
          snapshotCount: 1,
          status: "pass",
          newCount: 0,
          removedCount: 0,
        },
      ],
    },
  };
  render(<App />);
  await screen.findByText(/Jul 16, 10:00/);

  expect(screen.queryByText(/new/)).toBeNull();
  expect(screen.queryByText(/missing/)).toBeNull();
});

test("run list shows an empty-state message when there are no runs", async () => {
  routes["GET /api/runs"] = { body: { runs: [] } };
  render(<App />);

  await screen.findByText("No runs yet.");
  expect(screen.queryAllByRole("listitem").length).toBe(0);
});

test("run list shows a scope tag for branch/release runs but not master runs", async () => {
  routes["GET /api/runs"] = {
    body: {
      runs: [
        {
          id: "run-b",
          createdAt: "2026-07-16T10:00:00Z",
          scope: { kind: "branch", id: "feature-x" },
          snapshotCount: 1,
          status: "pass",
          newCount: 0,
          removedCount: 0,
        },
        {
          id: "run-m",
          createdAt: "2026-07-15T10:00:00Z",
          scope: null,
          snapshotCount: 1,
          status: "pass",
          newCount: 0,
          removedCount: 0,
        },
      ],
    },
  };
  render(<App />);
  await screen.findByText(/Jul 16, 10:00/);

  const items = screen.getAllByRole("listitem");
  expect(items[0].textContent).toContain("branch: feature-x");
  expect(items[1].textContent).not.toContain("branch:");
  expect(items[1].textContent).not.toContain("release:");
});

test("Branches & Releases: lists branches/releases, empty states, and filters the run list on click", async () => {
  routes["GET /api/runs"] = {
    body: {
      runs: [
        {
          id: "run-c",
          createdAt: "2026-07-17T10:00:00Z",
          scope: { kind: "branch", id: "feature-x" },
          snapshotCount: 1,
          status: "pass",
          newCount: 0,
          removedCount: 0,
        },
        {
          id: "run-b",
          createdAt: "2026-07-16T10:00:00Z",
          scope: null,
          snapshotCount: 1,
          status: "pass",
          newCount: 0,
          removedCount: 0,
        },
        {
          id: "run-a",
          createdAt: "2026-07-15T10:00:00Z",
          scope: { kind: "release", id: "v1" },
          snapshotCount: 1,
          status: "pass",
          newCount: 0,
          removedCount: 0,
        },
      ],
    },
  };
  routes["GET /api/branches"] = { body: { branches: ["feature-x"] } };
  routes["GET /api/releases"] = {
    body: { releases: [{ id: "v1", createdAt: "2026-07-10T09:00:00Z" }] },
  };
  render(<App />);
  await screen.findByText(/Jul 17, 10:00/);

  fireEvent.click(screen.getByRole("button", { name: "Branches & Releases" }));
  await screen.findByRole("heading", { name: "Branches & Releases" });
  expect(await screen.findByRole("button", { name: "feature-x" })).toBeDefined();
  expect(
    await screen.findByRole("button", { name: /v1 — Jul 10, 09:00/ }),
  ).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "feature-x" }));

  await screen.findByRole("heading", { name: "Branch: feature-x" });
  const items = screen.getAllByRole("listitem");
  expect(items.length).toBe(1);
  // The filtered run keeps its TRUE global build number (#3, oldest-first across all 3 runs),
  // not a renumbered #1 local to the one-item filtered subset.
  expect(items[0].textContent).toContain("Run #3");

  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("heading", { name: "Branches & Releases" });
});

test("Branches & Releases shows empty states when nothing exists yet", async () => {
  routes["GET /api/branches"] = { body: { branches: [] } };
  routes["GET /api/releases"] = { body: { releases: [] } };
  render(<App />);
  await screen.findByText(/Jul 15, 09:30/);

  fireEvent.click(screen.getByRole("button", { name: "Branches & Releases" }));

  await screen.findByText("No branch-scoped runs yet.");
  expect(screen.getByText("No releases yet.")).toBeDefined();
});

test("run detail renders each snapshot's name and status", async () => {
  await openRunDetail();

  await screen.findByText("checkout-page — 1280x720 — pending");
  screen.getByText("login-page — 1280x720 — fail");
  screen.getByText("landing-page — 375x812 — approved-baseline-missing");
  expect(requests()).toContainEqual({ method: "GET", url: `/api/runs/${RUN_ID}` });
});

test("bulk-approve checkbox only appears on approved-baseline-missing rows", async () => {
  await openRunDetail();
  await screen.findByText("checkout-page — 1280x720 — pending");

  expect(screen.getByLabelText("Select landing-page")).toBeDefined();
  expect(screen.queryByLabelText("Select checkout-page")).toBeNull();
  expect(screen.queryByLabelText("Select login-page")).toBeNull();
  expect(screen.queryByRole("button", { name: /Approve selected/ })).toBeNull();
});

test("selecting an eligible snapshot and approving it POSTs to its approve endpoint, refetches, and reports the result", async () => {
  routes[`POST /api/runs/${RUN_ID}/snapshots/landing-page/approve`] = {
    body: { name: "landing-page", status: "pass" },
  };
  await openRunDetail();
  await screen.findByText("checkout-page — 1280x720 — pending");

  fireEvent.click(screen.getByLabelText("Select landing-page"));
  const approveButton = await screen.findByRole("button", { name: "Approve selected (1)" });

  routes[`GET /api/runs/${RUN_ID}`] = {
    body: {
      ...runDetailFixture,
      snapshots: runDetailFixture.snapshots.map((s) =>
        s.name === "landing-page" ? { ...s, status: "pass" } : s,
      ),
    },
  };
  fireEvent.click(approveButton);

  await screen.findByText("1 approved");
  expect(requests()).toContainEqual({
    method: "POST",
    url: `/api/runs/${RUN_ID}/snapshots/landing-page/approve`,
  });
  // Selection clears and the row is no longer eligible, so the checkbox and button both go away.
  expect(screen.queryByLabelText("Select landing-page")).toBeNull();
  expect(screen.queryByRole("button", { name: /Approve selected/ })).toBeNull();
});

test("bulk approve continues through a partial failure and reports both outcomes", async () => {
  const twoEligible = {
    ...runDetailFixture,
    snapshots: [
      ...runDetailFixture.snapshots,
      { name: "other-page", viewport: { width: 100, height: 100 }, status: "approved-baseline-missing" },
    ],
  };
  routes[`GET /api/runs/${RUN_ID}`] = { body: twoEligible };
  routes[`POST /api/runs/${RUN_ID}/snapshots/landing-page/approve`] = {
    status: 409,
    body: { error: "no candidate image exists yet" },
  };
  routes[`POST /api/runs/${RUN_ID}/snapshots/other-page/approve`] = {
    body: { name: "other-page", status: "pass" },
  };
  await openRunDetail();
  await screen.findByText("checkout-page — 1280x720 — pending");

  fireEvent.click(screen.getByLabelText("Select landing-page"));
  fireEvent.click(screen.getByLabelText("Select other-page"));
  fireEvent.click(await screen.findByRole("button", { name: "Approve selected (2)" }));

  await screen.findByText("1 approved, 1 failed");
  expect(screen.getByText(/landing-page: \(409\)/)).toBeDefined();
  // Both attempts happened -- one failure did not stop the other from running.
  expect(requests()).toContainEqual({
    method: "POST",
    url: `/api/runs/${RUN_ID}/snapshots/landing-page/approve`,
  });
  expect(requests()).toContainEqual({
    method: "POST",
    url: `/api/runs/${RUN_ID}/snapshots/other-page/approve`,
  });
});

test("snapshot detail with null URLs shows two placeholders (dual view: baseline + candidate) and no images", async () => {
  await openSnapshotDetail();

  await screen.findByText("Status: pending");
  expect(requests()).toContainEqual({ method: "GET", url: SNAPSHOT_URL });
  expect(screen.getAllByText("not available").length).toBe(2);
  // Not a blanket "no <img> anywhere" check -- the persistent nav-bar logo is legitimately
  // always present. Scoped to the snapshot images this test actually cares about.
  expect(screen.queryByAltText("baseline")).toBeNull();
  expect(screen.queryByAltText("candidate")).toBeNull();
  expect(screen.queryByAltText("diff")).toBeNull();
});

test("snapshot detail with rendered URLs shows baseline and candidate (dual view default; diff is opt-in)", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  await openSnapshotDetail();

  await screen.findByText("Status: fail");
  const images = screen.getAllByRole("img");
  expect(images.length).toBe(2);
  // The rendered <img> src is a blob: object URL (see AuthenticatedImage); what actually proves
  // the right resource was requested is the underlying authenticated fetch.
  await waitFor(() => {
    expect(screen.getByAltText("baseline").getAttribute("src")).toMatch(/^blob:/);
    expect(screen.getByAltText("candidate").getAttribute("src")).toMatch(/^blob:/);
  });
  expect(requests()).toContainEqual({
    method: "GET",
    url: snapshotDetailRenderedFixture.baselineUrl,
  });
  expect(requests()).toContainEqual({
    method: "GET",
    url: snapshotDetailRenderedFixture.candidateUrl,
  });
  // Diff isn't fetched until "Show diff" is toggled on.
  expect(requests()).not.toContainEqual({
    method: "GET",
    url: snapshotDetailRenderedFixture.diffUrl,
  });
  expect(screen.queryAllByText("not available").length).toBe(0);
});

test("Show diff toggle swaps the candidate pane to the diff image", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  await openSnapshotDetail();

  await screen.findByAltText("candidate");
  expect(screen.queryByAltText("diff")).toBeNull();

  fireEvent.click(screen.getByLabelText("Show diff"));

  await screen.findByAltText("diff");
  expect(screen.queryByAltText("candidate")).toBeNull();
  await waitFor(() => {
    expect(requests()).toContainEqual({
      method: "GET",
      url: snapshotDetailRenderedFixture.diffUrl,
    });
  });
});

test("Single view shows one image at a time via Baseline/Candidate tabs", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  await openSnapshotDetail();
  await screen.findByAltText("candidate");

  fireEvent.click(screen.getByRole("button", { name: "Single" }));

  expect(screen.queryByAltText("baseline")).toBeNull();
  await screen.findByAltText("candidate");

  fireEvent.click(screen.getByRole("button", { name: "Baseline" }));

  await screen.findByAltText("baseline");
  expect(screen.queryByAltText("candidate")).toBeNull();
});

test("Single view's Baseline tab is disabled when there is no baseline yet", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = {
    body: { ...snapshotDetailRenderedFixture, status: "approved-baseline-missing", baselineUrl: null },
  };
  await openSnapshotDetail();
  await screen.findByAltText("candidate");

  fireEvent.click(screen.getByRole("button", { name: "Single" }));

  const baselineTab = screen.getByRole("button", { name: "Baseline" }) as HTMLButtonElement;
  expect(baselineTab.disabled).toBe(true);

  // Clicking a disabled button is a no-op in the DOM, but assert the view doesn't switch either.
  fireEvent.click(baselineTab);
  await screen.findByAltText("candidate");
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
  expect(screen.getAllByText("not available").length).toBe(1); // baseline pane only (dual view)

  // After approve, the server reports "pass" with a real baseline image.
  routes[`GET ${SNAPSHOT_URL}`] = {
    body: { ...snapshotDetailRenderedFixture, status: "pass", diffUrl: null },
  };
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));

  await screen.findByText("Status: pass");
  expect(requests()).toContainEqual({ method: "POST", url: `${SNAPSHOT_URL}/approve` });
  const detailGets = requests().filter((r) => r.method === "GET" && r.url === SNAPSHOT_URL);
  expect(detailGets.length).toBe(2); // approve refetched the detail
  await waitFor(() => {
    expect(screen.getByAltText("baseline").getAttribute("src")).toMatch(/^blob:/);
  });
  expect(requests()).toContainEqual({
    method: "GET",
    url: snapshotDetailRenderedFixture.baselineUrl,
  });
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

test("Approve checkmark is disabled once status is pass -- a passing snapshot has nothing pending to approve", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = {
    body: { ...snapshotDetailRenderedFixture, status: "pass", diffUrl: null },
  };
  await openSnapshotDetail();
  await screen.findByText("Status: pass");

  const approveButton = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
  expect(approveButton.disabled).toBe(true);

  fireEvent.click(approveButton);
  expect(requests()).not.toContainEqual(
    expect.objectContaining({ method: "POST", url: `${SNAPSHOT_URL}/approve` }),
  );
});

test("Approve checkmark stays enabled for a fail status", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture }; // status: "fail"
  await openSnapshotDetail();
  await screen.findByText("Status: fail");
  expect(
    (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("Approve checkmark stays enabled for an approved-baseline-missing status", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = {
    body: { ...snapshotDetailRenderedFixture, status: "approved-baseline-missing", baselineUrl: null },
  };
  await openSnapshotDetail();
  await screen.findByText("Status: approved-baseline-missing");
  expect(
    (screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("snapshot detail renders history entries newest-first with correct image URLs", async () => {
  routes[`GET ${SNAPSHOT_URL}/history`] = { body: snapshotHistoryFixture };
  const timestamps = snapshotHistoryFixture.history.map((entry) => entry.timestamp);
  for (const ts of timestamps) {
    routes[`GET ${SNAPSHOT_URL}/history/${ts}`] = blobRoute();
  }
  await openSnapshotDetail();

  // The fixture itself must be newest-first, matching the API contract.
  expect(timestamps).toEqual([...timestamps].sort().reverse());

  await screen.findByText(timestamps[0]);
  expect(requests()).toContainEqual({ method: "GET", url: `${SNAPSHOT_URL}/history` });
  expect(screen.queryByText("No history yet.")).toBeNull();

  const images = screen.getAllByAltText(/^history /);
  expect(images.length).toBe(timestamps.length);
  // The rendered <img> src is a blob: object URL (see AuthenticatedImage); what actually proves
  // the right resource was requested is the underlying authenticated fetch.
  await waitFor(() => {
    images.forEach((img) => {
      expect(img.getAttribute("src")).toMatch(/^blob:/);
    });
  });
  timestamps.forEach((ts) => {
    expect(requests()).toContainEqual({ method: "GET", url: `${SNAPSHOT_URL}/history/${ts}` });
  });

  // Entries render in the same (newest-first) order the API provided them.
  const renderedTimestamps = timestamps.map((ts) => screen.getByText(ts));
  const container = renderedTimestamps[0].parentElement!.parentElement!;
  const entryDivs = Array.from(container.children);
  renderedTimestamps.forEach((p, i) => {
    expect(entryDivs[i].contains(p)).toBe(true);
  });
});

test("mask overlay renders existing masks; only id-known masks get a delete button", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  const rectA = { x: 10, y: 20, width: 30, height: 40 };
  const rectB = { x: 100, y: 200, width: 50, height: 60 };
  routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [rectA, rectB] } };
  routes["GET /api/masks"] = { body: { masks: [{ id: 7, ...rectA }] } };
  await openSnapshotDetail();

  const img = await screen.findByAltText("candidate");
  fireEvent.load(img);

  const rects = await screen.findAllByTestId("mask-rect");
  expect(rects.length).toBe(2);
  expect(screen.getByTestId("mask-delete-global-7")).toBeDefined();
  expect(screen.getAllByRole("button", { name: "Delete mask" }).length).toBe(1);
});

test("a pre-existing per-image mask (not in this session's createdMasks) still gets a working delete control", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  const rect = { x: 10, y: 20, width: 30, height: 40 };
  routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [rect] } };
  routes[`GET ${SNAPSHOT_URL}/masks/own`] = { body: { masks: [{ id: 99, ...rect }] } };
  routes[`DELETE ${SNAPSHOT_URL}/masks/99`] = { status: 204, body: undefined };
  await openSnapshotDetail();

  const img = await screen.findByAltText("candidate");
  fireEvent.load(img);

  // This mask was never created through this browser session (no matching entry was ever
  // returned from a POST .../masks call this session), so createdMasks alone can't resolve it --
  // only the /masks/own fetch can. That's exactly the regression this proves.
  const deleteButton = await screen.findByTestId("mask-delete-per-image-99");

  routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [] } };
  routes[`GET ${SNAPSHOT_URL}/masks/own`] = { body: { masks: [] } };
  fireEvent.click(deleteButton);

  await waitFor(() => {
    expect(screen.queryByTestId("mask-rect")).toBeNull();
  });
  expect(requests()).toContainEqual({ method: "DELETE", url: `${SNAPSHOT_URL}/masks/99` });
});

test("candidate image is not natively draggable, so drawing a mask doesn't drag/select instead", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  await openSnapshotDetail();

  const img = await screen.findByAltText("candidate");
  expect(img.getAttribute("draggable")).toBe("false");
});

test("a saved mask rect has a visible border, not just a delete button", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  routes[`GET ${SNAPSHOT_URL}/masks`] = {
    body: { masks: [{ x: 10, y: 20, width: 30, height: 40 }] },
  };
  await openSnapshotDetail();

  const img = await screen.findByAltText("candidate");
  fireEvent.load(img);

  const rect = await screen.findByTestId("mask-rect");
  expect(rect.className).toMatch(/\bborder-red-500\b/);
});

test("duplicate rects each resolve to a distinct global mask id, not a double binding", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  const rect = { x: 5, y: 5, width: 10, height: 10 };
  routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [rect, rect, rect] } };
  routes["GET /api/masks"] = {
    body: { masks: [{ id: 3, ...rect }, { id: 5, ...rect }] },
  };
  await openSnapshotDetail();

  const img = await screen.findByAltText("candidate");
  fireEvent.load(img);

  const rects = await screen.findAllByTestId("mask-rect");
  expect(rects.length).toBe(3);
  expect(screen.getByTestId("mask-delete-global-3")).toBeDefined();
  expect(screen.getByTestId("mask-delete-global-5")).toBeDefined();
  expect(screen.getAllByRole("button", { name: "Delete mask" }).length).toBe(2);
});

test("a session-created global mask reappearing in the post-create refetch doesn't shadow a distinct mask sharing its rect", async () => {
  // This is the exact collision resolveMaskIds's identity-keyed pool dedup exists for: after
  // creating a global mask, it's tracked locally in createdMasks AND then reappears in the
  // refetched globalMasks list (same id, same rect). A naive concat-without-dedup pool would
  // list that id twice, letting it double-bind two rendered rects and starve a genuinely
  // distinct pre-existing mask (id 11 below) that happens to share the same rect of its own id.
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  routes["POST /api/masks"] = { body: { id: 9, x: 0, y: 0, width: 50, height: 25 } };
  await openSnapshotDetail();

  const restoreLayout = stubOverlayLayout();
  try {
    const img = await screen.findByAltText("candidate");
    loadCandidateImage(img);

    dragOverlay(screen.getByTestId("mask-overlay"));
    await screen.findByTestId("mask-scope-picker");

    // Refetches after the create resolve to: the new mask (id 9) plus a distinct, genuinely
    // pre-existing global mask (id 11) that coincidentally shares the exact same rect.
    const rect = { x: 0, y: 0, width: 50, height: 25 };
    routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [rect, rect] } };
    routes["GET /api/masks"] = { body: { masks: [{ id: 9, ...rect }, { id: 11, ...rect }] } };

    fireEvent.click(screen.getByRole("button", { name: "Save as global mask" }));
    await waitFor(() => {
      expect(screen.queryByTestId("mask-scope-picker")).toBeNull();
    });

    const rects = await screen.findAllByTestId("mask-rect");
    expect(rects.length).toBe(2);
    // Both ids must resolve, each to exactly one rect — not id 9 bound twice with id 11 orphaned.
    expect(screen.getByTestId("mask-delete-global-9")).toBeDefined();
    expect(screen.getByTestId("mask-delete-global-11")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Delete mask" }).length).toBe(2);
  } finally {
    restoreLayout();
  }
});

test("draw + save as global mask POSTs the scaled native rect and refetches both mask lists", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  routes["POST /api/masks"] = { body: { id: 1, x: 0, y: 0, width: 50, height: 25 } };
  await openSnapshotDetail();

  const restoreLayout = stubOverlayLayout();
  try {
    const img = await screen.findByAltText("candidate");
    loadCandidateImage(img);

    dragOverlay(screen.getByTestId("mask-overlay"));
    await screen.findByTestId("mask-scope-picker");

    fireEvent.click(screen.getByRole("button", { name: "Save as global mask" }));
    await waitFor(() => {
      expect(screen.queryByTestId("mask-scope-picker")).toBeNull();
    });

    expect(requestBody("POST", "/api/masks")).toEqual({ x: 0, y: 0, width: 50, height: 25 });

    const snapshotMaskGets = requests().filter(
      (r) => r.method === "GET" && r.url === `${SNAPSHOT_URL}/masks`,
    );
    const globalMaskGets = requests().filter((r) => r.method === "GET" && r.url === "/api/masks");
    expect(snapshotMaskGets.length).toBe(2); // mount fetch + post-create refetch
    expect(globalMaskGets.length).toBe(2); // mount fetch + post-create refetch (global scope)
  } finally {
    restoreLayout();
  }
});

test("draw + save as mask for this snapshot POSTs the scaled rect and refetches only snapshot masks", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  routes[`POST ${SNAPSHOT_URL}/masks`] = { body: { id: 2, x: 0, y: 0, width: 50, height: 25 } };
  await openSnapshotDetail();

  const restoreLayout = stubOverlayLayout();
  try {
    const img = await screen.findByAltText("candidate");
    loadCandidateImage(img);

    dragOverlay(screen.getByTestId("mask-overlay"));
    await screen.findByTestId("mask-scope-picker");

    fireEvent.click(screen.getByRole("button", { name: "Save as mask for this snapshot" }));
    await waitFor(() => {
      expect(screen.queryByTestId("mask-scope-picker")).toBeNull();
    });

    expect(requestBody("POST", `${SNAPSHOT_URL}/masks`)).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 25,
    });

    const snapshotMaskGets = requests().filter(
      (r) => r.method === "GET" && r.url === `${SNAPSHOT_URL}/masks`,
    );
    const globalMaskGets = requests().filter((r) => r.method === "GET" && r.url === "/api/masks");
    expect(snapshotMaskGets.length).toBe(2); // mount fetch + post-create refetch
    expect(globalMaskGets.length).toBe(1); // only the mount fetch; global list untouched
  } finally {
    restoreLayout();
  }
});

test("delete removes the mask once the refetch reflects it gone", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  const rect = { x: 5, y: 5, width: 10, height: 10 };
  routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [rect] } };
  routes["GET /api/masks"] = { body: { masks: [{ id: 42, ...rect }] } };
  routes["DELETE /api/masks/42"] = { status: 204, body: undefined };
  await openSnapshotDetail();

  const img = await screen.findByAltText("candidate");
  fireEvent.load(img);
  await screen.findByTestId("mask-delete-global-42");

  routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [] } };
  routes["GET /api/masks"] = { body: { masks: [] } };
  fireEvent.click(screen.getByTestId("mask-delete-global-42"));

  await waitFor(() => {
    expect(screen.queryByTestId("mask-rect")).toBeNull();
  });
  expect(requests()).toContainEqual({ method: "DELETE", url: "/api/masks/42" });
});

const CATEGORY = "Example Base";
const CATEGORY_MASKS_URL = `/api/categories/${encodeURIComponent(CATEGORY)}/masks`;

test("mask assignment menu shows no category buttons when no categories exist yet, but always offers + New category", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture }; // category: null
  await openSnapshotDetail();

  const restoreLayout = stubOverlayLayout();
  try {
    const img = await screen.findByAltText("candidate");
    loadCandidateImage(img);
    dragOverlay(screen.getByTestId("mask-overlay"));
    await screen.findByTestId("mask-scope-picker");

    expect(screen.queryByRole("button", { name: CATEGORY })).toBeNull();
    expect(screen.getByRole("button", { name: "+ New category" })).toBeDefined();
  } finally {
    restoreLayout();
  }
});

test("mask assignment menu lists existing categories; picking one applies it without re-tagging an already-matching snapshot", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: { ...snapshotDetailRenderedFixture, category: CATEGORY } };
  routes["GET /api/categories"] = {
    body: {
      categories: [
        { name: CATEGORY, snapshotCount: 1, maskCount: 0 },
        { name: "Other", snapshotCount: 1, maskCount: 0 },
      ],
    },
  };
  routes[`GET ${CATEGORY_MASKS_URL}`] = { body: { masks: [] } };
  routes[`POST ${CATEGORY_MASKS_URL}`] = { body: { id: 4, x: 0, y: 0, width: 50, height: 25 } };
  await openSnapshotDetail();

  const restoreLayout = stubOverlayLayout();
  try {
    const img = await screen.findByAltText("candidate");
    loadCandidateImage(img);
    dragOverlay(screen.getByTestId("mask-overlay"));
    await screen.findByTestId("mask-scope-picker");
    await screen.findByRole("button", { name: CATEGORY });

    fireEvent.click(screen.getByRole("button", { name: CATEGORY }));
    await waitFor(() => {
      expect(screen.queryByTestId("mask-scope-picker")).toBeNull();
    });

    expect(requestBody("POST", CATEGORY_MASKS_URL)).toEqual({ x: 0, y: 0, width: 50, height: 25 });
    // The snapshot already carries this category -- picking it again must not PATCH.
    expect(requests()).not.toContainEqual(
      expect.objectContaining({ method: "PATCH", url: SNAPSHOT_URL }),
    );

    const categoryMaskGets = requests().filter(
      (r) => r.method === "GET" && r.url === CATEGORY_MASKS_URL,
    );
    expect(categoryMaskGets.length).toBe(2); // mount fetch (category is set) + post-create refetch
  } finally {
    restoreLayout();
  }
});

test("+ New category tags the snapshot with the new category, then creates the mask", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture }; // category: null
  routes[`PATCH ${SNAPSHOT_URL}`] = { body: { name: SNAPSHOT_NAME, category: CATEGORY } };
  routes[`GET ${CATEGORY_MASKS_URL}`] = { body: { masks: [] } };
  routes[`POST ${CATEGORY_MASKS_URL}`] = { body: { id: 5, x: 0, y: 0, width: 50, height: 25 } };
  await openSnapshotDetail();

  const restoreLayout = stubOverlayLayout();
  try {
    const img = await screen.findByAltText("candidate");
    loadCandidateImage(img);
    dragOverlay(screen.getByTestId("mask-overlay"));
    await screen.findByTestId("mask-scope-picker");

    fireEvent.click(screen.getByRole("button", { name: "+ New category" }));
    fireEvent.change(screen.getByLabelText("New category name"), {
      target: { value: CATEGORY },
    });
    // Reflect the created mask in the post-create refetch so the masks section's category chip
    // (the only remaining place category membership is visible, now that the standalone field is
    // gone) actually has something to render.
    routes[`GET ${SNAPSHOT_URL}/masks`] = {
      body: { masks: [{ x: 0, y: 0, width: 50, height: 25 }] },
    };
    fireEvent.click(screen.getByRole("button", { name: "Create & apply" }));

    await waitFor(() => {
      expect(screen.queryByTestId("mask-scope-picker")).toBeNull();
    });

    expect(requestBody("PATCH", SNAPSHOT_URL)).toEqual({ category: CATEGORY });
    expect(requestBody("POST", CATEGORY_MASKS_URL)).toEqual({ x: 0, y: 0, width: 50, height: 25 });
    // The masks section's category chip must reflect the newly-applied category -- it's the only
    // remaining UI surfacing category membership now that the standalone field is gone.
    await screen.findByText(`${CATEGORY} (1)`);
  } finally {
    restoreLayout();
  }
});

test("mask overlay renders category masks with a working delete button", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: { ...snapshotDetailRenderedFixture, category: CATEGORY } };
  const rect = { x: 10, y: 20, width: 30, height: 40 };
  routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [rect] } };
  routes[`GET ${CATEGORY_MASKS_URL}`] = { body: { masks: [{ id: 42, ...rect }] } };
  await openSnapshotDetail();

  const img = await screen.findByAltText("candidate");
  fireEvent.load(img);

  const rects = await screen.findAllByTestId("mask-rect");
  expect(rects.length).toBe(1);
  expect(screen.getByTestId("mask-delete-category-42")).toBeDefined();
  // Category-scope masks get their category's deterministic color, not the default red.
  expect(rects[0].className).toContain(categoryColor(CATEGORY).border);
  expect(rects[0].className).not.toMatch(/\bborder-red-500\b/);
});

test("masks hashtag row shows a scope-labeled chip per non-category mask, remove control only when the id is known", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: { ...snapshotDetailRenderedFixture, category: CATEGORY } };
  const globalRect = { x: 0, y: 0, width: 10, height: 10 };
  const categoryRect = { x: 20, y: 20, width: 10, height: 10 };
  const perImageRect = { x: 40, y: 40, width: 10, height: 10 }; // no id source anywhere -- unresolved
  routes[`GET ${SNAPSHOT_URL}/masks`] = {
    body: { masks: [globalRect, categoryRect, perImageRect] },
  };
  routes["GET /api/masks"] = { body: { masks: [{ id: 1, ...globalRect }] } };
  routes[`GET ${CATEGORY_MASKS_URL}`] = { body: { masks: [{ id: 2, ...categoryRect }] } };
  await openSnapshotDetail();

  await screen.findByText("#global");
  expect(screen.getByText("#this image")).toBeDefined();
  // Global masks have ids from their own list endpoint -- removable.
  expect(screen.getByRole("button", { name: "Remove global mask" })).toBeDefined();
  // The per-image mask has no id source (no endpoint lists per-image masks with ids) --
  // same limitation the on-image overlay rects already have, mirrored here.
  expect(screen.queryByRole("button", { name: "Remove this image mask" })).toBeNull();

  // Category-scope masks collapse to one plain, non-hashtag, non-removable count chip instead
  // of one #-chip per mask -- a category is a preset, not an individually deletable tag here.
  expect(screen.getByText(`${CATEGORY} (1)`)).toBeDefined();
  expect(screen.queryByText(`#${CATEGORY}`)).toBeNull();
  expect(screen.queryByRole("button", { name: `Remove ${CATEGORY} mask` })).toBeNull();
});

test("a category with multiple masks collapses to one count chip, not one per mask", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: { ...snapshotDetailRenderedFixture, category: CATEGORY } };
  const rectA = { x: 20, y: 20, width: 10, height: 10 };
  const rectB = { x: 60, y: 60, width: 10, height: 10 };
  const rectC = { x: 90, y: 90, width: 10, height: 10 };
  routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [rectA, rectB, rectC] } };
  routes[`GET ${CATEGORY_MASKS_URL}`] = {
    body: { masks: [{ id: 2, ...rectA }, { id: 3, ...rectB }, { id: 4, ...rectC }] },
  };
  await openSnapshotDetail();

  await screen.findByText(`${CATEGORY} (3)`);
  expect(screen.queryByText(`${CATEGORY} (1)`)).toBeNull();
});

test("removing a mask via its hashtag chip DELETEs through the right scope endpoint and refetches", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  routes[`GET ${SNAPSHOT_URL}/masks`] = { body: { masks: [rect] } };
  routes["GET /api/masks"] = { body: { masks: [{ id: 1, ...rect }] } };
  routes["DELETE /api/masks/1"] = { status: 204 };
  await openSnapshotDetail();

  await screen.findByText("#global");
  fireEvent.click(screen.getByRole("button", { name: "Remove global mask" }));

  await waitFor(() => {
    expect(requests()).toContainEqual({ method: "DELETE", url: "/api/masks/1" });
  });
  const globalMaskGets = requests().filter(
    (r) => r.method === "GET" && r.url === "/api/masks",
  );
  expect(globalMaskGets.length).toBe(2); // mount fetch + post-delete refetch
});

test("create mask failure surfaces the ApiError message and clears the pending rect", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  routes["POST /api/masks"] = { status: 400, body: { error: "Rect out of bounds" } };
  await openSnapshotDetail();

  const restoreLayout = stubOverlayLayout();
  try {
    const img = await screen.findByAltText("candidate");
    loadCandidateImage(img);

    dragOverlay(screen.getByTestId("mask-overlay"));
    await screen.findByTestId("mask-scope-picker");

    fireEvent.click(screen.getByRole("button", { name: "Save as global mask" }));

    await screen.findByText("Create mask failed (400): Rect out of bounds");
    expect(screen.queryByTestId("mask-scope-picker")).toBeNull();
  } finally {
    restoreLayout();
  }
});

test("Categories section lists categories with counts and a color dot", async () => {
  routes["GET /api/categories"] = {
    body: {
      categories: [
        { name: "App Shell", snapshotCount: 3, maskCount: 1 },
        { name: "Nav Bar", snapshotCount: 0, maskCount: 2 },
      ],
    },
  };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));

  await screen.findByText("App Shell — 3 snapshots, 1 masks");
  expect(screen.getByText("Nav Bar — 0 snapshots, 2 masks")).toBeDefined();
});

test("Categories section shows an empty state when there are no categories", async () => {
  routes["GET /api/categories"] = { body: { categories: [] } };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));

  await screen.findByText("No categories yet.");
});

test("renaming a category PATCHes the new name and refetches the list", async () => {
  routes["GET /api/categories"] = {
    body: { categories: [{ name: "App Shell", snapshotCount: 1, maskCount: 0 }] },
  };
  routes["PATCH /api/categories/App%20Shell"] = { body: { name: "Shell" } };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByText("App Shell — 1 snapshots, 0 masks");

  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  const input = screen.getByLabelText("Rename App Shell") as HTMLInputElement;
  expect(input.value).toBe("App Shell");
  fireEvent.change(input, { target: { value: "Shell" } });

  routes["GET /api/categories"] = {
    body: { categories: [{ name: "Shell", snapshotCount: 1, maskCount: 0 }] },
  };
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await screen.findByText("Shell — 1 snapshots, 0 masks");
  expect(requestBody("PATCH", "/api/categories/App%20Shell")).toEqual({ name: "Shell" });
});

test("rename conflict shows an inline error and leaves the category untouched", async () => {
  routes["GET /api/categories"] = {
    body: { categories: [{ name: "App Shell", snapshotCount: 1, maskCount: 0 }] },
  };
  routes["PATCH /api/categories/App%20Shell"] = {
    status: 409,
    body: { error: "category 'Nav Bar' already exists" },
  };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByText("App Shell — 1 snapshots, 0 masks");

  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByLabelText("Rename App Shell"), { target: { value: "Nav Bar" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await screen.findByText("Rename failed (409): category 'Nav Bar' already exists");
  // Stays in edit mode after a failed rename, so the attempted value can be fixed and retried.
  expect((screen.getByLabelText("Rename App Shell") as HTMLInputElement).value).toBe("Nav Bar");
});

test("deleting a category DELETEs and refetches the list", async () => {
  routes["GET /api/categories"] = {
    body: { categories: [{ name: "App Shell", snapshotCount: 0, maskCount: 2 }] },
  };
  routes["DELETE /api/categories/App%20Shell"] = { status: 204, body: undefined };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByText("App Shell — 0 snapshots, 2 masks");

  routes["GET /api/categories"] = { body: { categories: [] } };
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  await screen.findByText("No categories yet.");
  expect(requests()).toContainEqual({
    method: "DELETE",
    url: "/api/categories/App%20Shell",
  });
});

test("delete refusal (category still tagged) shows an inline error and leaves it listed", async () => {
  routes["GET /api/categories"] = {
    body: { categories: [{ name: "App Shell", snapshotCount: 2, maskCount: 1 }] },
  };
  routes["DELETE /api/categories/App%20Shell"] = {
    status: 409,
    body: { error: "cannot delete category 'App Shell' while 2 snapshot(s) are still tagged with it" },
  };
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByText("App Shell — 2 snapshots, 1 masks");

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  await screen.findByText(/Delete failed \(409\)/);
  expect(screen.getByText("App Shell — 2 snapshots, 1 masks")).toBeDefined();
});

test("saving the auth token via the UI adds an Authorization header to subsequent API calls", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Auth token"), { target: { value: "secret-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save token" }));
  fireEvent.click(screen.getByRole("button", { name: "PixelPerfectSnapshot" }));

  fireEvent.click(await screen.findByRole("button", { name: /Jul 15, 09:30/ }));
  await screen.findByText("checkout-page — 1280x720 — pending");

  const call = fetchMock.mock.calls.find((c) => c[0] === `/api/runs/${RUN_ID}`);
  expect(call).toBeDefined();
  const headers = (call![1] as RequestInit).headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer secret-token");
});

test("clearing the auth token removes the Authorization header from subsequent API calls", async () => {
  setAuthToken("stale-token");
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByLabelText("Auth token")).toHaveProperty("value", "stale-token");

  fireEvent.click(screen.getByRole("button", { name: "Clear token" }));
  fireEvent.click(screen.getByRole("button", { name: "PixelPerfectSnapshot" }));
  fireEvent.click(await screen.findByRole("button", { name: /Jul 15, 09:30/ }));
  await screen.findByText("checkout-page — 1280x720 — pending");

  const call = fetchMock.mock.calls.find((c) => c[0] === `/api/runs/${RUN_ID}`);
  expect(call).toBeDefined();
  const headers = (call![1] as RequestInit | undefined)?.headers as
    | Record<string, string>
    | undefined;
  expect(headers?.Authorization).toBeUndefined();
});

test("AuthenticatedImage fetches with the auth header, renders via an object URL, and revokes it on src change and unmount", async () => {
  routes["GET /img/one"] = blobRoute();
  routes["GET /img/two"] = blobRoute();
  setAuthToken("iso-token");

  const { rerender, unmount } = render(<AuthenticatedImage src="/img/one" alt="test" />);

  await waitFor(() => {
    expect(screen.getByAltText("test").getAttribute("src")).toMatch(/^blob:/);
  });
  const firstCall = fetchMock.mock.calls.find((c) => c[0] === "/img/one");
  expect(firstCall).toBeDefined();
  expect((firstCall![1] as RequestInit).headers).toMatchObject({
    Authorization: "Bearer iso-token",
  });
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();

  rerender(<AuthenticatedImage src="/img/two" alt="test" />);
  await waitFor(() => {
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    expect(screen.getByAltText("test").getAttribute("src")).toMatch(/^blob:/);
  });

  unmount();
  await waitFor(() => {
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});

test("a 401 on an image fetch surfaces a visible error pointing at the token field", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  routes[`GET ${snapshotDetailRenderedFixture.baselineUrl}`] = blobRoute(401);
  await openSnapshotDetail();

  await screen.findByText("Status: fail");
  await screen.findByText("Image failed to load — check your auth token above");
  expect(screen.queryByAltText("baseline")).toBeNull();
  // The other panes, unaffected, still load normally.
  await waitFor(() => {
    expect(screen.getByAltText("candidate").getAttribute("src")).toMatch(/^blob:/);
  });
});
