# viewer — CODEMAP

React + Vite web UI: lists runs, shows baseline/candidate/diff side by side, approves baselines.
Consumes the backend HTTP API (`docs/API.md`).

## Layout

- `index.html` — Vite entry document.
- `src/main.tsx` — React root bootstrap.
- `src/App.tsx` — application root: three views with state-based navigation — run list →
  run detail → snapshot detail (baseline/candidate/diff side by side, approve button; refetches
  the snapshot after a successful approve so the status stays fresh). Run detail shows a
  "Process pending" button when any snapshot is pending, which POSTs `/process` then refetches
  the run (same pattern as approve's post-action refetch) before repainting statuses.
- `src/api.ts` — typed client for the backend HTTP API (`docs/API.md`). Prefixes requests with
  `VITE_API_BASE` (empty by default; dev server proxies `/api` to `http://localhost:5000`).
  Also exports `imageUrl(path)`, which applies the same `VITE_API_BASE` prefix to image srcs.
- `src/fixtures/` — contract-verbatim API response fixtures used by tests.
- `src/*.test.tsx` — vitest (+ @testing-library/react, jsdom) tests.

## Commands

`npm run dev` (dev server) · `npm run build` · `npm run lint` (typecheck) · `npm test`
