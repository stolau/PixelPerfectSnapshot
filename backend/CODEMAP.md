# backend — CODEMAP

Flask backend: receives snapshot uploads, stores them, (later) re-renders and pixel-diffs against
approved baselines. HTTP contract: `docs/API.md`. Upload payload contract:
`docs/snapshot.schema.json`.

## Layout

- `app/__init__.py` — `create_app(data_dir=None)` Flask application factory. Endpoints:
  `GET /api/health`. Registers the API blueprint and JSON 404/405 error handlers.
- `app/api.py` — `/api` blueprint implementing `docs/API.md`: `POST /api/runs`, `GET /api/runs`,
  `GET /api/runs/<run_id>`, `POST /api/runs/<run_id>/snapshots` (schema-validated),
  `GET /api/runs/<run_id>/snapshots/<name>`,
  `GET /api/runs/<run_id>/snapshots/<name>/images/<kind>` (404 until the render engine exists),
  `POST /api/runs/<run_id>/snapshots/<name>/approve` (501 until the render engine exists).
- `app/db.py` — SQLite plumbing (stdlib `sqlite3`): schema, per-request connection via `flask.g`.
- `tests/` — pytest suite (uses the Flask test client; also validates
  `docs/examples/example-snapshot.json` against the schema).

## Storage

Data dir: `create_app(data_dir=...)` arg, else `PPS_DATA_DIR` env var, else `backend/data/`
(gitignored). Holds `pps.sqlite3` (run/snapshot metadata) and `blobs/<run_id>/<snapshot_id>.json`
(uploaded snapshot documents).

## Commands

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/pytest
.venv/bin/flask --app app run          # dev server
```
