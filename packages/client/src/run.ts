/**
 * Creates a new run via `POST {serverUrl}/api/runs` (docs/API.md). Throws on a non-ok
 * response, including its status and body.
 */
export async function createRun(opts: { serverUrl: string }): Promise<{ id: string; createdAt: string }> {
  const res = await fetch(`${opts.serverUrl}/api/runs`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Creating run failed: ${res.status} ${body}`);
  }
  return res.json();
}
