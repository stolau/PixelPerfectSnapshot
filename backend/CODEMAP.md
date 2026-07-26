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
  are exempt. Routes: `POST /api/runs` (optional body `{"scope": {"kind": "branch"|"release", "id":
  "<string>"}}`; omitted `scope` = unscoped, unchanged; `kind` must be exactly `branch` or
  `release` else 400; `id` validated via `_validate_scope_id()` else 400; `kind: "release"` must
  name an existing row in `releases` else 404 "release not found"; `scope_kind`/`scope_id` are
  stored on the run but never appear in the response body),
  `GET /api/runs` (each row also carries `status` — aggregate verdict via `_run_verdict()`: `fail`
  if any snapshot failed, else `pass` if the run has ≥1 snapshot and all passed, else `pending`
  (covers pending/approved-baseline-missing/zero-snapshot); `newCount` — this run's own snapshots
  with status `approved-baseline-missing`; `removedCount` — master `approved_baselines` keys not
  covered by this run's own snapshots, always MASTER-only regardless of the run's own scope, and
  not updated by branch-merge promotions — see `docs/API.md`),
  `GET /api/runs/<run_id>`, `POST /api/runs/<run_id>/snapshots` (schema-validated; optional
  `category` field — if given, rejected with 400 when it conflicts with the viewport already
  established for that category by another snapshot, checked+inserted inside an explicit `BEGIN
  IMMEDIATE` transaction so concurrent uploads into a brand-new category can't race past the
  check),
  `GET /api/runs/<run_id>/snapshots/<name>` (includes `category`, nullable),
  `PATCH /api/runs/<run_id>/snapshots/<name>` (body `{"category": "<string>"|null}`; same
  viewport-consistency check as upload, excluding the snapshot's own row so re-saving the same
  category isn't self-blocked; 404 unknown run/snapshot),
  `GET /api/runs/<run_id>/snapshots/<name>/images/<kind>` (serves the PNGs; baseline resolution is
  scope-aware via `scoped_baseline_read_path()`; 404 until rendered),
  `GET /api/runs/<run_id>/snapshots/<name>/history` (lists history entries newest-first),
  `GET /api/runs/<run_id>/snapshots/<name>/history/<timestamp>` (serves a history PNG; 404 unknown
  timestamp; NOTE: these two history endpoints are still unscoped — they always resolve the
  master (name, viewport) history regardless of the run's scope; known limitation, out of scope
  for this unit),
  `POST /api/runs/<run_id>/snapshots/<name>/approve` (promotes the candidate PNG to the scope-aware
  baseline via `scoped_baseline_write_path()`, preserving the outgoing baseline under the matching
  `scoped_baseline_history_path()` when one already exists at that write path, status → `pass`; for
  unscoped (master) runs also upserts `(name, viewport_width, viewport_height)` into
  `approved_baselines` — NOT done for branch/release-scoped approves, and NOT done by
  `POST /api/branches/<id>/merge` either (it only has content hashes, not name/viewport); 409
  if no candidate yet),
  `POST /api/branches/<branch_id>/merge` (validates `branch_id` via `_validate_scope_id()`, 400 on
  malformed; copies every `*.png` directly under `baselines/branches/<branch_id>/` onto the
  matching master baseline path, preserving the outgoing master file under
  `baselines/history/<hash>/` via `baseline_history_path_by_hash()` when it exists; response
  `{"merged": [<hash>, ...], "count": n}`, 200 even when the branch has nothing to merge),
  `POST /api/releases` (body `{"id": "<string>"}`, validated via `_validate_scope_id()`, 400 on
  failure; 409 if a release with that id already exists, checked before any filesystem work; seeds
  the new release's baseline directory by copying every `*.png` from the previous release's
  directory, or from the master `baselines/` dir if this is the first release ever; response
  `{"id", "createdAt", "seededFrom", "fileCount"}`, 201),
  `POST /api/runs/<run_id>/process` (synchronously renders the run's pending snapshots, returns
  the `GET /api/runs/<run_id>` body; 500 if the rehydrate bundle is missing),
  `GET /api/masks` / `POST /api/masks` / `DELETE /api/masks/<mask_id>` (global masks, `name IS
  NULL AND category IS NULL` — the `category IS NULL` half is load-bearing now that category masks
  also have `name IS NULL`; delete 404s if the id doesn't exist among global masks),
  `GET /api/runs/<run_id>/snapshots/<name>/masks` (the resolved, combined view via
  `applicable_masks()` — global masks plus this snapshot's per-image masks plus, when the snapshot
  has a `category`, that category's masks; 404 unknown run or name),
  `POST /api/runs/<run_id>/snapshots/<name>/masks` (creates a per-image mask keyed by the
  snapshot's (name, viewport), like a baseline — applies to every future run of that test case;
  400 if the mask exceeds the resolved snapshot's viewport bounds; 404 unknown run or name),
  `DELETE /api/runs/<run_id>/snapshots/<name>/masks/<mask_id>` (scoped delete by (name, viewport);
  404 unknown run/name or mask id not in that scope),
  `GET /api/categories/<category>/masks` / `POST /api/categories/<category>/masks` /
  `DELETE /api/categories/<category>/masks/<mask_id>` (mask categories — a third scope, alongside
  global and per-image: a mask saved against a category applies to every snapshot tagged with that
  category, regardless of `name`, letting a recurring same-position element be masked once instead
  of per-snapshot. `POST` 404s if the category isn't used by any snapshot yet — it looks up the
  category's established viewport via `category_viewport()` to bounds-check the mask against, the
  same way per-image masks are bounds-checked against their snapshot's viewport; `DELETE` 404s if
  the id isn't a mask in that category. Purely a masking-grouping concept — `category` has no
  effect on baseline identity/lookup, which stays keyed by (name, viewport) exactly as before).
- `app/render.py` — render engine: `process_pending(run_id=None)` re-renders each `pending`
  snapshot (run-scoped when `run_id` is given; commits per snapshot) in headless Chromium
  (network aborted; injects the built `packages/client/dist/rehydrate.js`), screenshots a
  candidate PNG, and Pillow-diffs it against the approved baseline (`compare()`, always writes a
  red-on-grayscale diff PNG; accepts an optional `masks` list of `(x, y, width, height)` rectangles
  that are excluded from both the diff-ratio count and the red diff-PNG rendering).
  `applicable_masks(db, name, width, height, category=None)` looks up the `masks` rows that apply
  to a given snapshot (its own name+viewport, plus any global rows, plus any rows scoped to its
  `category` when given). `category_viewport(db, category, exclude_snapshot_id=None)` looks up the
  viewport already established for a category from the `snapshots` table (used to enforce
  one-viewport-per-category and to bounds-check category mask creation). Path helpers:
  `baseline_path()`, `baseline_history_dir()`, `baseline_history_path()` (delegates to
  `baseline_history_path_by_hash(data_dir, key, timestamp)`, the hash-keyed primitive also used
  directly by the branch-merge endpoint), `image_path()`, and the scope-aware
  `scoped_baseline_write_path()` / `scoped_baseline_read_path()` / `scoped_baseline_history_dir()`
  / `scoped_baseline_history_path()` (fall back to the unscoped path helpers when `scope_kind` is
  `None`; branch reads fall back to the master baseline when no branch-specific file exists yet).
  `process_pending()` is scope-aware: it joins `runs` to read each snapshot's
  `scope_kind`/`scope_id` and resolves the baseline via `scoped_baseline_read_path()`.
- `app/db.py` — SQLite plumbing (stdlib `sqlite3`): schema, per-request connection via `flask.g`.
  `runs` has nullable `scope_kind`/`scope_id` columns (CHECK: both null or both set; `scope_kind`
  must be `branch` or `release` when set) and a `releases` table for release metadata.
  `snapshots` has a nullable `category` column (no FK — a category exists only as a string shared
  across snapshot rows). `masks` has a nullable `category` column alongside `name`/
  `viewport_width`/`viewport_height`; a 3-way exclusive CHECK enforces exactly one scope per row:
  all four null (global), `name`+viewport set and `category` null (per-image), or `category` set
  and the other three null (category-scope).
  `approved_baselines` (`name`, `viewport_width`, `viewport_height` primary key) is a pure
  existence index of (name, viewport) keys with a current MASTER-scoped approved baseline —
  upserted by `approve_snapshot`, read by `GET /api/runs`'s `removedCount` computation; has no
  reverse mapping for branch/release-scoped or merge-promoted baselines.
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
  reads fall back to the master path when no branch-specific file exists yet. Written by
  `approve_snapshot` for runs created with a `scope`, read by `get_image`/`get_snapshot`, promoted
  to master by `POST /api/branches/<branch_id>/merge`, and seeded from master/the prior release by
  `POST /api/releases`.

## Commands

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/pytest
.venv/bin/flask --app app run              # dev server
.venv/bin/flask --app app process-pending  # render + compare pending snapshots
```

`process-pending` needs the built client artifact (`npm ci && npm run build -w packages/client` at
the repo root) and an installed browser (`.venv/bin/playwright install chromium`).
