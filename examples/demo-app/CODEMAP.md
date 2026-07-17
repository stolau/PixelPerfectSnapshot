# examples/demo-app — CODEMAP

Dogfood example: a tiny static site plus an e2e test that drives the whole pipeline (capture →
upload → render → diff → approve) against the real Flask backend.

## Layout

- `site/` — the demo page (`index.html`, `style.css`, `dot.png`). The `.box` rule's
  `#1a1a6e` background is the visual-regression target: the e2e test string-swaps it to
  `#c0392b` to serve a "changed" variant.
- `e2e.test.ts` — vitest e2e suite (serves `site/`, captures with `pixelperfectsnapshot`,
  runs the backend's `process-pending`, asserts pass/fail/approve behavior).

## Commands

Prerequisites (repo root):

```sh
npm ci && npm run build -w packages/client
python3 -m venv backend/.venv && backend/.venv/bin/pip install -e 'backend[dev]'
backend/.venv/bin/playwright install chromium
```

Then:

```sh
npm run test:e2e -w examples/demo-app
```

The test resolves the flask binary as: `PPS_FLASK` env var → `backend/.venv/bin/flask` →
`flask` on PATH. `npm test` here is a stub (no unit tests) so the root workspace test run
stays green without Python. `npm run lint` builds `packages/client` first (`prelint`) — the
spec imports the package's built types.
