# packages/client — CODEMAP

npm library (`pixelperfectsnapshot`) installed into target projects to capture DOM snapshots in
e2e tests and upload them to the backend.

## Public surface (`src/index.ts`)

- `FORMAT_VERSION` — snapshot format version this library produces (see `docs/SNAPSHOT_FORMAT.md`).
- `Snapshot` — TypeScript type of a captured snapshot (mirrors `docs/snapshot.schema.json`).
- `captureSnapshot(document, name): Promise<Snapshot>` — captures the page as a self-contained
  snapshot (same-origin assets inlined as `data:` URIs); never mutates the live page.
- `sendSnapshots(snapshots, {serverUrl, runId}): Promise<void>` — sequential upload to
  `POST /api/runs/<runId>/snapshots` (see `docs/API.md`); throws on the first non-ok response.
- `rehydrate(snapshot, doc?): Promise<void>` — applies snapshot stylesheets, disables
  animations/transitions, and resolves once fonts and images have loaded
  (`docs/SNAPSHOT_FORMAT.md` rehydration steps 2–3).

## Built artifacts (`dist/`, via `npm run build`)

- `dist/index.js` + `dist/index.d.ts` — library entry (ESM bundle).
- `dist/rehydrate.js` — dependency-free IIFE browser bundle; installs
  `window.__ppsRehydrate(snapshot): Promise<void>`. Injected by TS tests and the Python render
  engine — the single shared rehydration implementation.
- `dist/capture.js` — dependency-free IIFE browser bundle; installs
  `window.__ppsCapture(document, name): Promise<Snapshot>`.

## Layout

- `src/index.ts` — library entry point.
- `src/capture.ts` / `src/rehydrate.ts` / `src/send.ts` — implementations.
- `src/css-urls.ts` — pure `rewriteCssUrls` helper (unit-testable without a browser).
- `src/capture-entry.ts` / `src/rehydrate-entry.ts` / `src/global.d.ts` — browser-bundle entries
  and their `window` declarations.
- `src/*.test.ts` — vitest tests.
- `scripts/bundle.mjs` — esbuild step producing the browser bundles (and rebundling
  `dist/index.js`, since the IIFE outputs overwrite tsc's `dist/capture.js`/`dist/rehydrate.js`).
- `fixtures/` — test fixture page (`index.html`, `main.css`, `dot.png`, `test-font.ttf`; font is
  Liberation Mono, license in `FONT-LICENSE.txt`).

## Commands

`npm run build` (tsc → `dist/`, then `scripts/bundle.mjs`) · `npm run lint` (typecheck) ·
`npm test` (pretest installs Chromium via `playwright install chromium`, then build, then vitest —
browser tests need the built `dist/` bundles)
