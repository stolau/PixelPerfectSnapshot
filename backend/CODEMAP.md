# backend — CODEMAP

Flask backend: receives snapshot uploads, stores them, (later) re-renders and pixel-diffs against
approved baselines. HTTP contract: `docs/API.md`. Upload payload contract:
`docs/snapshot.schema.json`.

## Layout

- `app/__init__.py` — `create_app(data_dir=None)` Flask application factory. Endpoints:
  `GET /api/health`. Registers the API blueprint, JSON 404/405 error handlers, and the
  `process-pending` CLI command. Config: `PIXEL_THRESHOLD` (env `PPS_PIXEL_THRESHOLD`, default 3,
  max per-channel difference treated as noise) and `MAX_DIFF_RATIO` (env `PPS_MAX_DIFF_RATIO`,
  default 0.001, max fraction of differing pixels for a pass).
- `app/api.py` — `/api` blueprint implementing `docs/API.md`: `POST /api/runs`, `GET /api/runs`,
  `GET /api/runs/<run_id>`, `POST /api/runs/<run_id>/snapshots` (schema-validated),
  `GET /api/runs/<run_id>/snapshots/<name>`,
  `GET /api/runs/<run_id>/snapshots/<name>/images/<kind>` (serves the PNGs; 404 until rendered),
  `POST /api/runs/<run_id>/snapshots/<name>/approve` (promotes the candidate PNG to baseline,
  status → `pass`; 409 if no candidate yet).
- `app/render.py` — render engine: `process_pending()` re-renders each `pending` snapshot in
  headless Chromium (network aborted; injects the built `packages/client/dist/rehydrate.js`),
  screenshots a candidate PNG, and Pillow-diffs it against the approved baseline (`compare()`,
  always writes a red-on-grayscale diff PNG). Path helpers: `baseline_path()`, `image_path()`.
- `app/db.py` — SQLite plumbing (stdlib `sqlite3`): schema, per-request connection via `flask.g`.
- `tests/` — pytest suite (uses the Flask test client; also validates
  `docs/examples/example-snapshot.json` against the schema).

## Storage

Data dir: `create_app(data_dir=...)` arg, else `PPS_DATA_DIR` env var, else `backend/data/`
(gitignored). Holds:

- `pps.sqlite3` — run/snapshot metadata.
- `blobs/<run_id>/<snapshot_id>.json` — uploaded snapshot documents.
- `images/<run_id>/<snapshot_id>/{candidate,diff}.png` — rendered candidate and diff PNGs.
- `baselines/<sha256(name\nWxH)>.png` — approved baselines, keyed globally by (name, viewport).

## Commands

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/pytest
.venv/bin/flask --app app run              # dev server
.venv/bin/flask --app app process-pending  # render + compare pending snapshots
```

`process-pending` needs the built client artifact (`npm ci && npm run build -w packages/client` at
the repo root) and an installed browser (`.venv/bin/playwright install chromium`).
