# packages/client — CODEMAP

npm library (`pixelperfectsnapshot`) installed into target projects to capture DOM snapshots in
e2e tests and upload them to the backend.

## Public surface (`src/index.ts`)

- `FORMAT_VERSION` — snapshot format version this library produces (see `docs/SNAPSHOT_FORMAT.md`).
- `Snapshot` — TypeScript type of a captured snapshot (mirrors `docs/snapshot.schema.json`).

## Layout

- `src/index.ts` — library entry point.
- `src/*.test.ts` — vitest tests.

## Commands

`npm run build` (tsc → `dist/`) · `npm run lint` (typecheck) · `npm test` (vitest)
