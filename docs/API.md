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

## Endpoints

### `POST /api/runs`
Create a run. Body: `{}` (or empty).
`201` → `{"id": "<run-id>", "createdAt": "<ISO 8601 UTC>"}`

### `POST /api/runs/<run_id>/snapshots`
Upload one snapshot. Body: a snapshot document, validated against
[`snapshot.schema.json`](snapshot.schema.json).
`201` → `{"name": "<name>", "status": "pending"}`
`400` → `{"error": "<schema violation message>"}` · `404` unknown run · `409` duplicate name in run.

### `GET /api/runs`
`200` → `{"runs": [{"id", "createdAt", "snapshotCount"}]}` — newest first.

### `GET /api/runs/<run_id>`
`200` → `{"id", "createdAt", "snapshots": [{"name", "viewport", "status"}]}` (document order:
upload order). `404` unknown run.

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
The three URLs point at the image endpoints below once the corresponding PNG exists; `null` until
then. `404` unknown run or name.

### `GET /api/runs/<run_id>/snapshots/<name>/images/<kind>`
`kind` ∈ `baseline` | `candidate` | `diff`. `200` → `image/png`. `404` while the image does not
exist (e.g. before the render engine has processed the snapshot).

### `POST /api/runs/<run_id>/snapshots/<name>/approve`
Promote this snapshot's candidate PNG to be the approved baseline for its (name, viewport) key,
and set its status to `pass`.
`200` → `{"name", "status": "pass"}`
`409` → no candidate PNG exists yet (not rendered). `404` unknown run or name.
*Until the render engine lands, the backend may answer `501 Not Implemented`.*

## Errors

All error responses: `{"error": "<human-readable message>"}` with the status codes above.
