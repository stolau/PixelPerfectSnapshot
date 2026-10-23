# Bundle format v0.1

**Status: FROZEN.** Changes require a version bump (v0.2) landed as its own change — never edited
concurrently with work that consumes this contract. Machine-readable manifest schema:
[`bundle.schema.json`](bundle.schema.json).

A run bundle is a `.zip` holding every snapshot of one run, passing and failing alike, with a
`manifest.json` that describes them. It is generic: PixelPerfectSnapshot only produces it, and
fetching, combining and any check against a spec are the consumer's job. Two producers write the
same format:

- **server** — `GET /api/runs/<run_id>/export.zip` (see [API.md](API.md)), built on demand from the
  run's current data; no zip is stored.
- **client** — the npm library, from snapshots it captured. It writes snapshot documents only.

## Layout

```
manifest.json
snapshots/0001/snapshot.json          the snapshot document
snapshots/0001/candidate.png          optional
snapshots/0001/baseline.png           optional
snapshots/0001/diff.png               optional
snapshots/0001/structure-diff.json    optional
snapshots/0002/...
```

The directory and file names above are how producers lay the zip out, **not contract**: a consumer
resolves every file only through the manifest's `files` paths, and must not derive a path from a
snapshot's name, its ordinal or the ordinal's width. Directories are ordinals rather than names
because a snapshot name may hold any character but `/`.

## `manifest.json`

```json
{
  "bundleVersion": 0,
  "producer": "server",
  "run": {"id": "run-2", "createdAt": "2026-07-15T09:30:00Z", "scope": {"kind": "branch", "id": "feature-x"}},
  "snapshots": [
    {"name": "checkout-page", "viewport": {"width": 1280, "height": 720},
     "category": null, "spec": "pps-checkout", "when": "cart has two items",
     "status": "fail",
     "files": {"snapshot": "snapshots/0001/snapshot.json", "candidate": "snapshots/0001/candidate.png",
               "baseline": "snapshots/0001/baseline.png", "diff": "snapshots/0001/diff.png",
               "structureDiff": "snapshots/0001/structure-diff.json"}}
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `bundleVersion` | `0` (const) | Format version of this bundle. |
| `producer` | `"server"` \| `"client"` | Which producer wrote the bundle. |
| `run` | object \| `null` | Server: `{id, createdAt, scope}` of the run, `scope` being `{"kind": "branch"\|"release", "id"}` or `null` for an unscoped run, as in `GET /api/runs`. Client: always `null`. |
| `snapshots` | array | One entry per snapshot, in upload (server) or input (client) order; an empty run has `[]`. |

Each `snapshots` entry has every key below; a value the producer does not have is `null`, never
omitted.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | The snapshot's name. |
| `viewport` | `{width, height}` | The snapshot's viewport. |
| `category` | string \| `null` | The snapshot's mask category. |
| `spec` | string \| `null` | The snapshot's spec id ([SNAPSHOT_FORMAT.md](SNAPSHOT_FORMAT.md)). |
| `when` | string \| `null` | The state the snapshot shows; non-null only when `spec` is. |
| `status` | string \| `null` | Server: exactly one of `pass`, `fail`, `approved-baseline-missing` (a bundle is never built while a snapshot is `pending`). Client: always `null`. |
| `files` | object | Zip paths of this snapshot's files, below. |

`name`, `viewport`, `category`, `spec` and `when` are the producer's current values, and **the
manifest wins over the copy inside `snapshot.json`**: a snapshot's `category` can change after
upload (by `PATCH` or a category rename, see [API.md](API.md)), and its `snapshot.json` keeps the
value it was uploaded with.

### `files`

| Key | File | Present when |
|---|---|---|
| `snapshot` | the snapshot document | always (required) |
| `candidate` | candidate PNG | the producer has a rendered candidate |
| `baseline` | baseline PNG | the producer has a baseline for the snapshot |
| `diff` | diff PNG | the producer has a diff image |
| `structureDiff` | JSON array, the same as the API's `structureDiff` | server: `status` is `fail` and a structure diff exists, following `structureDiff`'s rule in [API.md](API.md) |

A producer writes a `files` key only when that file is in the zip; every key but `snapshot` is
optional and absent when the producer has none. **A consumer ignores `files` keys it does not
know** — that is the room left for later additions (such as a standalone `html` page, or images
from the client) without a format bump. Any other new manifest key is a bump.

Paths are zip-relative and `/`-separated: never absolute, never containing an empty, `.` or `..`
segment, and made of `A-Z a-z 0-9 _ . -` per segment. A consumer must still refuse any path that
breaks this rule rather than extract it (zip-slip).

### File contents

- **`snapshot.json`** is the snapshot document as stored, JSON-equal to what was uploaded (server)
  or captured (client), not necessarily byte-equal: the server keeps a re-serialization of the
  upload.
- **`baseline.png`** (server) is the scoped baseline the run reads, as of the export. Because the
  bundle is built on demand, a later approval changes an older run's export, and for an approved
  snapshot the baseline equals its candidate while its `diff.png` no longer corresponds to it.
- **`structure-diff.json`** holds the array the API returns as `structureDiff`.

## Changelog

**v0.1** — initial bundle format (`bundleVersion` 0 on the wire).
