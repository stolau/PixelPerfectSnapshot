# Self-hosting

This project is self-hosted only — there is no managed service. Two deployment topologies are
supported: backend and viewer on the **same host** (the documented, simplest path — see the
README's ["Running with Docker"](../README.md#running-with-docker) section), or on **separate
hosts/domains** (this doc).

## Environment variables

All backend configuration is via environment variables (`backend/app/__init__.py`). None are
required — every one has a safe default or is off unless set.

| Variable | Default | Purpose |
|---|---|---|
| `PPS_DATA_DIR` | `backend/data` | Where `pps.sqlite3`, `blobs/`, `images/`, and `baselines/` are stored. Set to a persistent, writable path (or a mounted volume — see the Docker Compose section). |
| `PPS_API_TOKEN` | unset (no auth) | Shared-secret bearer token. When set, every `/api/*` route except `GET /api/health` requires `Authorization: Bearer <token>`. See [docs/API.md](API.md). |
| `PPS_ALLOWED_ORIGIN` | unset (no CORS) | Comma-separated list of origins allowed to make cross-origin requests (e.g. `https://viewer.example.com`). Required for Topology B below; leave unset for Topology A, where nginx makes everything same-origin so CORS is irrelevant. |
| `PPS_PIXEL_THRESHOLD` | `3` | Per-channel pixel-value difference below which a pixel counts as unchanged. |
| `PPS_MAX_DIFF_RATIO` | `0.001` | Fraction of differing pixels above which a snapshot is `fail` instead of `pass`. |
| `PPS_MAX_UPLOAD_BYTES` | `26214400` (25MB) | Max request body size; oversized requests get a `413`. |

The npm client (`pixelperfectsnapshot`, `packages/client/README.md`) reads `PPS_SERVER_URL` and
`PPS_API_TOKEN` as fallbacks for the `serverUrl`/`token` params on `createRun`/`sendSnapshots`/
`processRun`, so a CI job can point at any backend — local, same-host, or separate-host — purely
via env vars, no code changes.

## Topology A — same host (documented in the README)

`docker compose up` builds and runs backend + viewer together; nginx reverse-proxies the viewer's
`/api/*` requests to the backend container, so the browser sees everything as same-origin. No
`PPS_ALLOWED_ORIGIN` needed. See the README for the full walkthrough.

## Topology B — separate hosts

Useful when the backend and viewer are deployed independently (different hosts, different
platforms, a viewer served from a static host/CDN pointed at a backend running elsewhere, etc).

**1. Build and run the backend**, reachable at its own public URL, with CORS and auth configured
for the viewer's real origin:

```sh
docker build -f backend/Dockerfile -t pps-backend .
docker run -d -p 5000:5000 \
  -e PPS_DATA_DIR=/data -v pps-data:/data \
  -e PPS_ALLOWED_ORIGIN=https://viewer.example.com \
  -e PPS_API_TOKEN=<a long random secret> \
  pps-backend
```

**2. Build the viewer with `VITE_API_BASE` pointed at that backend's public URL** — this is a
Vite build-time env var (`import.meta.env.VITE_API_BASE`, `viewer/src/api.ts`), so it must be set
at `docker build` time via `--build-arg`, not as a container runtime env var:

```sh
docker build -f viewer/Dockerfile \
  --build-arg VITE_API_BASE=https://backend.example.com \
  -t pps-viewer .
docker run -d -p 8080:80 pps-viewer
```

Leaving `--build-arg` off entirely reproduces Topology A's default (empty `VITE_API_BASE`, same-
origin) — this ARG defaults to `""`, so `docker-compose.yml`'s existing build needs no changes at
all for Topology A to keep working exactly as before.

**3. Provide the token from the browser.** The viewer's own Settings page (`AuthTokenInput`) has a
field for exactly this — paste the same token you set as `PPS_API_TOKEN` above, stored in
`sessionStorage` and sent as `Authorization: Bearer <token>` on every request the viewer makes,
including image loads (`AuthenticatedImage`).

**4. Point CI's capture/upload/process/approve calls at the backend's public URL** the same way,
via `PPS_SERVER_URL`/`PPS_API_TOKEN` env vars or explicit `serverUrl`/`token` params.

Swap `docker build`/`docker run` above for `podman build`/`podman run` (or `podman-compose`) if
you're using Podman — the commands and build args are identical either way.
