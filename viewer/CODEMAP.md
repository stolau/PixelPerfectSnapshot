# viewer — CODEMAP

React + Vite web UI: lists runs, shows baseline/candidate/diff side by side, approves baselines.
Consumes the backend HTTP API (`docs/API.md`).

## Layout

- `index.html` — Vite entry document.
- `src/main.tsx` — React root bootstrap.
- `src/App.tsx` — application root: three views with state-based navigation — run list →
  run detail → snapshot detail (baseline/candidate/diff side by side, approve button; refetches
  the snapshot after a successful approve so the status stays fresh). An always-visible
  `AuthTokenInput` (near the `<h1>`) shows the currently stored auth token (if any) in a password
  field with "Save token" / "Clear token" buttons wired to `setAuthToken()`. Snapshot detail also
  shows a "History" section (thumbnails of prior baselines, newest-first), fetched on mount and
  refetched after a successful approve. Run detail shows a "Process pending" button when any
  snapshot is pending, which POSTs `/process` then refetches the run (same pattern as approve's
  post-action refetch) before repainting statuses. Snapshot detail's candidate image (when
  available) is wrapped in a "Masks" overlay: it fetches this snapshot's combined masks and the
  global mask list on mount, renders each applicable mask as a semi-transparent rect scaled to the
  displayed image size, and lets you drag a new rectangle on the image to open a "Save as global
  mask" / "Save as mask for this snapshot" picker (a `<h2>Masks</h2>` section below History holds
  that picker and any mask error). Delete is available only for masks whose id can be proven:
  global masks (cross-referenced against `GET /api/masks`) and masks created in the current
  browser session (tracked client-side from their create response, deduplicated by identity
  against refetched global masks to avoid double-binding when duplicate-rect masks exist).
  Pre-existing per-image masks — fetched only via the id-less combined endpoint and not created
  this session — have no delete button, because no endpoint lists per-image masks together with
  their ids. This is a known limitation of the current (frozen) API surface, not a bug. All four
  `<img>` sites (baseline, candidate, diff, history thumbnails) render through
  `AuthenticatedImage` (see below) rather than plain `<img>`.
- `src/authToken.ts` — sessionStorage-backed auth token: `getAuthToken()` / `setAuthToken(token)`
  (removes the key on `null`/`""`), and `authHeaders()`, which returns `{ Authorization: "Bearer
  <token>" }` when a token is stored or `{}` otherwise. This is the single place
  header-attachment logic lives — both `api.ts`'s `request<T>()` and `AuthenticatedImage` call it;
  neither duplicates the header-building logic inline.
- `src/AuthenticatedImage.tsx` — drop-in replacement for `<img src={url}>` that authenticates the
  request: since `<img>` can't attach headers itself, it `fetch()`es `src` with `authHeaders()`,
  turns the response into a `URL.createObjectURL` blob URL, and renders that as the real `<img>`'s
  `src`. All props except `src` (`onLoad`, `alt`, etc.) pass straight through to the underlying
  `<img>`, which is always mounted (even before the blob resolves) so consumers relying on it —
  e.g. the candidate image's `onLoad` → `naturalWidth`/`naturalHeight` mask-scaling logic — keep
  working unchanged. Each effect run guards its own fetch with a local `cancelled` flag and
  revokes only the object URL *that same run* created, in its own cleanup closure (not a ref/state
  a later run could stomp) — correct under rapid `src` changes and React 18 StrictMode's
  dev-mode double-invoke. A non-ok response replaces the image with a visible error message
  instead of failing silently; a `401` specifically points at the auth token input above.
- `src/api.ts` — typed client for the backend HTTP API (`docs/API.md`). Prefixes requests with
  `VITE_API_BASE` (empty by default; dev server proxies `/api` to `http://localhost:5000`).
  Also exports `imageUrl(path)`, which applies the same `VITE_API_BASE` prefix to image srcs, and
  `getSnapshotHistory(id, name)` / `historyImageUrl(id, name, timestamp)` for the history list and
  its per-entry image URLs. Mask CRUD: `Mask` (has `id`) and `MaskRect` (no `id`, the shape
  returned by the combined per-snapshot masks endpoint) types, plus `listGlobalMasks()` /
  `createGlobalMask(rect)` / `deleteGlobalMask(id)` for global masks and `listSnapshotMasks(id,
  name)` / `createSnapshotMask(id, name, rect)` / `deleteSnapshotMask(id, name, maskId)` for
  per-image masks. `request<T>()` treats a `204` response as success with no body (does not call
  `.json()`), which the delete-mask endpoints rely on. `request<T>()` merges `authHeaders()` into
  whatever headers the call already sends (e.g. `Content-Type` on mask creates), so it's a no-op
  when no token is stored.
- `src/fixtures/` — contract-verbatim API response fixtures used by tests.
- `src/test-setup.ts` — vitest `setupFiles` entry: stubs `URL.createObjectURL`/`revokeObjectURL`
  (unimplemented in jsdom), which `AuthenticatedImage` needs in every test.
- `src/*.test.tsx` — vitest (+ @testing-library/react, jsdom) tests.

## Commands

`npm run dev` (dev server) · `npm run build` · `npm run lint` (typecheck) · `npm test`
