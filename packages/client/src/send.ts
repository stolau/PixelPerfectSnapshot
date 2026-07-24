import type { Snapshot } from "./index.js";

/**
 * Uploads snapshots sequentially to `POST {serverUrl}/api/runs/{runId}/snapshots`
 * (docs/API.md). Throws on the first non-ok response, including its status and body.
 *
 * `opts.serverUrl` falls back to `process.env.PPS_SERVER_URL` when omitted; throws if
 * neither is provided.
 *
 * `opts.token` falls back to `process.env.PPS_API_TOKEN` when omitted; if neither is set, no
 * `Authorization` header is sent (valid when the backend has auth off).
 */
export async function sendSnapshots(
  snapshots: Snapshot[],
  opts: { serverUrl?: string; runId: string; token?: string },
): Promise<void> {
  const serverUrl = resolveServerUrl(opts.serverUrl);
  const token = resolveToken(opts.token);
  for (const snapshot of snapshots) {
    const res = await fetch(
      `${serverUrl}/api/runs/${encodeURIComponent(opts.runId)}/snapshots`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(snapshot),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Uploading snapshot "${snapshot.name}" failed: ${res.status} ${body}`);
    }
  }
}

function resolveServerUrl(explicit: string | undefined): string {
  const serverUrl = explicit ?? process.env.PPS_SERVER_URL;
  if (!serverUrl) {
    throw new Error(
      "No serverUrl provided: pass opts.serverUrl or set the PPS_SERVER_URL environment variable.",
    );
  }
  return serverUrl;
}

function resolveToken(explicit: string | undefined): string | undefined {
  return explicit ?? process.env.PPS_API_TOKEN;
}
