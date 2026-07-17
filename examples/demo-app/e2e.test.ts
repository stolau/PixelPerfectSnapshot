import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { sendSnapshots, type Snapshot } from "pixelperfectsnapshot";
import { afterAll, expect, test } from "vitest";

declare global {
  interface Window {
    __ppsCapture(doc: Document, name: string): Promise<Snapshot>;
  }
}

const siteDir = fileURLToPath(new URL("site", import.meta.url));
const backendDir = fileURLToPath(new URL("../../backend", import.meta.url));
const clientDist = path.dirname(createRequire(import.meta.url).resolve("pixelperfectsnapshot"));
const captureBundle = path.join(clientDist, "capture.js");

const WIDTH = 480;
const HEIGHT = 360;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};

let flaskProc: ChildProcess | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let dataDir: string | undefined;
/** The static server swaps the .box color when this is "changed" (run 3's regression). */
let variant: "original" | "changed" = "original";

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

async function capturePage(baseUrl: string): Promise<Snapshot> {
  if (!browser) throw new Error("browser not launched");
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
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
    const siteUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    // The real Flask backend, with a throwaway data dir.
    const venvFlask = path.join(backendDir, ".venv", "bin", "flask");
    const flaskBin = process.env.PPS_FLASK ?? (existsSync(venvFlask) ? venvFlask : "flask");
    const flaskEnv = { ...process.env, PPS_DATA_DIR: dataDir };
    const flaskPort = await freePort();
    const serverUrl = `http://127.0.0.1:${flaskPort}`;
    flaskProc = spawn(flaskBin, ["--app", "app", "run", "--port", String(flaskPort)], {
      cwd: backendDir,
      env: flaskEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let flaskStderr = "";
    flaskProc.stderr?.on("data", (chunk: Buffer) => (flaskStderr += chunk.toString()));
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (flaskProc.exitCode !== null) {
        throw new Error(`flask exited with code ${flaskProc.exitCode}:\n${flaskStderr}`);
      }
      const ok = await fetch(`${serverUrl}/api/health`).then((r) => r.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`flask never became healthy:\n${flaskStderr}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const processPending = () => {
      const out = execFileSync(flaskBin, ["--app", "app", "process-pending"], {
        cwd: backendDir,
        env: flaskEnv,
      }).toString();
      console.log(`process-pending:\n${out.trimEnd()}`);
    };
    const createRun = async (): Promise<string> => {
      const res = await fetch(`${serverUrl}/api/runs`, { method: "POST" });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const getSnapshotDetail = async (runId: string) => {
      const res = await fetch(`${serverUrl}/api/runs/${runId}/snapshots/demo-page`);
      expect(res.status).toBe(200);
      return (await res.json()) as {
        status: string;
        baselineUrl: string | null;
        candidateUrl: string | null;
        diffUrl: string | null;
      };
    };

    // 1. Run 1: capture the live demo page and upload it — status starts "pending".
    browser = await chromium.launch();
    const run1 = await createRun();
    const snapshot1 = await capturePage(siteUrl);
    expect(snapshot1.name).toBe("demo-page");
    expect(snapshot1.viewport).toEqual({ width: WIDTH, height: HEIGHT });
    await sendSnapshots([snapshot1], { serverUrl, runId: run1 });
    const run1Listing = await fetch(`${serverUrl}/api/runs/${run1}`).then((r) => r.json());
    expect(run1Listing.snapshots).toEqual([
      { name: "demo-page", viewport: { width: WIDTH, height: HEIGHT }, status: "pending" },
    ]);

    // 2. Render it: no baseline exists yet, so it needs approval.
    processPending();
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
    const run2 = await createRun();
    await sendSnapshots([await capturePage(siteUrl)], { serverUrl, runId: run2 });
    processPending();
    expect((await getSnapshotDetail(run2)).status).toBe("pass");

    // 5. Run 3: a real visual regression (box color change) must fail with a diff image.
    variant = "changed";
    const run3 = await createRun();
    await sendSnapshots([await capturePage(siteUrl)], { serverUrl, runId: run3 });
    processPending();
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
