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
- **Masks** — rectangular regions excluded from the pixel diff. Global masks (created via
  /api/masks) apply to every snapshot; per-image masks (created via a snapshot's /masks
  sub-resource) are keyed by (name, viewport) like baselines — not per run — so they apply to
  every future run of that same test case; category masks (created via /api/categories/<category>
  /masks) apply to every snapshot tagged with that `category`, regardless of `name` — useful for a
  recurring same-position element (e.g. a version stamp) that appears across many differently-named
  snapshots, without repeating a per-image mask on each one. All three kinds combine additively for
  a given snapshot's compare.
- **Category** — an optional string tag on a snapshot (`category`, settable at upload or via
  `PATCH`). Purely a masking-grouping concept — it has no effect on baseline identity, which stays
  keyed by (name, viewport) exactly as without categories. All snapshots sharing a category must
  have the same viewport (enforced: tagging a snapshot with a category that's already established a
  different viewport is rejected with `400`).
- **Baseline scoping (branch / master / release)** — a run may optionally set `scope` to compare
  against and approve into an isolated baseline set instead of the single global one (master):
  - **master** (default, no `scope`) — today's behavior: one shared baseline per (name, viewport).
  - **branch** (`scope: {"kind": "branch", "id": "<string>"}`) — reads fall back to master
    wherever the branch hasn't approved its own baseline yet; approvals always write to the
    branch's own baseline, never to master. `POST /api/branches/<id>/merge` promotes a branch's
    approved baselines to master. A branch has no creation step — it springs into existence on
    first approve, identified purely by its `id`.
  - **release** (`scope: {"kind": "release", "id": "<string>"}`) — created via `POST /api/releases`
    ("cutting" a release), which seeds it from master's current baselines (if no prior release
    exists) or from the immediately prior release's own baselines (if one does) — never from
    master once a prior release exists. Reads and approvals always target the release's own
    baselines, with no fallback. This is what makes a release compare against "the last release
    build," not master.

## Authentication

Optional shared-secret authentication, off by default. Set `PPS_API_TOKEN` on the backend to
require every request under `/api/*` (except `OPTIONS` preflight) to include:

```
Authorization: Bearer <token>
```

Missing header, malformed header, or a mismatched token → `401` → `{"error": "<message>"}`.
`GET /api/health` is exempt. When `PPS_API_TOKEN` is unset, no authentication is required —
matches this project's existing opt-in-via-env-var convention (e.g. `PPS_ALLOWED_ORIGIN` for
CORS).

## Endpoints

### `POST /api/runs`
Create a run. Body: `{}` (or empty), or `{"scope": {"kind": "branch"|"release", "id": "<string>"}}`
to scope this run — see **Baseline scoping** above. `id` must be non-empty and match
`^[A-Za-z0-9_.-]+$` (not `.` or `..`).
`201` → `{"id": "<run-id>", "createdAt": "<ISO 8601 UTC>"}`
`400` → invalid `scope.kind` or `scope.id` → `{"error": "<message>"}`.
`404` → `scope.kind` is `"release"` and no release with that `id` exists.

### `POST /api/runs/<run_id>/snapshots`
Upload one snapshot. Body: a snapshot document, validated against
[`snapshot.schema.json`](snapshot.schema.json) — includes an optional `category` field (see
**Category** above).
`201` → `{"name": "<name>", "status": "pending"}`
`400` → `{"error": "<schema violation message>"}`, or the `category` conflicts with the viewport
already established for it by another snapshot · `404` unknown run · `409` duplicate name in run ·
`413` request body exceeds the upload size cap → `{"error": "<message>"}`.

### `GET /api/runs`
`200` — newest first (creation order descending; timestamp ties broken by creation order):
```json
{
  "runs": [
    {"id": "run-2", "createdAt": "2026-07-15T09:30:00Z", "snapshotCount": 3, "status": "fail", "newCount": 1, "removedCount": 0},
    {"id": "run-1", "createdAt": "2026-07-14T18:00:00Z", "snapshotCount": 1, "status": "pending", "newCount": 0, "removedCount": 2}
  ]
}
```
- `status` — this run's aggregate verdict: `"fail"` if any snapshot has status `fail`; else
  `"pass"` if the run has at least one snapshot and all of them are `pass`; else `"pending"`
  (covers `pending`, `approved-baseline-missing`, and a run with zero snapshots).
- `newCount` — this run's own snapshots with status `approved-baseline-missing`.
- `removedCount` — currently-approved **master** `(name, viewport)` keys not covered by this
  run's own snapshots. Two caveats:
  - Baselines promoted to master via `POST /api/branches/<id>/merge` are not tracked (that
    endpoint only has content hashes, not `(name, viewport)` tuples), so `removedCount` can
    undercount for projects whose primary master-approval path is branch merges.
  - `removedCount` always compares against **master**, never the run's own scope — for a branch
    or release scoped run, a nonzero `removedCount` doesn't mean anything was removed from that
    run's own comparison target, only that master's approved set doesn't match what this run
    covered. `newCount`, by contrast, does reflect each run's own effective comparison target
    (driven by the snapshot's own render-time status). This asymmetry is deliberate.

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
  "category": null,
  "baselineUrl": null,
  "candidateUrl": null,
  "diffUrl": null
}
```
The three URLs are **server-relative paths** (e.g.
`/api/runs/run-2/snapshots/checkout-page/images/baseline`) pointing at the image endpoints below
once the corresponding PNG exists; `null` until then. `404` unknown run or name.

### `PATCH /api/runs/<run_id>/snapshots/<name>`
Set or clear this snapshot's `category`. Body: `{"category": "<string>"|null}`.
`200` → `{"name", "category"}`
`400` → missing `category` key, wrong type, empty string, or the category conflicts with the
viewport already established for it by another snapshot (this snapshot's own row is excluded from
that check, so re-saving the same category it already holds is never self-blocked). `404` unknown
run or name.

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
and set its status to `pass`. If the run is scoped (branch or release), the baseline is written
into that scope only — see **Baseline scoping** above — never to master.
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

In the Docker deployment, this endpoint is proxied through nginx (`viewer/nginx.conf`), which caps
the request at 300s (≈300 pending snapshots at ~1s each) — very large runs may still exceed this and
get a 504 from nginx even though the backend keeps processing. To process pending snapshots outside
the request/response cycle, run `flask --app app process-pending` on the backend — note this
processes pending snapshots across **all** runs, not just one.

## Masks

### `GET /api/masks`
List global masks (apply to every snapshot).
`200`:
```json
{
  "masks": [
    {"id": 1, "x": 0, "y": 0, "width": 100, "height": 40}
  ]
}
```

### `POST /api/masks`
Create a global mask. Body: `{"x", "y", "width", "height"}` (integers; `x`/`y` non-negative,
`width`/`height` positive).
`201` → `{"id", "x", "y", "width", "height"}`
`400` → missing/invalid field.

### `DELETE /api/masks/<mask_id>`
Delete a global mask.
`204` on success · `404` unknown mask id.

### `GET /api/runs/<run_id>/snapshots/<name>/masks`
List the masks that apply to this snapshot: its own per-image masks (keyed by this snapshot's
(name, viewport)), all global masks, and — when this snapshot has a `category` — that category's
masks, combined.
`200`:
```json
{
  "masks": [
    {"x": 0, "y": 0, "width": 100, "height": 40}
  ]
}
```
No `id` on entries — this is the resolved, combined view used by `compare()`, not a per-row
listing. `404` unknown run or name.

### `POST /api/runs/<run_id>/snapshots/<name>/masks`
Create a per-image mask for this snapshot's (name, viewport) key — like a baseline, it then applies
to every future run of that same test case, not just this one. Body: same shape as
`POST /api/masks`.
`201` → `{"id", "x", "y", "width", "height"}`
`400` → missing/invalid field, or the mask falls outside the snapshot's viewport
(`x + width > viewport.width` or `y + height > viewport.height`). `404` unknown run or name.

### `DELETE /api/runs/<run_id>/snapshots/<name>/masks/<mask_id>`
Delete a per-image mask scoped to this snapshot's (name, viewport) key.
`204` on success · `404` unknown run or name, or `mask_id` not found for this (name, viewport) key.

### `GET /api/categories`
List distinct category names currently in use by any snapshot, sorted.
`200`:
```json
{"categories": ["App Shell", "Checkout Flow"]}
```

### `GET /api/categories/<category>/masks`
List masks scoped to `category` (apply to every snapshot tagged with it, regardless of `name`).
`200`:
```json
{
  "masks": [
    {"id": 1, "x": 0, "y": 0, "width": 100, "height": 40}
  ]
}
```

### `POST /api/categories/<category>/masks`
Create a category mask. Body: same shape as `POST /api/masks`.
`201` → `{"id", "x", "y", "width", "height"}`
`400` → missing/invalid field, or the mask falls outside the viewport already established for this
category by the snapshots tagged with it. `404` → `category` isn't used by any snapshot yet (there
is no viewport to bounds-check the mask against).

### `DELETE /api/categories/<category>/masks/<mask_id>`
Delete a category mask.
`204` on success · `404` unknown mask id for this category.

## Branches & Releases

See **Baseline scoping** under Concepts. There is deliberately no endpoint to list or delete
branches in this version — a branch is just whatever `id` string a run's `scope` names, and an
unused or typo'd branch id simply never accumulates any files. This is a known, accepted
limitation for now, not an oversight.

### `POST /api/branches/<branch_id>/merge`
Promote every baseline the branch has approved to master (unconditional — no conflict detection
against concurrent master changes; the promoted-over master baseline is preserved in master's
history, same as a normal approve). A branch with nothing approved yet is not an error.
`200` → `{"merged": ["<content-hash>", ...], "count": <int>}`
`400` → invalid `branch_id`.

### `POST /api/releases`
Cut a new release. Body: `{"id": "<string>"}` (same `id` rules as a run's `scope.id`).
`201` → `{"id", "createdAt": "<ISO 8601 UTC>", "seededFrom": "master"|"<prior-release-id>", "fileCount": <int>}`
`400` → invalid `id`. `409` → a release with that `id` already exists.

## Errors

All error responses: `{"error": "<human-readable message>"}` with the status codes above.
