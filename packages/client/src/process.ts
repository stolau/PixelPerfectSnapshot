/**
 * Triggers synchronous processing of a run's pending snapshots via
 * `POST {serverUrl}/api/runs/{runId}/process` (docs/API.md). Throws on a non-ok
 * response, including its status and body.
 */
export async function processRun(opts: { serverUrl: string; runId: string }): Promise<void> {
  const res = await fetch(
    `${opts.serverUrl}/api/runs/${encodeURIComponent(opts.runId)}/process`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Processing run "${opts.runId}" failed: ${res.status} ${body}`);
  }
}
