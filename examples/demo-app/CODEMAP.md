# examples/demo-app — CODEMAP

Dogfood example: a tiny static site plus an e2e test that drives the whole pipeline (capture →
upload → render → diff → approve) against the real Flask backend.

## Layout

- `site/` — the demo page (`index.html`, `style.css`, `dot.png`). The `.box` rule's
  `#1a1a6e` background is the visual-regression target: the e2e test string-swaps it to
  `#c0392b` to serve a "changed" variant.
- `e2e.test.ts` — vitest e2e suite (serves `site/`, captures with `pixelperfectsnapshot`,
  runs the backend's `process-pending`, asserts pass/fail/approve behavior). Also drives the
  built viewer in a real browser against the live backend; `pretest:e2e` builds the viewer
  with `VITE_API_BASE=/backend` so its requests and image srcs target the backend.

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
