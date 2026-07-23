# viewer — CODEMAP

React + Vite web UI: lists runs, shows baseline/candidate/diff side by side, approves baselines.
Consumes the backend HTTP API (`docs/API.md`).

## Layout

- `index.html` — Vite entry document.
- `src/main.tsx` — React root bootstrap.
- `src/App.tsx` — application root: three views with state-based navigation — run list →
  run detail → snapshot detail (baseline/candidate/diff side by side, approve button; refetches
  the snapshot after a successful approve so the status stays fresh). Snapshot detail also shows a
  "History" section (thumbnails of prior baselines, newest-first), fetched on mount and refetched
  after a successful approve. Run detail shows a "Process pending" button when any snapshot is
  pending, which POSTs `/process` then refetches the run (same pattern as approve's post-action
  refetch) before repainting statuses. Snapshot detail's candidate image (when available) is
  wrapped in a "Masks" overlay: it fetches this snapshot's combined masks and the global mask list
  on mount, renders each applicable mask as a semi-transparent rect scaled to the displayed image
  size, and lets you drag a new rectangle on the image to open a "Save as global mask" / "Save as
  mask for this snapshot" picker (a `<h2>Masks</h2>` section below History holds that picker and
  any mask error). Delete is available only for masks whose id can be proven: global masks
  (cross-referenced against `GET /api/masks`) and masks created in the current browser session
  (tracked client-side from their create response, deduplicated by identity against refetched
  global masks to avoid double-binding when duplicate-rect masks exist). Pre-existing per-image
  masks — fetched only via the id-less combined endpoint and not created this session — have no
  delete button, because no endpoint lists per-image masks together with their ids. This is a known
  limitation of the current (frozen) API surface, not a bug.
- `src/api.ts` — typed client for the backend HTTP API (`docs/API.md`). Prefixes requests with
  `VITE_API_BASE` (empty by default; dev server proxies `/api` to `http://localhost:5000`).
  Also exports `imageUrl(path)`, which applies the same `VITE_API_BASE` prefix to image srcs, and
  `getSnapshotHistory(id, name)` / `historyImageUrl(id, name, timestamp)` for the history list and
  its per-entry image URLs. Mask CRUD: `Mask` (has `id`) and `MaskRect` (no `id`, the shape
  returned by the combined per-snapshot masks endpoint) types, plus `listGlobalMasks()` /
  `createGlobalMask(rect)` / `deleteGlobalMask(id)` for global masks and `listSnapshotMasks(id,
  name)` / `createSnapshotMask(id, name, rect)` / `deleteSnapshotMask(id, name, maskId)` for
  per-image masks. `request<T>()` treats a `204` response as success with no body (does not call
  `.json()`), which the delete-mask endpoints rely on.
- `src/fixtures/` — contract-verbatim API response fixtures used by tests.
- `src/*.test.tsx` — vitest (+ @testing-library/react, jsdom) tests.

## Commands

`npm run dev` (dev server) · `npm run build` · `npm run lint` (typecheck) · `npm test`
