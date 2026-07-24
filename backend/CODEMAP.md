# backend — CODEMAP

Flask backend: receives snapshot uploads, stores them, (later) re-renders and pixel-diffs against
approved baselines. HTTP contract: `docs/API.md`. Upload payload contract:
`docs/snapshot.schema.json`.

## Layout

- `app/__init__.py` — `create_app(data_dir=None)` Flask application factory. Endpoints:
  `GET /api/health`. Registers the API blueprint, JSON 404/405/413 error handlers, and the
  `process-pending` CLI command. Config: `PIXEL_THRESHOLD` (env `PPS_PIXEL_THRESHOLD`, default 3,
  max per-channel difference treated as noise), `MAX_DIFF_RATIO` (env `PPS_MAX_DIFF_RATIO`,
  default 0.001, max fraction of differing pixels for a pass), `MAX_CONTENT_LENGTH` (env
  `PPS_MAX_UPLOAD_BYTES`, default 25 MB, Werkzeug's built-in request body size cap; oversized
  requests get a 413), `ALLOWED_ORIGIN` (env `PPS_ALLOWED_ORIGIN`, comma-separated list of
  origins allowed to make cross-origin requests; unset → no CORS headers are sent, same-origin
  only), and `API_TOKEN` (env `PPS_API_TOKEN`; unset → auth fully off, same as today).
- `app/api.py` — `/api` blueprint implementing `docs/API.md`. A `before_request` hook on the
  blueprint enforces `API_TOKEN` when set: requires `Authorization: Bearer <token>` (compared with
  `hmac.compare_digest`), returning the standard `{"error": ...}` 401 shape on a missing/malformed
  header or mismatch; `OPTIONS` requests and `GET /api/health` (registered outside the blueprint)
  are exempt. Routes: `POST /api/runs`, `GET /api/runs`,
  `GET /api/runs/<run_id>`, `POST /api/runs/<run_id>/snapshots` (schema-validated),
  `GET /api/runs/<run_id>/snapshots/<name>`,
  `GET /api/runs/<run_id>/snapshots/<name>/images/<kind>` (serves the PNGs; 404 until rendered),
  `GET /api/runs/<run_id>/snapshots/<name>/history` (lists history entries newest-first),
  `GET /api/runs/<run_id>/snapshots/<name>/history/<timestamp>` (serves a history PNG; 404 unknown
  timestamp),
  `POST /api/runs/<run_id>/snapshots/<name>/approve` (promotes the candidate PNG to baseline,
  preserving the outgoing baseline under `baselines/history/`, status → `pass`; 409 if no
  candidate yet),
  `POST /api/runs/<run_id>/process` (synchronously renders the run's pending snapshots, returns
  the `GET /api/runs/<run_id>` body; 500 if the rehydrate bundle is missing),
  `GET /api/masks` / `POST /api/masks` / `DELETE /api/masks/<mask_id>` (global masks, `name IS
  NULL`; delete 404s if the id doesn't exist among global masks),
  `GET /api/runs/<run_id>/snapshots/<name>/masks` (the resolved, combined view via
  `applicable_masks()` — global masks plus this snapshot's per-image masks; 404 unknown run or
  name),
  `POST /api/runs/<run_id>/snapshots/<name>/masks` (creates a per-image mask keyed by the
  snapshot's (name, viewport), like a baseline — applies to every future run of that test case;
  400 if the mask exceeds the resolved snapshot's viewport bounds; 404 unknown run or name),
  `DELETE /api/runs/<run_id>/snapshots/<name>/masks/<mask_id>` (scoped delete by (name, viewport);
  404 unknown run/name or mask id not in that scope).
- `app/render.py` — render engine: `process_pending(run_id=None)` re-renders each `pending`
  snapshot (run-scoped when `run_id` is given; commits per snapshot) in headless Chromium
  (network aborted; injects the built `packages/client/dist/rehydrate.js`), screenshots a
  candidate PNG, and Pillow-diffs it against the approved baseline (`compare()`, always writes a
  red-on-grayscale diff PNG; accepts an optional `masks` list of `(x, y, width, height)` rectangles
  that are excluded from both the diff-ratio count and the red diff-PNG rendering).
  `applicable_masks(db, name, width, height)` looks up the `masks` rows that apply to a given
  snapshot (its own name+viewport, plus any global rows with `name IS NULL`). Path helpers:
  `baseline_path()`, `baseline_history_dir()`, `baseline_history_path()`, `image_path()`, and the
  scope-aware `scoped_baseline_write_path()` / `scoped_baseline_read_path()` /
  `scoped_baseline_history_dir()` / `scoped_baseline_history_path()` (fall back to the unscoped
  path helpers when `scope_kind` is `None`; branch reads fall back to the master baseline when no
  branch-specific file exists yet). `process_pending()` is scope-aware: it joins `runs` to read
  each snapshot's `scope_kind`/`scope_id` and resolves the baseline via
  `scoped_baseline_read_path()`.
- `app/db.py` — SQLite plumbing (stdlib `sqlite3`): schema, per-request connection via `flask.g`.
  `runs` has nullable `scope_kind`/`scope_id` columns (CHECK: both null or both set; `scope_kind`
  must be `branch` or `release` when set) and a `releases` table for release metadata.
- `tests/` — pytest suite (uses the Flask test client; also validates
  `docs/examples/example-snapshot.json` against the schema).

## Storage

Data dir: `create_app(data_dir=...)` arg, else `PPS_DATA_DIR` env var, else `backend/data/`
(gitignored). Holds:

- `pps.sqlite3` — run/snapshot/mask metadata.
- `blobs/<run_id>/<snapshot_id>.json` — uploaded snapshot documents.
- `images/<run_id>/<snapshot_id>/{candidate,diff}.png` — rendered candidate and diff PNGs.
- `baselines/<sha256(name\nWxH)>.png` — approved baselines, keyed globally by (name, viewport).
- `baselines/history/<sha256...>/<timestamp>.png` — baseline PNGs displaced by a later approve,
  kept for audit; served via the `.../history` and `.../history/<timestamp>` endpoints.
- `baselines/branches/<scope_id>/<sha256...>.png` and `baselines/releases/<scope_id>/<sha256...>.png`
  — scoped baselines (branch/release), same (name, viewport) keying as the master baselines. Branch
  reads fall back to the master path when no branch-specific file exists yet. Not yet wired into
  any HTTP endpoint — the path helpers exist in `app/render.py` for a future unit to use.

## Commands

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/pytest
.venv/bin/flask --app app run              # dev server
.venv/bin/flask --app app process-pending  # render + compare pending snapshots
```

`process-pending` needs the built client artifact (`npm ci && npm run build -w packages/client` at
the repo root) and an installed browser (`.venv/bin/playwright install chromium`).
