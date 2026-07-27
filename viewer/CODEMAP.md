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
  password field with "Save token" / "Clear token" buttons wired to `setAuthToken()`)
  and `CategoriesSection` (one row per category from `listCategories()` — a `categoryColor()` dot,
  name, "N snapshots, M masks" counts, inline Rename [text input + Save/Cancel, mirroring
  `MaskAssignmentMenu`'s "+ New category" field], and Delete; both actions refetch the list on
  success and show the server's error inline on failure — a rejected rename stays in edit mode
  with the attempted value still in the input, so it can be fixed and retried rather than lost),
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

  **Snapshot detail** is laid out to keep the image itself the visual focus, as large as the
  available width allows: a single top bar holds the status pill, the Dual/Single toggle, "Show
  diff" checkbox, (in Single mode only) the Baseline/Candidate tabs — Baseline `disabled` when
  `snapshot.baselineUrl === null`, so there's nothing to switch to — and, pushed to the far right
  via `justify-between`, the Approve checkmark; the image(s) render directly below with no
  positioned wrapper of their own. There is **no standalone Category field** — category membership
  is visible and settable only through the mask-assignment flow (see below); this is a deliberate
  choice, not an oversight (see the "Category ↔ masks" note below). Approve is a small circular
  checkmark button, a plain flex item in the top bar (not absolutely positioned over the image, so
  it can never overlap the actual pixels), colored via the same `statusStyles(status).dot` used by
  the status pill — amber (`approved-baseline-missing`), red (`fail`), green (`pass`), grey
  (`pending`/unknown) — and **disabled once `status === "pass"`**: approving a passing snapshot is
  not actually a no-op server-side (`compare()`'s `MAX_DIFF_RATIO` tolerates small drift, so a
  passing snapshot can still differ slightly from its baseline, and approving would re-pin it), but
  the UI deliberately trades that drift-reset capability away for a simpler "green = nothing to
  click" affordance — it's reachable only via a raw API call once a snapshot is already passing.
  Below the image, a "Masks" hashtag-style chip row (see below) and a collapsed-by-default
  `<details>` "History" section (thumbnails of prior baselines, newest-first, fetched on mount and
  refetched after a successful approve, which itself refetches the snapshot detail so status stays
  fresh).

  Image display is **Dual** (baseline + candidate/diff side by side, each pane `flex-1 min-w-0` so
  they split the available width, the default) or **Single** (one pane at a time via
  Baseline/Candidate tabs, naturally full width as a block element) — a "Show diff" checkbox swaps
  whichever pane is in the "candidate slot" between `candidateUrl` and `diffUrl` (an image *swap*,
  not an alpha-blended overlay, since the backend's diff PNG is opaque, not a transparency mask;
  see `docs/API.md`). Both panes render responsively (`className="w-full h-auto"` on the `<img>`)
  regardless of the snapshot's own captured viewport, filling whatever width their container gives
  them — there is no fixed-size preference anymore (the old Settings "Image display size" control
  and its `imageDisplaySize.ts` module were removed once this became their only consumer; see
  below). `InteractiveImagePane`'s wrapping `overlayRef` div is deliberately `w-full` (not
  `inline-block`, which was tried and found to shrink-wrap to the image's *intrinsic* size rather
  than fill available width — a plain `inline-block` + percentage-width child resolves against an
  indeterminate containing block) — `position: relative` is unaffected by that, so the mask
  rects' `absolute` positioning against this same element still works correctly.

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

  **Category ↔ masks.** `category` is one string column on a snapshot (`backend/app/db.py`) that
  has always done double duty: a Settings label, and the scoping key for category masks. There is
  no separate "general label" concept — a category's only real purpose is to be a mask-preset
  name, so `applyCategory()` (above) is the **only** place category membership is ever set; there
  is no standalone editable Category field anywhere in the UI. This also means there is currently
  **no way to untag** a snapshot from a category short of deleting the category globally (which
  itself requires no snapshot still be tagged with it) — a deliberate, author-confirmed tradeoff,
  not an oversight, mirroring the earlier approve-on-`pass` tradeoff above.

  Delete is available only for masks whose id can be proven: global and category masks
  (cross-referenced against `GET /api/masks` / `GET /api/categories/<category>/masks`) and masks
  created in the current browser session (tracked client-side from their create response,
  deduplicated by identity against refetched global/category masks to avoid double-binding when
  duplicate-rect masks exist). Pre-existing per-image masks — fetched only via the id-less combined
  endpoint and not created this session — have no delete button, because no endpoint lists
  per-image masks together with their ids. This is a known limitation of the current (frozen) API
  surface, not a bug. `resolveMaskIds()` takes all three id-bearing pools (session-created, global,
  category) and binds each rendered rect to a `{scope, id}` by identity, where `scope` is
  `"global" | "per-image" | "category"`.

  Applicable masks — previously visible **only** as overlay rectangles on the candidate image
  itself, with no indication anywhere else that a snapshot had any masks at all — now also render
  as a row of chips below the image. Global and per-image masks each get their own Instagram-style
  hashtag chip (`#global`, `#this image`), colored via `MASK_SCOPE_DOT` (two fixed constants, since
  neither scope has a name to hash) — a chip's binding is resolved the same way as its overlay rect
  (`resolveMaskIds()`, called a second time in `SnapshotDetail` against the same inputs); a rect
  with no resolved binding is inferred to be scope `"per-image"` by elimination (global/category
  pools are always fully enumerated with ids, so an unmatched rect can't be either) and renders its
  chip with no remove control, mirroring the overlay rect's own missing delete button exactly.
  **Category-scope masks collapse to a single chip**, not one per mask: `{category} ({count})`,
  `categoryColor(name).dot`-colored, no `#` prefix, no remove control — a category is a preset
  bundle applied as one unit, not a set of individually-taggable masks, so the UI treats it that
  way (a snapshot can only ever carry one category at a time, per the single `category` column, so
  every category-scope binding in the merged list is guaranteed to share the same name). The
  surviving way to delete an individual category mask is still `InteractiveImagePane`'s per-rect
  overlay "×" on the image itself — Settings' `CategoriesSection` only ever exposes an aggregate
  count plus whole-category rename/delete, never per-mask management. All `<img>` sites (baseline,
  candidate/diff, history thumbnails) render through `AuthenticatedImage` (see below) rather than
  plain `<img>`.
- `src/categoryColor.ts` — `categoryColor(name)`: a deterministic string hash into a fixed
  8-color Tailwind palette (`{border, bg, dot}` classes). Pure and client-only — colors are never
  stored server-side, so no schema/API surface exists for them; the same category name always
  produces the same color on any client, without a database round-trip.
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
  `updateSnapshotCategory(id, name, category)` PATCHes it; `listCategories()` returns
  `CategorySummary[]` (`{name, snapshotCount, maskCount}`, `GET /api/categories`) — the
  mask-assignment menu maps it down to names only, `CategoriesSection` uses the full shape;
  `renameCategory(oldName, newName)` / `deleteCategory(name)` back the latter's actions. Mask
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
  is a plain vitest unit test (no React) for that standalone module.

## Commands

`npm run dev` (dev server) · `npm run build` · `npm run lint` (typecheck) · `npm test`
