/**
 * Triggers synchronous processing of a run's pending snapshots via
 * `POST {serverUrl}/api/runs/{runId}/process` (docs/API.md). Throws on a non-ok
 * response, including its status and body.
 *
 * `opts.serverUrl` falls back to `process.env.PPS_SERVER_URL` when omitted; throws if
 * neither is provided.
 *
 * `opts.token` falls back to `process.env.PPS_API_TOKEN` when omitted; if neither is set, no
 * `Authorization` header is sent (valid when the backend has auth off).
 */
export async function processRun(
  opts: { serverUrl?: string; runId: string; token?: string },
): Promise<void> {
  const serverUrl = resolveServerUrl(opts.serverUrl);
  const token = resolveToken(opts.token);
  const res = await fetch(
    `${serverUrl}/api/runs/${encodeURIComponent(opts.runId)}/process`,
    { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : undefined },
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

function resolveToken(explicit: string | undefined): string | undefined {
  return explicit ?? process.env.PPS_API_TOKEN;
}
