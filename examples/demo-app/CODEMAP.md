# examples/demo-app — CODEMAP

Dogfood example: a tiny static site plus an e2e test that drives the whole pipeline (capture →
upload → render → diff → approve) against the real Flask backend.

## Layout

- `site/` — the demo page (`index.html`, `style.css`, `dot.png`). The `.box` rule's
  `#1a1a6e` background is the visual-regression target: the e2e test string-swaps it to
  `#c0392b` to serve a "changed" variant. `dot.png` is also reused 10x in a `.thumbs` gallery
  (distinct `alt="dot-N"` per `<img>`, same underlying file — no need for 10 separate binary
  assets) purely so a captured/rendered snapshot has more than one real `<img>` to look at when
  browsing manually; none of the gallery images are referenced by any test assertion.
- `e2e.test.ts` — vitest e2e suite, fourteen tests, **run in file declaration order, not
  independent**: each later test reuses the real Flask backend / demo site / browser / built
  viewer the earlier ones spawned, via module-level `let` state (`serverUrl`, `siteUrl`,
  `viewerUrl`, `browser`, `dataDir`, …) — every test past the first two opens with an explicit
  `if (x === "") throw new Error("<prior test> must run (and pass) first")` guard naming its
  dependency, so running one in isolation (`vitest run -t "..."`, a future reorder) fails with a
  clear message instead of a bare `TypeError`. Tests 1-2: "full pipeline dogfood" (serves `site/`,
  captures with `pixelperfectsnapshot`, processes each run via `POST /api/runs/<run_id>/process`,
  asserts pass/fail/approve behavior — pure API-level, no browser UI) and "viewer against the live
  backend" (drives the **built** viewer in a real browser; `pretest:e2e` builds it with
  `VITE_API_BASE=/backend` so requests/image srcs target the backend through a same-origin
  proxy this file runs itself — see below). Tests 3-8 extend that same shared pipeline to cover
  masks (drag-draw + save-as-global + delete against a real rendered image), Branches & Releases
  (a branch-scoped run created via a raw `fetch` — `createRun()` has no `scope` param — approved,
  then found through the viewer's filtered list), bulk approve (two new snapshots, both
  checkbox-selected and approved in one action), category management (tag via the mask-assignment
  flow → rename → confirm the cascade landed on the snapshot's own masks-section category chip,
  not just the category listing), a category with two masks collapsing to one `{category} (2)`
  chip instead of two separate chips (drawing a second rect and picking the now-existing
  category button from the assignment picker, rather than "+ New category" again), and the
  Approve checkmark actually being `disabled` on a real rendered `<button>` once a snapshot is
  `pass` — jsdom (the unit-test environment `viewer/src/App.test.tsx` runs under) can't render
  real interactivity, so this is one of several places `disabled` state is proven against a
  genuine DOM element rather than React Testing Library's simulated one. `capturePage()` takes an
  optional `name` param (default `"demo-page"`, so tests 1-2's calls are unchanged) so later tests
  can use distinctly-named snapshots and avoid colliding with tests 1-2's own baseline/approval
  state in the shared data dir. The in-file viewer proxy (started by test 2, reused by tests 3-13)
  forwards the request body and `Content-Type` for any method — not just the bodyless
  `POST .../approve` the original two-test suite ever sent through it — since mask creation and
  category rename both need a real JSON body to reach the backend through the live viewer's own
  `fetch()` calls.

  Tests 9-14 close six more live-coverage gaps, each picked because the behavior shipped in a
  recent PR but was previously proven only by a mocked-fetch unit test or a one-off manual Docker
  screenshot, never by this suite: deleting a mask via its hashtag chip's own remove control (not
  just the on-image rect's delete button); the Single-view Baseline tab's `disabled` state when
  there's no baseline yet (mirrors the Approve-checkmark proof above); the candidate/baseline
  images actually filling their pane's width rather than shrinking to their 480px natural capture
  size — the exact regression class the redesign's `InteractiveImagePane` `inline-block → w-full`
  fix guarded against (Dual view's own per-pane width is capped below 480px by the page's
  intentional `max-w-5xl`, so the strongest direct proof is in Single view, which gives the one
  pane the full content column); a mask category's deletion being refused while a snapshot is
  still tagged with it; bulk approve reporting a **genuine** partial failure — one candidate
  image's file is deleted directly from `dataDir` (module-level, set by test 1) between processing
  and approving, so the backend's `approve_snapshot` genuinely 409s for that one snapshot
  (`backend/app/api.py`) rather than the failure being simulated; and a full capture → approve →
  browse flow against a **second, fully self-contained** Flask process spawned with
  `PPS_API_TOKEN` set (own temp data dir, own port, own viewer-proxy static server, torn down in
  a local `finally` block) — auth is deliberately never turned on on the shared backend the other
  thirteen tests reuse, since that would break all of their existing unauthenticated calls;
  confirms both that an unauthenticated request is genuinely rejected (`401`) and that the
  viewer's own Settings auth-token field unlocks the real, live flow end to end.
- `dogfood-viewer.mjs` — a different kind of dogfooding than `e2e.test.ts`: instead of driving a
  fully ephemeral, self-contained backend torn down at the end of the run, this points at a
  **real, persistent, already-deployed** PixelPerfectSnapshot instance (`PPS_SERVER_URL` +
  `PPS_VIEWER_URL` env vars, `PPS_API_TOKEN` optional) and captures a handful of the viewer's own
  key pages (run list, run detail, snapshot detail dual/single, Settings, Branches & Releases) as
  snapshots *of the product itself*, using the same `pixelperfectsnapshot` client any consumer
  would. It never auto-approves — review and approval happen through that same real, deployed
  viewer, the same as any other snapshot in it. Snapshot names are fixed
  (`dogfood-run-list`, `dogfood-snapshot-detail-dual`, …), so repeated runs diff against whatever
  was previously approved for that name; there's nothing dogfood-specific about the diffing
  itself. Each run also seeds a small amount of fresh, `dogfood-`-prefixed demo data (a passing
  baseline plus a genuine regression against it) so the captured pages always have something real
  to render, even against a brand-new instance — this accumulates across repeated runs the same
  way any product's real usage would; the script makes no attempt to manage retention. The point:
  a genuine layout regression in the viewer itself (the kind this project has so far only caught
  by hand, via one-off Docker/Podman screenshots — an image silently shrinking to its intrinsic
  size, a popup drifting off its anchor) becomes a real, reviewable diff instead, the same way any
  other product's visual regression would surface.

## Commands

Prerequisites (repo root):

```sh
npm ci
python3 -m venv backend/.venv && backend/.venv/bin/pip install -e 'backend[dev]'
backend/.venv/bin/playwright install chromium
```

(`npm ci` builds `packages/client`'s `dist/` via its `prepare` script.)

Then:

```sh
npm run test:e2e -w examples/demo-app
```

The test resolves the flask binary as: `PPS_FLASK` env var → `backend/.venv/bin/flask` →
`flask` on PATH, and fails fast with the setup instructions above when the flask binary can't
start. `npm test` here is a stub (no unit tests) so the root workspace test run stays green
without Python.

To dogfood a real, persistent, already-deployed instance instead (see `dogfood-viewer.mjs` above):

```sh
PPS_SERVER_URL=https://your-backend PPS_VIEWER_URL=https://your-viewer \
  [PPS_API_TOKEN=...] npm run dogfood -w examples/demo-app
```
