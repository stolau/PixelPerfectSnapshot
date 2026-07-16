import type { Snapshot } from "./index.js";

/**
 * Uploads snapshots sequentially to `POST {serverUrl}/api/runs/{runId}/snapshots`
 * (docs/API.md). Throws on the first non-ok response, including its status and body.
 */
export async function sendSnapshots(
  snapshots: Snapshot[],
  opts: { serverUrl: string; runId: string },
): Promise<void> {
  for (const snapshot of snapshots) {
    const res = await fetch(
      `${opts.serverUrl}/api/runs/${encodeURIComponent(opts.runId)}/snapshots`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Uploading snapshot "${snapshot.name}" failed: ${res.status} ${body}`);
    }
  }
}
