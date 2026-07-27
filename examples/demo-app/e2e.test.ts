import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
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
  const snapshot = await page.evaluate((n) => window.__ppsCapture(document, n), name);
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

    // Run 4 detail: approval needed at the new viewport.
    await runButtons.first().click();
    const run4Snapshot = page.getByRole("button", {
      name: "demo-page — 320x240 — approved-baseline-missing",
    });
    await run4Snapshot.waitFor();

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
