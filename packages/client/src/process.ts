/**
 * Triggers synchronous processing of a run's pending snapshots via
 * `POST {serverUrl}/api/runs/{runId}/process` (docs/API.md). Throws on a non-ok
 * response, including its status and body.
 *
 * `opts.serverUrl` falls back to `process.env.PPS_SERVER_URL` when omitted; throws if
 * neither is provided.
 */
export async function processRun(opts: { serverUrl?: string; runId: string }): Promise<void> {
  const serverUrl = resolveServerUrl(opts.serverUrl);
  const res = await fetch(
    `${serverUrl}/api/runs/${encodeURIComponent(opts.runId)}/process`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Processing run "${opts.runId}" failed: ${res.status} ${body}`);
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
