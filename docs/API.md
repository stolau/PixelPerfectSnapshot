# Backend HTTP API v0

**Status: FROZEN.** Changes require their own serialized change — never edited concurrently with
work that consumes this contract. All request/response bodies are JSON unless noted.

## Concepts

- **Run** — one CI/e2e session's batch of snapshot uploads.
- **Snapshot** — one uploaded document per [SNAPSHOT_FORMAT.md](SNAPSHOT_FORMAT.md). Unique by
  `name` within a run (duplicate upload → `409`).
- **Result** — per snapshot, one of:
  - `pending` — uploaded, not yet rendered/compared (all results are `pending` until the render
    engine exists / runs).
  - `pass` — rendered; pixel diff against approved baseline within tolerance.
  - `fail` — rendered; diff exceeded tolerance.
  - `approved-baseline-missing` — rendered, but no approved baseline exists for this
    (name, viewport); needs human approval to establish one.
- **Baseline** — the approved rendered **PNG screenshot**, keyed by **(name, viewport)** globally
  (not per run). Approving promotes a snapshot's candidate PNG to be the baseline for its key.
- **History** — prior baseline PNGs for a (name, viewport) key, kept when a new baseline replaces
  one. Entries are identified by opaque `timestamp` strings and listed newest-first.

## Endpoints

### `POST /api/runs`
Create a run. Body: `{}` (or empty).
`201` → `{"id": "<run-id>", "createdAt": "<ISO 8601 UTC>"}`

### `POST /api/runs/<run_id>/snapshots`
Upload one snapshot. Body: a snapshot document, validated against
[`snapshot.schema.json`](snapshot.schema.json).
`201` → `{"name": "<name>", "status": "pending"}`
`400` → `{"error": "<schema violation message>"}` · `404` unknown run · `409` duplicate name in run ·
`413` request body exceeds the upload size cap → `{"error": "<message>"}`.

### `GET /api/runs`
`200` — newest first (creation order descending; timestamp ties broken by creation order):
```json
{
  "runs": [
    {"id": "run-2", "createdAt": "2026-07-15T09:30:00Z", "snapshotCount": 3},
    {"id": "run-1", "createdAt": "2026-07-14T18:00:00Z", "snapshotCount": 1}
  ]
}
```

### `GET /api/runs/<run_id>`
`200` (snapshots in upload order) · `404` unknown run:
```json
{
  "id": "run-2",
  "createdAt": "2026-07-15T09:30:00Z",
  "snapshots": [
    {"name": "checkout-page", "viewport": {"width": 1280, "height": 720}, "status": "pending"}
  ]
}
```

### `GET /api/runs/<run_id>/snapshots/<name>`
`200` →
```json
{
  "name": "checkout-page",
  "viewport": {"width": 1280, "height": 720},
  "status": "pending",
  "baselineUrl": null,
  "candidateUrl": null,
  "diffUrl": null
}
```
The three URLs are **server-relative paths** (e.g.
`/api/runs/run-2/snapshots/checkout-page/images/baseline`) pointing at the image endpoints below
once the corresponding PNG exists; `null` until then. `404` unknown run or name.

### `GET /api/runs/<run_id>/snapshots/<name>/images/<kind>`
`kind` ∈ `baseline` | `candidate` | `diff`. `200` → `image/png`. `404` while the image does not
exist (e.g. before the render engine has processed the snapshot).

### `GET /api/runs/<run_id>/snapshots/<name>/history`
`200` — newest first:
```json
{
  "history": [
    {"timestamp": "20260715T093000000000Z"},
    {"timestamp": "20260714T180000000000Z"}
  ]
}
```
`404` unknown run or name.

### `GET /api/runs/<run_id>/snapshots/<name>/history/<timestamp>`
`200` → `image/png`. `404` unknown run, name, or timestamp.

### `POST /api/runs/<run_id>/snapshots/<name>/approve`
Promote this snapshot's candidate PNG to be the approved baseline for its (name, viewport) key,
and set its status to `pass`.
`200` → `{"name", "status": "pass"}`
`409` → no candidate PNG exists yet (not rendered). `404` unknown run or name.

### `POST /api/runs/<run_id>/process`
Synchronously render and compare every `pending` snapshot **in this run** (blocks for roughly one
second per snapshot). No request body.
`200` → exactly the `GET /api/runs/<run_id>` body, reflecting post-processing statuses.
`404` unknown run.
`500` → `{"error": "<message>"}` when the render engine is unavailable (missing rehydrate bundle).
Calling with nothing pending is a no-op returning the current run body. Concurrent calls for the
same run may duplicate render work, but rendering is deterministic, so they converge to the same
statuses — safe, just wasteful.

## Errors

All error responses: `{"error": "<human-readable message>"}` with the status codes above.
