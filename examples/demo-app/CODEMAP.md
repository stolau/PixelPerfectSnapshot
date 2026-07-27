# examples/demo-app — CODEMAP

Dogfood example: a tiny static site plus an e2e test that drives the whole pipeline (capture →
upload → render → diff → approve) against the real Flask backend.

## Layout

- `site/` — the demo page (`index.html`, `style.css`, `dot.png`). The `.box` rule's
  `#1a1a6e` background is the visual-regression target: the e2e test string-swaps it to
  `#c0392b` to serve a "changed" variant.
- `e2e.test.ts` — vitest e2e suite, eight tests, **10 captured snapshots total**, **run in file
  declaration order, not independent**: each later test reuses the real Flask backend / demo site
  / browser / built viewer the earlier ones spawned, via module-level `let` state (`serverUrl`,
  `siteUrl`, `viewerUrl`, `browser`, …) — every test past the first two opens with an explicit
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
  not just the category listing), **a category with two masks collapsing to one `{category} (2)`
  chip instead of two separate chips** (drawing a second rect and picking the now-existing
  category button from the assignment picker, rather than "+ New category" again), and **the
  Approve checkmark actually being `disabled` on a real rendered `<button>` once a snapshot is
  `pass`** — jsdom (the unit-test environment `viewer/src/App.test.tsx` runs under) can't render
  real interactivity, so this is the only place that `disabled` state is proven against a genuine
  DOM element rather than React Testing Library's simulated one. These last two close a real gap:
  both behaviors shipped in the snapshot-detail redesign PRs and were previously verified only by
  mocked-fetch unit tests and manual Docker screenshots, never by this live-browser-plus-live-
  backend suite. `capturePage()` takes an optional `name` param (default `"demo-page"`, so tests
  1-2's calls are unchanged) so tests 3-8 can use distinctly-named snapshots and avoid colliding
  with tests 1-2's own baseline/approval state in the shared data dir. The in-file viewer proxy
  (started by test 2, reused by tests 3-8) forwards the request body and `Content-Type` for any
  method — not just the bodyless `POST .../approve` the original two-test suite ever sent through
  it — since mask creation and category rename both need a real JSON body to reach the backend
  through the live viewer's own `fetch()` calls.

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
