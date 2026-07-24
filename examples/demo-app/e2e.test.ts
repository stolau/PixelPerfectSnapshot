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
import { createRun, processRun, sendSnapshots, type Snapshot } from "@stolau/pixelperfectsnapshot";
import { afterAll, expect, test } from "vitest";

const siteDir = fileURLToPath(new URL("site", import.meta.url));
const backendDir = fileURLToPath(new URL("../../backend", import.meta.url));
const clientDist = path.dirname(
  createRequire(import.meta.url).resolve("@stolau/pixelperfectsnapshot"),
);
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
  const snapshot = await page.evaluate((name) => window.__ppsCapture(document, name), "demo-page");
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
        // Forward to flask with the prefix stripped. The only POST (approve) has no body.
        fetch(`${serverUrl}${pathname.slice("/backend".length)}`, { method: req.method }).then(
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
    const viewerUrl = `http://127.0.0.1:${(vsrv.address() as AddressInfo).port}`;

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
    expect(await page.getByText("not available").count()).toBe(2); // baseline + diff panes

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
    for (const alt of ["baseline", "candidate", "diff"]) {
      await page.waitForFunction((a) => {
        const img = document.querySelector<HTMLImageElement>(`img[alt="${a}"]`);
        return img !== null && img.naturalWidth > 0;
      }, alt);
    }

    await context.close();
  },
  240_000,
);
