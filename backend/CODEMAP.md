# backend — CODEMAP

Flask backend: receives snapshot uploads, stores them, (later) re-renders and pixel-diffs against
approved baselines. HTTP contract: `docs/API.md`. Upload payload contract:
`docs/snapshot.schema.json`.

## Layout

- `app/__init__.py` — `create_app()` Flask application factory. Endpoints: `GET /api/health`.
- `tests/` — pytest suite (uses the Flask test client; also validates
  `docs/examples/example-snapshot.json` against the schema).

## Commands

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/pytest
.venv/bin/flask --app app run          # dev server
```
