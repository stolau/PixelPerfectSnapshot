#!/usr/bin/env node
// Dogfoods PixelPerfectSnapshot on its own viewer UI: captures a handful of the viewer's own key
// screens with the real client library, and uploads/processes them against a REAL, persistent
// backend -- unlike e2e.test.ts's fully ephemeral per-run backend, this is meant to be pointed at
// a long-lived, hosted instance. Review and approval happen through that same real viewer, like
// any other snapshot -- this script never auto-approves. That's the point: once pointed at a
// hosted instance, a genuine layout regression in the viewer itself (the kind Docker/Podman
// screenshots have caught by hand this project's history -- an image silently shrinking to its
// intrinsic size, a popup drifting off its anchor) shows up as a real, reviewable diff, the same
// way any other product's regression would.
//
// Usage:
//   PPS_SERVER_URL=https://your-backend PPS_VIEWER_URL=https://your-viewer \
//     [PPS_API_TOKEN=...] node dogfood-viewer.mjs
//
// Snapshot names are fixed ("dogfood-run-list", "dogfood-snapshot-detail-dual", ...) so each run
// of this script diffs against whatever was previously approved for that name -- there is
// nothing dogfood-specific about the diffing itself, it's the same mechanism as any other use of
// the product. Each run also seeds a small amount of fresh underlying demo data (a "dogfood-"
// prefixed run/category) so there's always something real to look at, even against a brand new
// instance -- this accumulates over repeated runs, same as any product's real usage would; this
// script doesn't attempt to manage retention.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createRun, processRun, sendSnapshots } from "pixelperfectsnapshot";

const serverUrl = process.env.PPS_SERVER_URL;
const viewerUrl = process.env.PPS_VIEWER_URL;
const token = process.env.PPS_API_TOKEN;

if (!serverUrl) {
  throw new Error("PPS_SERVER_URL is required -- the backend to dogfood against");
}
if (!viewerUrl) {
  throw new Error("PPS_VIEWER_URL is required -- the deployed viewer whose pages get captured");
}

const siteDir = fileURLToPath(new URL("site", import.meta.url));
const clientDist = path.dirname(createRequire(import.meta.url).resolve("pixelperfectsnapshot"));
const captureBundle = path.join(clientDist, "capture.js");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

// A local static server for the demo site, used only to seed a small amount of fresh underlying
// data (below) -- not itself captured by this script.
const siteServer = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  let body;
  try {
    body = readFileSync(path.join(siteDir, pathname));
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(pathname)] ?? "application/octet-stream" });
  res.end(body);
});
await new Promise((resolve) => siteServer.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://127.0.0.1:${siteServer.address().port}`;

const browser = await chromium.launch();

async function captureSitePage(name, variant, viewport = { width: 480, height: 360 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${siteUrl}/index.html`, { waitUntil: "load" });
  if (variant === "changed") {
    // Same trick e2e.test.ts uses for its own regression run -- swap the .box color client-side
    // rather than needing a second static server, so this stays a single self-contained file.
    await page.evaluate(() => {
      const box = document.querySelector(".box");
      if (box instanceof HTMLElement) box.style.background = "#c0392b";
    });
  }
  await page.addScriptTag({ path: captureBundle });
  const snapshot = await page.evaluate((n) => window.__ppsCapture(document, n), name);
  await context.close();
  return snapshot;
}

/** Captures whatever's currently on screen in a live viewer page -- the dogfood target itself. */
async function captureViewerPage(page, name) {
  await page.addScriptTag({ path: captureBundle });
  return page.evaluate((n) => window.__ppsCapture(document, n), name);
}

console.log(`Seeding fresh demo data on ${serverUrl}...`);
const seedName = "dogfood-seed-page";

const baselineRunId = (await createRun({ serverUrl, token })).id;
await sendSnapshots([await captureSitePage(seedName, "original")], {
  serverUrl,
  runId: baselineRunId,
  token,
});
await processRun({ serverUrl, runId: baselineRunId, token });
await fetch(`${serverUrl}/api/runs/${baselineRunId}/snapshots/${seedName}/approve`, {
  method: "POST",
  headers: token ? { Authorization: `Bearer ${token}` } : undefined,
});

// A real regression against the baseline just approved above, so the run list / run detail /
// snapshot detail pages this script is about to capture have an actual fail status and diff
// image to render -- not just a flat wall of "pass".
const regressionRunId = (await createRun({ serverUrl, token })).id;
await sendSnapshots([await captureSitePage(seedName, "changed")], {
  serverUrl,
  runId: regressionRunId,
  token,
});
await processRun({ serverUrl, runId: regressionRunId, token });

console.log(`Driving ${viewerUrl} to capture its own key pages...`);
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
await page.goto(viewerUrl, { waitUntil: "load" });

if (token) {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Auth token").fill(token);
  await page.getByRole("button", { name: "Save token" }).click();
  await page.goto(viewerUrl, { waitUntil: "load" });
}

const viewerSnapshots = [];

await page.locator("ul li button").first().waitFor();
viewerSnapshots.push(await captureViewerPage(page, "dogfood-run-list"));

await page.locator("ul li button").first().click();
await page.locator("ul li button").first().waitFor();
viewerSnapshots.push(await captureViewerPage(page, "dogfood-run-detail"));

await page.locator("ul li button").first().click();
await page.waitForFunction(() => {
  const img = document.querySelector('img[alt="candidate"]');
  return img !== null && img.naturalWidth > 0;
});
viewerSnapshots.push(await captureViewerPage(page, "dogfood-snapshot-detail-dual"));

await page.getByRole("button", { name: "Single" }).click();
await page.waitForFunction(() => {
  const img = document.querySelector('img[alt="candidate"]');
  return img !== null && img.naturalWidth > 0;
});
viewerSnapshots.push(await captureViewerPage(page, "dogfood-snapshot-detail-single"));

await page.getByRole("button", { name: "Settings" }).click();
await page.getByText("Authentication").waitFor();
viewerSnapshots.push(await captureViewerPage(page, "dogfood-settings"));

await page.getByRole("button", { name: "Branches & Releases" }).click();
await page.getByText("Branches", { exact: true }).waitFor();
viewerSnapshots.push(await captureViewerPage(page, "dogfood-branches-releases"));

await context.close();
await browser.close();
siteServer.close();

console.log(`Uploading ${viewerSnapshots.length} viewer-UI snapshots...`);
const dogfoodRunId = (await createRun({ serverUrl, token })).id;
await sendSnapshots(viewerSnapshots, { serverUrl, runId: dogfoodRunId, token });
await processRun({ serverUrl, runId: dogfoodRunId, token });

console.log(
  `Done. Open ${viewerUrl} and review run ${dogfoodRunId} -- ` +
    "first run for each name needs an initial approval; after that, a real layout regression " +
    "in the viewer itself shows up here as a genuine diff, same as any other snapshot.",
);
