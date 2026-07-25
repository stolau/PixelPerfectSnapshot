import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App.js";
import { AuthenticatedImage } from "./AuthenticatedImage.js";
import { setAuthToken } from "./authToken.js";
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
    "GET /api/masks": { body: { masks: [] } },
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
  // Not a blanket "no <img> anywhere" check -- the persistent nav-bar logo is legitimately
  // always present. Scoped to the snapshot images this test actually cares about.
  expect(screen.queryByAltText("baseline")).toBeNull();
  expect(screen.queryByAltText("candidate")).toBeNull();
  expect(screen.queryByAltText("diff")).toBeNull();
});

test("snapshot detail with rendered URLs shows baseline, candidate, and diff images", async () => {
  routes[`GET ${SNAPSHOT_URL}`] = { body: snapshotDetailRenderedFixture };
  await openSnapshotDetail();

  await screen.findByText("Status: fail");
  const images = screen.getAllByRole("img");
  expect(images.length).toBe(3);
  // The rendered <img> src is a blob: object URL (see AuthenticatedImage); what actually proves
  // the right resource was requested is the underlying authenticated fetch.
  await waitFor(() => {
    expect(screen.getByAltText("baseline").getAttribute("src")).toMatch(/^blob:/);
    expect(screen.getByAltText("candidate").getAttribute("src")).toMatch(/^blob:/);
    expect(screen.getByAltText("diff").getAttribute("src")).toMatch(/^blob:/);
  });
  expect(requests()).toContainEqual({
    method: "GET",
    url: snapshotDetailRenderedFixture.baselineUrl,
  });
  expect(requests()).toContainEqual({
    method: "GET",
    url: snapshotDetailRenderedFixture.candidateUrl,
  });
  expect(requests()).toContainEqual({ method: "GET", url: snapshotDetailRenderedFixture.diffUrl });
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
