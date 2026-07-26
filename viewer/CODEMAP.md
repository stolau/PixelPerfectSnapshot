# viewer — CODEMAP

React + Vite web UI: lists runs, shows baseline/candidate/diff side by side, approves baselines.
Consumes the backend HTTP API (`docs/API.md`).

## Layout

- `index.html` — Vite entry document.
- `src/main.tsx` — React root bootstrap.
- `src/App.tsx` — application root: a persistent `NavBar` (logo placeholder + app name, click to
  return to the run list; "Branches & Releases" and "Settings" links, each highlighted when
  active) plus state-based views — run list → run detail → snapshot detail, a standalone
  `Settings` view holding `AuthTokenInput` (shows the currently stored auth token, if any, in a
  password field with "Save token" / "Clear token" buttons wired to `setAuthToken()`) and
  `ImageSizeInput` (Small/Medium/Large buttons wired to `imageDisplaySize.ts`'s `setImageSize()`),
  and a `ScopesView` (see below). Run list rows show a color-coded verdict pill (`statusStyles()`,
  shared with the snapshot-status pill — `fail`/`pass`/`pending`, computed server-side by
  `GET /api/runs`), a client-computed sequential `Run #N` (oldest run is #1 **across the full
  unfiltered run list, computed before any scope filtering** — see `ScopesView` below — purely a
  display number, never persisted), a human-readable `formatRunDate()` timestamp
  (`Intl.DateTimeFormat`, fixed to UTC since `createdAt` is always `Z`-suffixed), a scope tag
  (`"branch: <id>"` / `"release: <id>"`, only rendered when `run.scope !== null` — master runs get
  no tag, matching their unlabeled appearance before scope existed at all), and a muted "+N new,
  -N missing" summary from the API's `newCount`/`removedCount` (hidden when both are zero). Run
  detail shows a "Process pending" button when any snapshot is pending, which POSTs `/process`
  then refetches the run before repainting statuses. Each `approved-baseline-missing` row also
  gets a checkbox (siblings, not nested — the row's navigation button became `flex-1` instead of
  `w-full` to make room, since a full-width `<button>` has no slot to nest an `<input>` inside;
  other statuses render no checkbox at all, not a disabled one) feeding a `Set<string>` selection;
  an "Approve selected (N)" button appears once anything's checked and calls the existing
  single-snapshot `POST .../approve` **sequentially per selected name** (not concurrently, and not
  a new batch endpoint — this project's Flask dev server is effectively single-worker, and each
  approve is independent per-snapshot file I/O with nothing to batch-amortize). Failures don't
  stop the loop — every selected name is attempted regardless of earlier outcomes, then a summary
  ("N approved, M failed" plus each failure's message) is shown and the run is refetched, so
  successfully-approved rows lose their checkbox on the next render (no explicit "remove from
  selection" bookkeeping needed) while failed ones stay checkable for a retry.

  **`ScopesView`** — reached via the NavBar link — mirrors `SettingsView`'s two-card-section
  layout: a "Branches" card (one button per `listBranches()` entry) and a "Releases" card (one
  button per `listReleases()` entry, showing `formatRunDate(createdAt)`), each with an empty
  state. Clicking either navigates `RunList` with a `filter: {kind, id}` — **client-side**
  filtering of the same full, unpaginated `listRuns()` result the unfiltered run list already
  fetches (this app has no run-list pagination anywhere, so a second backend filtering code path
  for a filter one `.filter()` call already does would be needless surface). `RunList` computes
  each run's `buildNumber` from the *full* fetched array first, then filters for display — a
  branch/release's runs keep their true global build number, not a renumbered ordinal local to the
  filtered subset. A filtered `RunList` shows a "Branch: <id>" / "Release: <id>" heading and a
  "Back" button (to `ScopesView`); the `filter` (and, deeper in, the originating `runId`/`name`)
  thread through `run` → `snapshot` view navigation so "Back" from a snapshot two levels deep
  returns to the *filtered* run list it came from, not the unfiltered one. Read-only by design —
  no merge-to-master or cut-release actions from the viewer; those stay curl/CI-only, and once a
  scoped run is open, baseline resolution for its images is already fully transparent server-side
  (`scoped_baseline_read_path()`), so `RunDetail`/`SnapshotDetail` needed zero changes to work
  correctly for scoped runs — this feature is purely about *getting to* the right runs.

  **Snapshot detail** shows an inline-editable "Category" text field (empty string ↔ `null`) next
  to the status pill; "Save category" PATCHes it via `updateSnapshotCategory()` and updates local
  state directly (no refetch). A "History" section (thumbnails of prior baselines, newest-first) is
  fetched on mount and refetched after a successful approve, which itself refetches the snapshot
  detail so status stays fresh.

  Image display is **Dual** (baseline + candidate/diff side by side, the default) or **Single**
  (one pane at a time via Baseline/Candidate tabs) — a "Show diff" checkbox swaps whichever pane is
  in the "candidate slot" between `candidateUrl` and `diffUrl` (an image *swap*, not an
  alpha-blended overlay, since the backend's diff PNG is opaque, not a transparency mask; see
  `docs/API.md`). Both baseline and candidate/diff panes render at one shared width
  (`imageDisplaySize.ts`'s `getImageSize()`/`imageSizePx()`, read once on mount — views fully
  remount on navigation, so no live cross-view sync is needed) regardless of the snapshot's own
  captured viewport, via a `style={{width}}` on the `<img>` (not `max-w-full`, which used to make
  differently-sized snapshots render at different display sizes).

  The interactive (candidate-slot) pane is `InteractiveImagePane` — a presentational component
  (owns no state; `SnapshotDetail` owns all of `overlayRef`/`drawStart`/`drawCurrent`/`pendingRect`/
  `imgNaturalSize` and passes them down as props) rendering the drag-to-draw overlay, the resolved
  mask rects (scaled from `imgNaturalSize` against `overlayRef.current.clientWidth/Height`, which
  is why `imgNaturalSize` has to flow back down as a prop, not just up via `onImageLoad` — the
  scaling math runs wherever `overlayRef` lives), and their delete buttons. It's reused unchanged
  whether the pane is showing `candidate.png` or `diff.png` — both are rendered by the backend at
  identical pixel dimensions, so the same natural-to-displayed scale factors apply either way; no
  special-casing needed. Category-scope mask rects get their category's `categoryColor()` border/
  background instead of the default red; global/per-image masks are unaffected.

  Drawing a rect opens `MaskAssignmentMenu` (also presentational, with its own local
  `newCategoryInput`/`showNewCategoryField` state — pure UI-input state scoped to the menu's own
  lifetime, unlike `pendingRect`) offering Global / This snapshot / one button per existing
  category (fetched via `listCategories()` when the menu opens, each with a `categoryColor()` dot)
  / "+ New category" (inline name field). Picking an existing category or creating a new one both
  route through `applyCategory()`, which — before creating the mask — PATCHes the snapshot's own
  `category` to match if it doesn't already (via `updateSnapshotCategory`), since
  `applicable_masks()` on the backend resolves category masks by *the snapshot's own* `category`
  field: a mask created for a category this snapshot isn't tagged with wouldn't apply to it at all,
  and tagging first is what establishes a brand-new category's viewport so the mask-create's bounds
  check can succeed. This two-call sequence isn't atomic (a failed second call after a successful
  tag leaves the snapshot tagged with no mask yet) — a known, accepted, recoverable gap, not an
  oversight.

  Delete is available only for masks whose id can be proven: global and category masks
  (cross-referenced against `GET /api/masks` / `GET /api/categories/<category>/masks`) and masks
  created in the current browser session (tracked client-side from their create response,
  deduplicated by identity against refetched global/category masks to avoid double-binding when
  duplicate-rect masks exist). Pre-existing per-image masks — fetched only via the id-less combined
  endpoint and not created this session — have no delete button, because no endpoint lists
  per-image masks together with their ids. This is a known limitation of the current (frozen) API
  surface, not a bug. `resolveMaskIds()` takes all three id-bearing pools (session-created, global,
  category) and binds each rendered rect to a `{scope, id}` by identity, where `scope` is
  `"global" | "per-image" | "category"`. All `<img>` sites (baseline, candidate/diff, history
  thumbnails) render through `AuthenticatedImage` (see below) rather than plain `<img>`.
- `src/categoryColor.ts` — `categoryColor(name)`: a deterministic string hash into a fixed
  8-color Tailwind palette (`{border, bg, dot}` classes). Pure and client-only — colors are never
  stored server-side, so no schema/API surface exists for them; the same category name always
  produces the same color on any client, without a database round-trip.
- `src/imageDisplaySize.ts` — `ImageSize = "small" | "medium" | "large"`, a fixed
  `{small: 240, medium: 400, large: 640}` px-width table (`imageSizePx()`), and
  `getImageSize()`/`setImageSize()`. Deliberately **localStorage**-backed, unlike `authToken.ts`'s
  `sessionStorage` — a display-size preference should persist across sessions, unlike a
  security-sensitive credential, so this is a considered divergence, not an inconsistency.
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
  `RunSummary` includes `status` (`RunStatus` = `"pass" | "fail" | "pending"`), `scope`
  (`RunScope = {kind: "branch" | "release"; id: string} | null`), `newCount`, and `removedCount`
  alongside `id`/`createdAt`/`snapshotCount` — all computed server-side by `GET /api/runs`.
  `listBranches()` (`GET /api/branches`) and `listReleases()` (`GET /api/releases`, returning
  `ReleaseSummary[]` — `{id, createdAt}`) back `ScopesView`.
  Also exports `imageUrl(path)`, which applies the same `VITE_API_BASE` prefix to image srcs, and
  `getSnapshotHistory(id, name)` / `historyImageUrl(id, name, timestamp)` for the history list and
  its per-entry image URLs. `SnapshotDetail` includes `category: string | null`;
  `updateSnapshotCategory(id, name, category)` PATCHes it; `listCategories()` lists all distinct
  category names currently in use (`GET /api/categories`), for the mask-assignment menu. Mask
  CRUD: `Mask` (has `id`) and `MaskRect` (no `id`, the shape returned by the combined per-snapshot
  masks endpoint) types, plus `listGlobalMasks()` / `createGlobalMask(rect)` /
  `deleteGlobalMask(id)` for global masks, `listSnapshotMasks(id, name)` / `createSnapshotMask(id,
  name, rect)` / `deleteSnapshotMask(id, name, maskId)` for per-image masks, and
  `listCategoryMasks(category)` / `createCategoryMask(category, rect)` /
  `deleteCategoryMask(category, id)` for category masks (category is `encodeURIComponent`-escaped
  into the URL path, so categories containing spaces or other reserved characters work).
  `request<T>()` treats a `204` response as success with no body
  (does not call `.json()`), which the delete-mask endpoints rely on. `request<T>()` merges
  `authHeaders()` into whatever headers the call already sends (e.g. `Content-Type` on mask
  creates), so it's a no-op when no token is stored.
- `src/fixtures/` — contract-verbatim API response fixtures used by tests.
- `src/test-setup.ts` — vitest `setupFiles` entry: stubs `URL.createObjectURL`/`revokeObjectURL`
  (unimplemented in jsdom), which `AuthenticatedImage` needs in every test.
- `src/*.test.tsx` — vitest (+ @testing-library/react, jsdom) tests. `src/categoryColor.test.ts`
  and `src/imageDisplaySize.test.ts` are plain vitest unit tests (no React) for those two
  standalone modules.

## Commands

`npm run dev` (dev server) · `npm run build` · `npm run lint` (typecheck) · `npm test`
