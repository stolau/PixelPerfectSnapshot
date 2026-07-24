/**
 * Creates a new run via `POST {serverUrl}/api/runs` (docs/API.md). Throws on a non-ok
 * response, including its status and body.
 *
 * `opts.serverUrl` falls back to `process.env.PPS_SERVER_URL` when omitted; throws if
 * neither is provided.
 *
 * `opts.token` falls back to `process.env.PPS_API_TOKEN` when omitted; if neither is set, no
 * `Authorization` header is sent (valid when the backend has auth off).
 */
export async function createRun(
  opts: { serverUrl?: string; token?: string },
): Promise<{ id: string; createdAt: string }> {
  const serverUrl = resolveServerUrl(opts.serverUrl);
  const token = resolveToken(opts.token);
  const res = await fetch(`${serverUrl}/api/runs`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Creating run failed: ${res.status} ${body}`);
  }
  return res.json();
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
