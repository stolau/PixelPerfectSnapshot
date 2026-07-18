# PixelPerfectSnapshot

CI-runnable visual snapshot testing: capture DOM snapshots in your e2e tests, re-render and
pixel-diff them against human-approved baselines on a server, review and approve in a web viewer.

## Layout

| Path | What | Stack |
|---|---|---|
| `packages/client/` | npm library installed into target projects; captures and uploads snapshots | TypeScript |
| `backend/` | receives snapshots, re-renders, pixel-diffs against baselines | Python / Flask |
| `viewer/` | web UI for runs, diffs, and baseline approval | React + Vite + TypeScript |
| `docs/` | the frozen contracts: [snapshot format](docs/SNAPSHOT_FORMAT.md) · [HTTP API](docs/API.md) |

Each package documents its public surface in a `CODEMAP.md`.

## Quickstart

Add PixelPerfectSnapshot to your own e2e test suite.

1. **Install the client** in your project:
   ```sh
   npm install --save-dev pixelperfectsnapshot
   ```
2. **Start the backend.** Simplest for local use — a Python venv running Flask directly:
   ```sh
   cd backend
   python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
   .venv/bin/flask --app app run   # serves on http://localhost:5000 by default
   ```
   (see `backend/CODEMAP.md` for the full command list). Alternatively, run
   `docker compose up` (see "Running with Docker" below) — in that case the API is reached
   through the viewer's proxy at `http://localhost:8080`, not `:5000`; use that as your
   `serverUrl` instead.
3. **Capture, upload, and process a snapshot** from your own test code (assumes the local-venv
   backend above, reachable at `:5000`):
   ```ts
   import { captureSnapshot, createRun, sendSnapshots, processRun } from "pixelperfectsnapshot";

   const { id: runId } = await createRun({ serverUrl: "http://localhost:5000" });
   const snapshot = await captureSnapshot(document, "my-page");
   await sendSnapshots([snapshot], { serverUrl: "http://localhost:5000", runId });
   await processRun({ serverUrl: "http://localhost:5000", runId });
   ```
4. **Review and approve** in the viewer (`http://localhost:8080` under `docker compose up`):
   open the run, inspect the diff, and approve a snapshot to promote it to the new baseline.

For the full HTTP contract see [docs/API.md](docs/API.md), for the client's public API see
[packages/client/README.md](packages/client/README.md), and for a complete working example see
[examples/demo-app](examples/demo-app).

## Development

```sh
npm install          # TS workspaces (packages/client, viewer)
npm run lint && npm test

cd backend
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/pytest
```

## Running with Docker

```sh
docker compose up --build   # first run (or plain `docker compose up` after images are built)
```

This builds and starts the `backend` and `viewer` services. The viewer is reachable at
`http://localhost:8080`; nginx reverse-proxies its `/api/*` requests to the backend container, so
the backend itself is not published to the host.

Data persists in the `pps-data` named volume, mounted at `/data` inside the backend container
(`PPS_DATA_DIR=/data`). It holds `pps.sqlite3` (run/snapshot metadata), `blobs/` (uploaded snapshot
documents), `images/` (rendered candidate and diff PNGs), and `baselines/` (approved baseline
PNGs) — see `backend/CODEMAP.md` for the full layout. This data survives `docker compose down`
(without `-v`); use `docker compose down -v` to also delete the volume.

`PPS_ALLOWED_ORIGIN` (CORS) does not need to be set in this setup: since nginx reverse-proxies
`/api/*` to the backend, the browser sees everything as same-origin.

The backend container runs the Flask dev server intentionally, not gunicorn/waitress/uwsgi. Each
`/api/runs/<run_id>/process` call launches one real headless Chromium instance per snapshot
rendered, and "concurrent calls for the same run may duplicate render work" (see
[docs/API.md](docs/API.md)) — the system is designed around single-worker, roughly-serial
processing. A multi-worker WSGI server would just multiply concurrent Chromium instances for no
benefit. This is a self-hosted local tool, not built for concurrent multi-worker load.
