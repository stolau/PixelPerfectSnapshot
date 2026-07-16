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

## Development

```sh
npm install          # TS workspaces (packages/client, viewer)
npm run lint && npm test

cd backend
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/pytest
```
