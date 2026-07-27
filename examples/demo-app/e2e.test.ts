import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createRun, processRun, sendSnapshots, type Snapshot } from "pixelperfectsnapshot";
import { afterAll, expect, test } from "vitest";

const siteDir = fileURLToPath(new URL("site", import.meta.url));
const backendDir = fileURLToPath(new URL("../../backend", import.meta.url));
const clientDist = path.dirname(createRequire(import.meta.url).resolve("pixelperfectsnapshot"));
const captureBundle = path.join(clientDist, "capture.js");

const WIDTH = 480;
const HEIGHT = 360;

const SETUP_HINT =
  "backend not set up? From the repo root run:\n" +
  "  python3 -m venv backend/.venv && backend/.venv/bin/pip install -e 'backend[dev]'\n" +
  "  backend/.venv/bin/playwright install chromium";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

let flaskProc: ChildProcess | undefined;
let server: Server | undefined;
let viewerServer: Server | undefined;
let browser: Browser | undefined;
let dataDir: string | undefined;
/** The static server swaps the .box color when this is "changed" (run 3's regression). */
let variant: "original" | "changed" = "original";

// Assigned by the pipeline test; the viewer test reuses the same flask/site/browser.
let siteUrl = "";
let serverUrl = "";
let flaskBin = "flask";
let flaskEnv: NodeJS.ProcessEnv = process.env;
// Assigned by the viewer test; later tests that drive the real viewer UI reuse it.
let viewerUrl = "";

// Opt-in dogfooding: this suite already drives the real viewer through its key screens (run
// list, run detail, snapshot detail, Settings, Branches & Releases) -- when these env vars are
// set, the tests below also stash a snapshot of each screen, and afterAll uploads them as one
// batch run against a real, persistent PixelPerfectSnapshot instance (review/approval then
// happens through that instance's own viewer, same as any other snapshot; this never
// auto-approves). No-op, zero behavior change, when unset -- the default for a normal
// `npm run test:e2e`. See examples/demo-app/CODEMAP.md.
const dogfoodServerUrl = process.env.PPS_DOGFOOD_SERVER_URL;
const dogfoodToken = process.env.PPS_DOGFOOD_TOKEN;
const dogfoodSnapshots: Snapshot[] = [];

async function dogfoodCapture(page: Page, name: string): Promise<void> {
  if (!dogfoodServerUrl) return;
  await page.addScriptTag({ path: captureBundle });
  dogfoodSnapshots.push(await page.evaluate((n) => window.__ppsCapture(document, n), name));
}

async function getSnapshotDetail(runId: string) {
  const res = await fetch(`${serverUrl}/api/runs/${runId}/snapshots/demo-page`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    status: string;
    baselineUrl: string | null;
    candidateUrl: string | null;
    diffUrl: string | null;
  };
}

afterAll(async () => {
  if (flaskProc && flaskProc.exitCode === null) {
    flaskProc.kill("SIGTERM");
    await once(flaskProc, "exit");
  }
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server?.close((err) => (err ? reject(err) : resolve())),
    );
  }
  if (viewerServer?.listening) {
    viewerServer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      viewerServer?.close((err) => (err ? reject(err) : resolve())),
    );
  }
  await browser?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });

  if (dogfoodServerUrl && dogfoodSnapshots.length > 0) {
    const dogfoodRunId = (
      await createRun({ serverUrl: dogfoodServerUrl, token: dogfoodToken })
    ).id;
    await sendSnapshots(dogfoodSnapshots, {
      serverUrl: dogfoodServerUrl,
      runId: dogfoodRunId,
      token: dogfoodToken,
    });
    await processRun({ serverUrl: dogfoodServerUrl, runId: dogfoodRunId, token: dogfoodToken });
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

async function capturePage(
  baseUrl: string,
  viewport = { width: WIDTH, height: HEIGHT },
  name = "demo-page",
  category?: string,
): Promise<Snapshot> {
  if (!browser) throw new Error("browser not launched");
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "load" });
  await page.evaluate(async () => {
    void document.body.offsetHeight; // force reflow
    const fontLoads: Promise<unknown>[] = [];
    document.fonts.forEach((f) => fontLoads.push(f.load().catch(() => {})));
    await Promise.all(fontLoads);
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})));
  });
  await page.addScriptTag({ path: captureBundle });
  const snapshot = await page.evaluate(
    ({ n, c }) => window.__ppsCapture(document, n, c ? { category: c } : undefined),
    { n: name, c: category },
  );
  await context.close();
  return snapshot;
}

/** Captures a page with the .box color forced back to its ORIGINAL value client-side --
 * independent of the shared static site server's own `variant` flag (already permanently
 * "changed" by the time later tests run; see the pipeline test above). Without this, a
 * mask-effect test's "baseline" capture would silently already be showing the regressed color
 * too (since it comes from the same shared, already-flipped site server), making its later
 * "regression" capture look identical to the baseline regardless of whether masks do anything. */
async function captureCleanPage(
  baseUrl: string,
  name: string,
  category?: string,
): Promise<Snapshot> {
  if (!browser) throw new Error("browser not launched");
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "load" });
  await page.evaluate(() => {
    const box = document.querySelector(".box");
    if (box instanceof HTMLElement) box.style.background = "#1a1a6e";
  });
  await page.addScriptTag({ path: captureBundle });
  const snapshot = await page.evaluate(
    ({ n, c }) => window.__ppsCapture(document, n, c ? { category: c } : undefined),
    { n: name, c: category },
  );
  await context.close();
  return snapshot;
}

/** Captures a page with the .box regression color applied client-side -- independent of the
 * shared static site server's own `variant` flag (already permanently "changed" by the time
 * later tests run; see the pipeline test above), so this stays usable from any test regardless
 * of execution order. */
async function captureRegressedPage(
  baseUrl: string,
  name: string,
  category?: string,
): Promise<Snapshot> {
  if (!browser) throw new Error("browser not launched");
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "load" });
  await page.evaluate(() => {
    const box = document.querySelector(".box");
    if (box instanceof HTMLElement) box.style.background = "#c0392b";
  });
  await page.addScriptTag({ path: captureBundle });
  const snapshot = await page.evaluate(
    ({ n, c }) => window.__ppsCapture(document, n, c ? { category: c } : undefined),
    { n: name, c: category },
  );
  await context.close();
  return snapshot;
}

test(
  "full pipeline dogfood: capture → upload → render → approve → pass → regression fail",
  async () => {
    for (const bundle of [captureBundle, path.join(clientDist, "rehydrate.js")]) {
      if (!existsSync(bundle)) {
        throw new Error(
          `missing built artifact ${bundle} — run \`npm run build -w packages/client\` first`,
        );
      }
    }

    dataDir = mkdtempSync(path.join(os.tmpdir(), "pps-e2e-"));

    // Static server for the demo site; serves a "changed" style.css when variant flips.
    const srv = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      let body: Buffer;
      try {
        body = readFileSync(path.join(siteDir, pathname));
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
      if (pathname.endsWith("style.css") && variant === "changed") {
        body = Buffer.from(body.toString("utf8").replace("#1a1a6e", "#c0392b"));
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(pathname)] ?? "application/octet-stream",
      });
      res.end(body);
    });
    server = srv;
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    siteUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    // The real Flask backend, with a throwaway data dir.
    const venvFlask = path.join(backendDir, ".venv", "bin", "flask");
    flaskBin = process.env.PPS_FLASK ?? (existsSync(venvFlask) ? venvFlask : "flask");
    flaskEnv = { ...process.env, PPS_DATA_DIR: dataDir };
    const flaskPort = await freePort();
    serverUrl = `http://127.0.0.1:${flaskPort}`;
    flaskProc = spawn(flaskBin, ["--app", "app", "run", "--port", String(flaskPort)], {
      cwd: backendDir,
      env: flaskEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let spawnError: Error | undefined;
    flaskProc.on("error", (err) => (spawnError = err));
    let flaskStderr = "";
    flaskProc.stderr?.on("data", (chunk: Buffer) => (flaskStderr += chunk.toString()));
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (spawnError) {
        throw new Error(`could not start ${flaskBin}: ${spawnError.message}\n${SETUP_HINT}`);
      }
      if (flaskProc.exitCode !== null) {
        throw new Error(`flask exited with code ${flaskProc.exitCode}:\n${flaskStderr}`);
      }
      const ok = await fetch(`${serverUrl}/api/health`).then((r) => r.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline) {
        throw new Error(`flask never became healthy:\n${flaskStderr}\n${SETUP_HINT}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // 1. Run 1: capture the live demo page and upload it — status starts "pending".
    browser = await chromium.launch();
    const run1 = (await createRun({ serverUrl })).id;
    const snapshot1 = await capturePage(siteUrl);
    expect(snapshot1.name).toBe("demo-page");
    expect(snapshot1.viewport).toEqual({ width: WIDTH, height: HEIGHT });
    await sendSnapshots([snapshot1], { serverUrl, runId: run1 });
    const run1Listing = await fetch(`${serverUrl}/api/runs/${run1}`).then((r) => r.json());
    expect(run1Listing.snapshots).toEqual([
      { name: "demo-page", viewport: { width: WIDTH, height: HEIGHT }, status: "pending" },
    ]);

    // 2. Render it: no baseline exists yet, so it needs approval.
    await processRun({ serverUrl, runId: run1 });
    const afterRender = await getSnapshotDetail(run1);
    expect(afterRender.status).toBe("approved-baseline-missing");
    expect(afterRender.candidateUrl).not.toBeNull();
    expect(afterRender.baselineUrl).toBeNull();

    // 3. Approve: candidate becomes the baseline, status flips to "pass".
    const approveRes = await fetch(`${serverUrl}/api/runs/${run1}/snapshots/demo-page/approve`, {
      method: "POST",
    });
    expect(approveRes.status).toBe(200);
    expect(await approveRes.json()).toEqual({ name: "demo-page", status: "pass" });
    const afterApprove = await getSnapshotDetail(run1);
    expect(afterApprove.baselineUrl).not.toBeNull();
    const baselineRes = await fetch(`${serverUrl}${afterApprove.baselineUrl}`);
    expect(baselineRes.status).toBe(200);
    expect(baselineRes.headers.get("content-type")).toContain("image/png");

    // 4. Run 2: the unchanged page must pass against the approved baseline.
    const run2 = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl)], { serverUrl, runId: run2 });
    await processRun({ serverUrl, runId: run2 });
    expect((await getSnapshotDetail(run2)).status).toBe("pass");

    // 5. Run 3: a real visual regression (box color change) must fail with a diff image.
    variant = "changed";
    const run3 = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl)], { serverUrl, runId: run3 });
    await processRun({ serverUrl, runId: run3 });
    const failed = await getSnapshotDetail(run3);
    expect(failed.status).toBe("fail");
    expect(failed.diffUrl).not.toBeNull();
    const diffRes = await fetch(`${serverUrl}${failed.diffUrl}`);
    expect(diffRes.status).toBe(200);
    expect(diffRes.headers.get("content-type")).toContain("image/png");
    const diffBytes = Buffer.from(await diffRes.arrayBuffer());
    expect(diffBytes.subarray(0, 4)).toEqual(Buffer.from("\x89PNG", "latin1"));
  },
  240_000,
);

test(
  "viewer against the live backend: images load through /backend, approve updates the UI",
  async () => {
    if (!browser || serverUrl === "") throw new Error("pipeline test must run (and pass) first");

    // 1. Run 4: capture at a second viewport → needs approval (no 320x240 baseline exists).
    //    (`variant` is still "changed" from run 3 — harmless, there is nothing to diff against.)
    const run4 = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl, { width: 320, height: 240 })], {
      serverUrl,
      runId: run4,
    });
    await processRun({ serverUrl, runId: run4 });
    expect((await getSnapshotDetail(run4)).status).toBe("approved-baseline-missing");

    // 2. Serve the built viewer (VITE_API_BASE=/backend baked in) and forward /backend/* to flask.
    const viewerDist = fileURLToPath(new URL("../../viewer/dist", import.meta.url));
    if (!existsSync(path.join(viewerDist, "index.html"))) {
      throw new Error(
        `missing ${viewerDist}/index.html — run \`npm run test:e2e -w examples/demo-app\` so pretest:e2e builds the viewer`,
      );
    }
    const vsrv = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname.startsWith("/backend/")) {
        // Forward to flask with the prefix stripped, including the request body/Content-Type --
        // needed once a test drives a bodied write (mask creation, category rename) through the
        // real viewer, not just the bodyless approve POST the original test here used.
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const contentType = req.headers["content-type"];
          fetch(`${serverUrl}${pathname.slice("/backend".length)}`, {
            method: req.method,
            headers: contentType ? { "Content-Type": contentType } : undefined,
            body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
          }).then(
            async (upstream) => {
              res.writeHead(upstream.status, {
                "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
              });
              res.end(Buffer.from(await upstream.arrayBuffer()));
            },
            () => {
              res.writeHead(502);
              res.end();
            },
          );
        });
        return;
      }
      const filePath = pathname === "/" ? "/index.html" : pathname;
      let body: Buffer;
      try {
        body = readFileSync(path.join(viewerDist, filePath));
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
      });
      res.end(body);
    });
    viewerServer = vsrv;
    await new Promise<void>((resolve) => vsrv.listen(0, "127.0.0.1", resolve));
    viewerUrl = `http://127.0.0.1:${(vsrv.address() as AddressInfo).port}`;

    // 3. Drive the viewer UI in a browser. Viewport here is for the viewer UI, not snapshots.
    const context = await browser.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    // Run list: 4 runs. createdAt has second resolution and every run has "1 snapshots", so
    // button texts are likely identical — select positionally (newest first: run 4 is first).
    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    expect(await runButtons.count()).toBe(4);
    await dogfoodCapture(page, "dogfood-run-list");

    // Run 4 detail: approval needed at the new viewport.
    await runButtons.first().click();
    const run4Snapshot = page.getByRole("button", {
      name: "demo-page — 320x240 — approved-baseline-missing",
    });
    await run4Snapshot.waitFor();
    await dogfoodCapture(page, "dogfood-run-detail");

    // Run 4 snapshot detail: candidate image must actually load through the /backend prefix.
    await run4Snapshot.click();
    await page.getByText("Status: approved-baseline-missing").waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });
    expect(await page.locator('img[alt="baseline"]').count()).toBe(0);
    expect(await page.getByText("not available").count()).toBe(1); // baseline pane (dual view: baseline + candidate)

    // Approve: the UI must reflect the server's post-approve state (pass + real baseline).
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByText("Status: pass").waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="baseline"]');
      return img !== null && img.naturalWidth > 0;
    });

    // Back out to the run list, then into run 3 (second button): the regression run.
    await page.getByRole("button", { name: "Back" }).click(); // → run 4 detail
    await page.getByRole("button", { name: "Back" }).click(); // → run list
    await runButtons.first().waitFor();
    await runButtons.nth(1).click();
    const run3Snapshot = page.getByRole("button", { name: "demo-page — 480x360 — fail" });
    await run3Snapshot.waitFor();
    await run3Snapshot.click();
    await page.getByText("Status: fail").waitFor();
    // Dual view default: baseline + candidate side by side, no separate diff pane.
    for (const alt of ["baseline", "candidate"]) {
      await page.waitForFunction((a) => {
        const img = document.querySelector<HTMLImageElement>(`img[alt="${a}"]`);
        return img !== null && img.naturalWidth > 0;
      }, alt);
    }
    await dogfoodCapture(page, "dogfood-snapshot-detail-dual");
    // "Show diff" swaps the candidate-slot pane to the diff image; must also load through /backend.
    await page.getByLabel("Show diff").check();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="diff"]');
      return img !== null && img.naturalWidth > 0;
    });

    await context.close();
  },
  240_000,
);

test(
  "masks: draw, save as global, and delete a mask against a real rendered image",
  async () => {
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    // Same navigation run 2's test already proved reliable: run 3 is the "fail" regression run.
    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.nth(1).click();
    const run3Snapshot = page.getByRole("button", { name: "demo-page — 480x360 — fail" });
    await run3Snapshot.waitFor();
    await run3Snapshot.click();
    await page.getByText("Status: fail").waitFor();

    const overlay = page.getByTestId("mask-overlay");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("mask overlay not visible");

    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 80);
    await page.mouse.up();

    await page.getByTestId("mask-scope-picker").waitFor();
    await page.getByRole("button", { name: "Save as global mask" }).click();
    await page.getByTestId("mask-scope-picker").waitFor({ state: "detached" });

    const rect = page.getByTestId("mask-rect");
    await rect.waitFor();
    expect(await rect.count()).toBe(1);

    await rect.getByRole("button", { name: "Delete mask" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="mask-rect"]') === null);
    expect(await page.getByTestId("mask-rect").count()).toBe(0);

    await context.close();
  },
  240_000,
);

test(
  "Branches & Releases: a scoped run's approval is visible through the filtered list",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    // createRun() has no scope support -- go around the client library, same as the backend's
    // own scoped-run test fixtures do.
    const branchRunRes = await fetch(`${serverUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: { kind: "branch", id: "e2e-branch" } }),
    });
    expect(branchRunRes.status).toBe(201);
    const branchRunId = (await branchRunRes.json()).id as string;
    await sendSnapshots([await capturePage(siteUrl, undefined, "branch-demo-page")], {
      serverUrl,
      runId: branchRunId,
    });
    await processRun({ serverUrl, runId: branchRunId });
    const approveRes = await fetch(
      `${serverUrl}/api/runs/${branchRunId}/snapshots/branch-demo-page/approve`,
      { method: "POST" },
    );
    expect(approveRes.status).toBe(200);

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    await page.getByRole("button", { name: "Branches & Releases" }).click();
    await page.getByRole("heading", { name: "Branches & Releases" }).waitFor();
    await page.getByRole("button", { name: "e2e-branch" }).waitFor();
    await dogfoodCapture(page, "dogfood-branches-releases");
    await page.getByRole("button", { name: "e2e-branch" }).click();
    await page.getByRole("heading", { name: "Branch: e2e-branch" }).waitFor();

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    expect(await runButtons.count()).toBe(1);
    await runButtons.first().click();

    const branchSnapshot = page.getByRole("button", { name: /^branch-demo-page/ });
    await branchSnapshot.waitFor();
    await branchSnapshot.click();
    await page.getByText("Status: pass").waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="baseline"]');
      return img !== null && img.naturalWidth > 0;
    });

    await context.close();
  },
  240_000,
);

test(
  "bulk approve: selecting two new snapshots approves both against the live backend",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    const bulkRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots(
      [
        await capturePage(siteUrl, undefined, "bulk-page-a"),
        await capturePage(siteUrl, undefined, "bulk-page-b"),
      ],
      { serverUrl, runId: bulkRunId },
    );
    await processRun({ serverUrl, runId: bulkRunId });

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    // Newest run is first in the list.
    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();

    await page.getByLabel("Select bulk-page-a").check();
    await page.getByLabel("Select bulk-page-b").check();
    await page.getByRole("button", { name: "Approve selected (2)" }).click();
    await page.getByText("2 approved").waitFor();

    expect(await page.getByText(/^bulk-page-a — .* — pass$/).count()).toBe(1);
    expect(await page.getByText(/^bulk-page-b — .* — pass$/).count()).toBe(1);

    await context.close();
  },
  240_000,
);

test(
  "category management: tagging via mask assignment, then renaming, cascades back to the snapshot's own chip",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    const categoryRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl, undefined, "category-demo-page")], {
      serverUrl,
      runId: categoryRunId,
    });
    await processRun({ serverUrl, runId: categoryRunId });
    await fetch(`${serverUrl}/api/runs/${categoryRunId}/snapshots/category-demo-page/approve`, {
      method: "POST",
    });

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    // Newest run is first in the list.
    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();
    const categorySnapshot = page.getByRole("button", { name: /^category-demo-page/ });
    await categorySnapshot.waitFor();
    await categorySnapshot.click();
    await page.getByText("Status: pass").waitFor();

    // Category membership is only ever set as a side effect of assigning a mask to it -- there's
    // no standalone Category field. Draw a rect and create a brand-new category from the picker.
    const overlay = page.getByTestId("mask-overlay");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("mask overlay not visible");
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 80);
    await page.mouse.up();
    await page.getByTestId("mask-scope-picker").waitFor();
    await page.getByRole("button", { name: "+ New category" }).click();
    await page.getByLabel("New category name").fill("E2E Category");
    await page.getByRole("button", { name: "Create & apply" }).click();
    await page.getByTestId("mask-scope-picker").waitFor({ state: "detached" });
    await page.getByText("E2E Category (1)").waitFor();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByText("E2E Category — 1 snapshots, 1 masks").waitFor();
    await dogfoodCapture(page, "dogfood-settings");

    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("Rename E2E Category").fill("E2E Category Renamed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("E2E Category Renamed — 1 snapshots, 1 masks").waitFor();

    // Confirm the rename cascaded to the real snapshot's masks chip, not just the category listing.
    await page.getByRole("button", { name: "PixelPerfectSnapshot" }).click();
    await runButtons.first().waitFor();
    await runButtons.first().click();
    await categorySnapshot.waitFor();
    await categorySnapshot.click();
    await page.getByText("Status: pass").waitFor();
    await page.getByText("E2E Category Renamed (1)").waitFor();

    await context.close();
  },
  240_000,
);

test(
  "masks: multiple masks under the same category collapse to one count chip, not one per mask",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    const multiMaskRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl, undefined, "category-multi-mask-page")], {
      serverUrl,
      runId: multiMaskRunId,
    });
    await processRun({ serverUrl, runId: multiMaskRunId });
    await fetch(`${serverUrl}/api/runs/${multiMaskRunId}/snapshots/category-multi-mask-page/approve`, {
      method: "POST",
    });

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();
    const multiMaskSnapshot = page.getByRole("button", { name: /^category-multi-mask-page/ });
    await multiMaskSnapshot.waitFor();
    await multiMaskSnapshot.click();
    await page.getByText("Status: pass").waitFor();

    const overlay = page.getByTestId("mask-overlay");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("mask overlay not visible");

    // First mask: create the category via "+ New category".
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 60);
    await page.mouse.up();
    await page.getByTestId("mask-scope-picker").waitFor();
    await page.getByRole("button", { name: "+ New category" }).click();
    await page.getByLabel("New category name").fill("E2E Multi Category");
    await page.getByRole("button", { name: "Create & apply" }).click();
    await page.getByTestId("mask-scope-picker").waitFor({ state: "detached" });
    await page.getByText("E2E Multi Category (1)").waitFor();

    // Second mask: same category now exists as a one-click option in the picker.
    await page.mouse.move(box.x + 120, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + 140);
    await page.mouse.up();
    await page.getByTestId("mask-scope-picker").waitFor();
    await page.getByRole("button", { name: "E2E Multi Category" }).click();
    await page.getByTestId("mask-scope-picker").waitFor({ state: "detached" });

    // One collapsed chip with count 2 -- not two separate chips.
    await page.getByText("E2E Multi Category (2)").waitFor();
    expect(await page.getByText("E2E Multi Category (1)").count()).toBe(0);
    expect(await page.getByText("E2E Multi Category (2)").count()).toBe(1);

    await context.close();
  },
  240_000,
);

test(
  "Approve checkmark is disabled once a snapshot is passing, verified against the real rendered page",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    const checkmarkRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl, undefined, "checkmark-pass-page")], {
      serverUrl,
      runId: checkmarkRunId,
    });
    await processRun({ serverUrl, runId: checkmarkRunId });
    await fetch(`${serverUrl}/api/runs/${checkmarkRunId}/snapshots/checkmark-pass-page/approve`, {
      method: "POST",
    });

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();
    const checkmarkSnapshot = page.getByRole("button", { name: /^checkmark-pass-page/ });
    await checkmarkSnapshot.waitFor();
    await checkmarkSnapshot.click();
    await page.getByText("Status: pass").waitFor();

    // jsdom (the unit-test environment) can't render real layout/interactivity, so this is the
    // only place "disabled" is proven against an actual rendered <button> in a real browser.
    const approveButton = page.getByRole("button", { name: "Approve" });
    await approveButton.waitFor();
    expect(await approveButton.isDisabled()).toBe(true);

    await context.close();
  },
  240_000,
);

test(
  "masks: deleting via the hashtag chip removes it, not just the on-image rect",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    const chipDeleteRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl, undefined, "chip-delete-page")], {
      serverUrl,
      runId: chipDeleteRunId,
    });
    await processRun({ serverUrl, runId: chipDeleteRunId });

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();
    const chipDeleteSnapshot = page.getByRole("button", { name: /^chip-delete-page/ });
    await chipDeleteSnapshot.waitFor();
    await chipDeleteSnapshot.click();
    await page.getByText("Status: approved-baseline-missing").waitFor();

    const overlay = page.getByTestId("mask-overlay");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("mask overlay not visible");
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 80);
    await page.mouse.up();
    await page.getByTestId("mask-scope-picker").waitFor();
    await page.getByRole("button", { name: "Save as global mask" }).click();
    await page.getByTestId("mask-rect").waitFor();
    await page.getByText("#global").waitFor();

    await page.getByRole("button", { name: "Remove global mask" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="mask-rect"]') === null);
    expect(await page.getByTestId("mask-rect").count()).toBe(0);
    expect(await page.getByText("#global").count()).toBe(0);

    await context.close();
  },
  240_000,
);

test(
  "Single view's Baseline tab is disabled when there is no baseline, verified against a real rendered button",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    const noBaselineRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl, undefined, "no-baseline-page")], {
      serverUrl,
      runId: noBaselineRunId,
    });
    await processRun({ serverUrl, runId: noBaselineRunId });

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();
    const noBaselineSnapshot = page.getByRole("button", { name: /^no-baseline-page/ });
    await noBaselineSnapshot.waitFor();
    await noBaselineSnapshot.click();
    await page.getByText("Status: approved-baseline-missing").waitFor();

    await page.getByRole("button", { name: "Single" }).click();
    // jsdom (the unit-test environment) can't render real interactivity, so this is the only
    // place "disabled" is proven against an actual rendered <button>, mirroring the same proof
    // already established for the Approve checkmark above.
    const baselineTab = page.getByRole("button", { name: "Baseline" });
    await baselineTab.waitFor();
    expect(await baselineTab.isDisabled()).toBe(true);

    await context.close();
  },
  240_000,
);

test(
  "images fill the available width of their pane in both Dual and Single view",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    const widthRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl, undefined, "width-page")], {
      serverUrl,
      runId: widthRunId,
    });
    await processRun({ serverUrl, runId: widthRunId });
    await fetch(`${serverUrl}/api/runs/${widthRunId}/snapshots/width-page/approve`, {
      method: "POST",
    });

    const context = await browser!.newContext({ viewport: { width: 1400, height: 800 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();
    const widthSnapshot = page.getByRole("button", { name: /^width-page/ });
    await widthSnapshot.waitFor();
    await widthSnapshot.click();
    await page.getByText("Status: pass").waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });

    // Dual view: each pane should fill its own container, not shrink to the snapshot's own
    // 480px natural capture width -- the exact bug the redesign's Dockerfile/CSS fix
    // (InteractiveImagePane's wrapper going from inline-block to w-full) guarded against,
    // previously only confirmed by eye via manual Docker screenshots, never asserted here.
    // Proven two ways rather than "wider than 480px": the page's own intentional max-w-5xl cap
    // (unrelated to this fix, not something this test should second-guess) means two side-by-side
    // panes can legitimately end up *narrower* than the 480px capture regardless of browser
    // width -- so the real signal is (a) the image exactly matches its own overlay's measured
    // width, and (b) both panes end up sized equally, since a regression would leave one image
    // stuck at its intrinsic pixel size while its sibling correctly fills available space.
    const overlay = page.getByTestId("mask-overlay");
    const overlayBox = await overlay.boundingBox();
    const candidateImg = page.locator('img[alt="candidate"]');
    const dualCandidateBox = await candidateImg.boundingBox();
    if (overlayBox === null || dualCandidateBox === null) throw new Error("image not visible");
    expect(Math.abs(dualCandidateBox.width - overlayBox.width)).toBeLessThan(2);

    const baselineBox = await page.locator('img[alt="baseline"]').boundingBox();
    if (baselineBox === null) throw new Error("baseline image not visible");
    // The baseline pane's own wrapper has a p-2 padding the candidate pane's overlay doesn't
    // (16px total) -- a real, structural difference, not a bug, so the tolerance accounts for
    // it explicitly rather than being an arbitrarily loose number.
    expect(Math.abs(baselineBox.width - dualCandidateBox.width)).toBeLessThan(20);

    // Single view gives the one visible pane the full content column, with no sibling pane left
    // to share space with -- here it should clearly exceed the 480px natural capture width. This
    // is the strongest direct proof against the regression: pre-fix, the image would stay stuck
    // at 480px (or smaller) no matter how much room Single view actually gave it.
    await page.getByRole("button", { name: "Single" }).click();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });
    const singleCandidateBox = await candidateImg.boundingBox();
    if (singleCandidateBox === null) throw new Error("image not visible in single view");
    expect(singleCandidateBox.width).toBeGreaterThan(WIDTH);
    expect(singleCandidateBox.width).toBeGreaterThan(dualCandidateBox.width);
    await dogfoodCapture(page, "dogfood-snapshot-detail-single");

    await context.close();
  },
  240_000,
);

test(
  "category management: deletion is refused while a snapshot is still tagged with it",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    const deleteCatRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await capturePage(siteUrl, undefined, "delete-category-page")], {
      serverUrl,
      runId: deleteCatRunId,
    });
    await processRun({ serverUrl, runId: deleteCatRunId });
    await fetch(
      `${serverUrl}/api/runs/${deleteCatRunId}/snapshots/delete-category-page/approve`,
      { method: "POST" },
    );

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();
    const deleteCatSnapshot = page.getByRole("button", { name: /^delete-category-page/ });
    await deleteCatSnapshot.waitFor();
    await deleteCatSnapshot.click();
    await page.getByText("Status: pass").waitFor();

    const overlay = page.getByTestId("mask-overlay");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("mask overlay not visible");
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 80);
    await page.mouse.up();
    await page.getByTestId("mask-scope-picker").waitFor();
    await page.getByRole("button", { name: "+ New category" }).click();
    await page.getByLabel("New category name").fill("E2E Delete Refusal");
    await page.getByRole("button", { name: "Create & apply" }).click();
    await page.getByTestId("mask-scope-picker").waitFor({ state: "detached" });
    await page.getByText("E2E Delete Refusal (1)").waitFor();

    await page.getByRole("button", { name: "Settings" }).click();
    const categoryLabel = page.getByText("E2E Delete Refusal — 1 snapshots, 1 masks");
    await categoryLabel.waitFor();
    // Scope to this category's own row -- Settings may list other categories accumulated from
    // earlier tests against this same shared backend, each with its own "Delete" button.
    const categoryRow = categoryLabel.locator("xpath=..");
    await categoryRow.getByRole("button", { name: "Delete" }).click();
    await page.getByText(/Delete failed/).waitFor();
    // Still listed -- the refusal didn't remove it.
    await categoryLabel.waitFor();

    await context.close();
  },
  240_000,
);

test(
  "bulk approve reports a genuine partial failure, not a simulated one",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");
    if (dataDir === undefined) throw new Error("the pipeline test must run (and pass) first");

    const partialRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots(
      [
        await capturePage(siteUrl, undefined, "partial-page-a"),
        await capturePage(siteUrl, undefined, "partial-page-b"),
      ],
      { serverUrl, runId: partialRunId },
    );
    await processRun({ serverUrl, runId: partialRunId });

    // Delete one candidate image directly from disk -- a real, not simulated, failure: the
    // backend's approve endpoint genuinely 409s with "no candidate image exists yet" when this
    // happens (backend/app/api.py's approve_snapshot). Which of the two snapshots this hits
    // doesn't matter for the assertions below, only that exactly one of the two calls fails.
    const imagesDir = path.join(dataDir, "images", partialRunId);
    const snapshotDirs = readdirSync(imagesDir);
    expect(snapshotDirs.length).toBe(2);
    rmSync(path.join(imagesDir, snapshotDirs[0], "candidate.png"));

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();

    await page.getByLabel("Select partial-page-a").check();
    await page.getByLabel("Select partial-page-b").check();
    await page.getByRole("button", { name: "Approve selected (2)" }).click();
    await page.getByText("1 approved, 1 failed").waitFor();

    const passRows = await page.getByText(/^partial-page-[ab] — .* — pass$/).count();
    const stillMissingRows = await page
      .getByText(/^partial-page-[ab] — .* — approved-baseline-missing$/)
      .count();
    expect(passRows).toBe(1);
    expect(stillMissingRows).toBe(1);

    await context.close();
  },
  240_000,
);

test(
  "full pipeline with backend auth (PPS_API_TOKEN) turned on",
  async () => {
    if (siteUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (!browser) throw new Error("the pipeline test must run (and pass) first");

    // Fully self-contained: a second Flask process + viewer proxy, own data dir, own port,
    // cleaned up locally in this test's own finally block -- doesn't touch the shared
    // module-level serverUrl/viewerUrl/dataDir the other tests reuse, since introducing auth
    // onto the shared backend would break every other (deliberately unauthenticated) test.
    const authToken = "e2e-test-token";
    const authDataDir = mkdtempSync(path.join(os.tmpdir(), "pps-e2e-auth-"));
    const authPort = await freePort();
    const authServerUrl = `http://127.0.0.1:${authPort}`;
    const authFlaskEnv = { ...flaskEnv, PPS_DATA_DIR: authDataDir, PPS_API_TOKEN: authToken };
    const authFlaskProc = spawn(flaskBin, ["--app", "app", "run", "--port", String(authPort)], {
      cwd: backendDir,
      env: authFlaskEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let authFlaskStderr = "";
    authFlaskProc.stderr?.on("data", (chunk: Buffer) => (authFlaskStderr += chunk.toString()));
    let authViewerServer: Server | undefined;

    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (authFlaskProc.exitCode !== null) {
          throw new Error(
            `auth flask exited with code ${authFlaskProc.exitCode}:\n${authFlaskStderr}`,
          );
        }
        const ok = await fetch(`${authServerUrl}/api/health`).then((r) => r.ok, () => false);
        if (ok) break;
        if (Date.now() > deadline) {
          throw new Error(`auth flask never became healthy:\n${authFlaskStderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Confirmed real, not mocked: a request with no token is genuinely rejected.
      const unauthedRes = await fetch(`${authServerUrl}/api/runs`);
      expect(unauthedRes.status).toBe(401);

      // packages/client's own token support -- capture/upload/process/approve all pass an
      // explicit token, same as a real CI pipeline pointed at an auth-protected backend would.
      const authRunId = (await createRun({ serverUrl: authServerUrl, token: authToken })).id;
      await sendSnapshots([await capturePage(siteUrl, undefined, "auth-page")], {
        serverUrl: authServerUrl,
        runId: authRunId,
        token: authToken,
      });
      await processRun({ serverUrl: authServerUrl, runId: authRunId, token: authToken });
      const approveRes = await fetch(
        `${authServerUrl}/api/runs/${authRunId}/snapshots/auth-page/approve`,
        { method: "POST", headers: { Authorization: `Bearer ${authToken}` } },
      );
      expect(approveRes.status).toBe(200);

      // Serve the already-built viewer, proxying /backend/* to THIS auth-protected backend --
      // same forwarding pattern the shared viewer proxy (above) uses, just pointed elsewhere,
      // and additionally forwarding the browser's own Authorization header through.
      const viewerDist = fileURLToPath(new URL("../../viewer/dist", import.meta.url));
      const vsrv = createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname.startsWith("/backend/")) {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const contentType = req.headers["content-type"];
            const authHeader = req.headers["authorization"];
            fetch(`${authServerUrl}${pathname.slice("/backend".length)}`, {
              method: req.method,
              headers: {
                ...(contentType ? { "Content-Type": contentType } : {}),
                ...(authHeader ? { Authorization: authHeader as string } : {}),
              },
              body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
            }).then(
              async (upstream) => {
                res.writeHead(upstream.status, {
                  "Content-Type":
                    upstream.headers.get("content-type") ?? "application/octet-stream",
                });
                res.end(Buffer.from(await upstream.arrayBuffer()));
              },
              () => {
                res.writeHead(502);
                res.end();
              },
            );
          });
          return;
        }
        const filePath = pathname === "/" ? "/index.html" : pathname;
        let body: Buffer;
        try {
          body = readFileSync(path.join(viewerDist, filePath));
        } catch {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream",
        });
        res.end(body);
      });
      authViewerServer = vsrv;
      await new Promise<void>((resolve) => vsrv.listen(0, "127.0.0.1", resolve));
      const authViewerUrl = `http://127.0.0.1:${(vsrv.address() as AddressInfo).port}`;

      const context = await browser.newContext({ viewport: { width: 1200, height: 700 } });
      const page = await context.newPage();

      // Without a token set in the browser, the run list genuinely fails to load.
      await page.goto(authViewerUrl, { waitUntil: "load" });
      await page.getByText(/^Error:/).waitFor();

      // Setting the token via Settings unlocks the real, live authenticated flow.
      await page.getByRole("button", { name: "Settings" }).click();
      await page.getByLabel("Auth token").fill(authToken);
      await page.getByRole("button", { name: "Save token" }).click();
      await page.reload({ waitUntil: "load" });

      const runButtons = page.locator("ul li button");
      await runButtons.first().waitFor();
      await runButtons.first().click();
      const authSnapshot = page.getByRole("button", { name: /^auth-page/ });
      await authSnapshot.waitFor();
      await authSnapshot.click();
      await page.getByText("Status: pass").waitFor();
      await page.waitForFunction(() => {
        const img = document.querySelector<HTMLImageElement>('img[alt="baseline"]');
        return img !== null && img.naturalWidth > 0;
      });

      await context.close();
    } finally {
      if (authFlaskProc.exitCode === null) {
        authFlaskProc.kill("SIGTERM");
        await once(authFlaskProc, "exit");
      }
      if (authViewerServer?.listening) {
        authViewerServer.closeAllConnections();
        await new Promise<void>((resolve) => authViewerServer?.close(() => resolve()));
      }
      rmSync(authDataDir, { recursive: true, force: true });
    }
  },
  240_000,
);

test(
  "masks: a per-image mask drawn live genuinely suppresses a real regression, not just its own UI",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    // Every existing masks test only proves the UI's create/save/delete CRUD -- none of them
    // ever re-check a run's pass/fail outcome, so none actually prove a mask drawn through the
    // live browser does what it's for: suppressing a real pixel diff. This one does, end to end.
    const name = "mask-effect-unique-page";
    const baselineRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await captureCleanPage(siteUrl, name)], {
      serverUrl,
      runId: baselineRunId,
    });
    await processRun({ serverUrl, runId: baselineRunId });
    await fetch(`${serverUrl}/api/runs/${baselineRunId}/snapshots/${name}/approve`, {
      method: "POST",
    });

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();
    const snapshotBtn = page.getByRole("button", { name: new RegExp(`^${name} `) });
    await snapshotBtn.waitFor();
    await snapshotBtn.click();
    await page.getByText("Status: pass").waitFor();

    const overlay = page.getByTestId("mask-overlay");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("mask overlay not visible");
    // Generous, near-full-image coverage rather than precisely targeting the .box element --
    // pixel-precise mask boundary correctness is already thoroughly proven at the backend layer
    // (backend/tests/test_render.py's test_mask_covers_region_no_fail deliberately checks
    // off-by-one edge behavior); the point here is only that a mask genuinely drawn and saved
    // through the real browser takes effect at all.
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5);
    await page.mouse.up();
    await page.getByTestId("mask-scope-picker").waitFor();
    await page.getByRole("button", { name: "Save as mask for this snapshot" }).click();
    await page.getByTestId("mask-scope-picker").waitFor({ state: "detached" });
    await page.getByTestId("mask-rect").waitFor();

    await context.close();

    // Per-image masks are keyed by (name, viewport), not by run (backend/app/render.py's
    // image_path/applicable_masks) -- so this new run, uploaded and processed for the first
    // time *after* the mask above was saved, must come out "pass" directly. Unlike the backend's
    // own tests (which insert the mask before ever calling process()), this is the first place
    // that ordering is proven through the real upload -> mask -> process sequence a real user
    // would follow, driven by an actual live-browser mask-creation action, not a DB fixture.
    const regressionRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await captureRegressedPage(siteUrl, name)], {
      serverUrl,
      runId: regressionRunId,
    });
    await processRun({ serverUrl, runId: regressionRunId });
    const detail = await fetch(`${serverUrl}/api/runs/${regressionRunId}/snapshots/${name}`).then(
      (r) => r.json(),
    );
    expect(detail.status).toBe("pass");
  },
  240_000,
);

test(
  "masks: a category mask created live suppresses a regression on a different snapshot name entirely",
  async () => {
    if (serverUrl === "") throw new Error("the pipeline test must run (and pass) first");
    if (viewerUrl === "") throw new Error("the viewer test must run (and pass) first");

    // The actual point of category masks (vs. per-image ones): defined once against one
    // snapshot, they apply to any other snapshot -- any name -- that shares the category. Proven
    // here across two genuinely different names, mirroring the backend's own
    // test_category_mask_applies_across_snapshot_names_in_same_category, but through the real
    // browser mask-creation flow instead of a DB fixture.
    const nameA = "mask-effect-category-page-a";
    const nameB = "mask-effect-category-page-b";
    const category = "E2E Mask Effect Category";

    // Both names need their own pre-existing baseline -- a mask only suppresses a *diff*
    // against something; it can't manufacture a first-ever baseline for a name that's never
    // been approved before (confirmed by first running this test without this nameB baseline:
    // it failed with status "approved-baseline-missing", not "pass" -- the real backend
    // behavior, not a test bug, matching the backend's own
    // test_category_mask_applies_across_snapshot_names_in_same_category establishing both
    // names' baselines up front too).
    const baselineRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots(
      [await captureCleanPage(siteUrl, nameA), await captureCleanPage(siteUrl, nameB)],
      { serverUrl, runId: baselineRunId },
    );
    await processRun({ serverUrl, runId: baselineRunId });
    await fetch(`${serverUrl}/api/runs/${baselineRunId}/snapshots/${nameA}/approve`, {
      method: "POST",
    });
    await fetch(`${serverUrl}/api/runs/${baselineRunId}/snapshots/${nameB}/approve`, {
      method: "POST",
    });

    const context = await browser!.newContext({ viewport: { width: 1200, height: 700 } });
    const page = await context.newPage();
    await page.goto(viewerUrl, { waitUntil: "load" });

    const runButtons = page.locator("ul li button");
    await runButtons.first().waitFor();
    await runButtons.first().click();
    const snapshotBtn = page.getByRole("button", { name: new RegExp(`^${nameA} `) });
    await snapshotBtn.waitFor();
    await snapshotBtn.click();
    await page.getByText("Status: pass").waitFor();

    const overlay = page.getByTestId("mask-overlay");
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('img[alt="candidate"]');
      return img !== null && img.naturalWidth > 0;
    });
    const box = await overlay.boundingBox();
    if (box === null) throw new Error("mask overlay not visible");
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5);
    await page.mouse.up();
    await page.getByTestId("mask-scope-picker").waitFor();
    await page.getByRole("button", { name: "+ New category" }).click();
    await page.getByLabel("New category name").fill(category);
    await page.getByRole("button", { name: "Create & apply" }).click();
    await page.getByTestId("mask-scope-picker").waitFor({ state: "detached" });
    await page.getByText(`${category} (1)`).waitFor();

    await context.close();

    // nameB has never existed before this point -- it only shares the category, set at upload
    // time via capturePage's category param (all snapshots sharing a category must share a
    // viewport too, which the shared default WIDTH/HEIGHT here satisfies automatically).
    const regressionRunId = (await createRun({ serverUrl })).id;
    await sendSnapshots([await captureRegressedPage(siteUrl, nameB, category)], {
      serverUrl,
      runId: regressionRunId,
    });
    await processRun({ serverUrl, runId: regressionRunId });
    const detail = await fetch(
      `${serverUrl}/api/runs/${regressionRunId}/snapshots/${nameB}`,
    ).then((r) => r.json());
    expect(detail.status).toBe("pass");
  },
  240_000,
);
