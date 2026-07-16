# viewer — CODEMAP

React + Vite web UI: lists runs, shows baseline/candidate/diff side by side, approves baselines.
Consumes the backend HTTP API (`docs/API.md`).

## Layout

- `index.html` — Vite entry document.
- `src/main.tsx` — React root bootstrap.
- `src/App.tsx` — application root: three views with state-based navigation — run list →
  run detail → snapshot detail (baseline/candidate/diff side by side, approve button).
- `src/api.ts` — typed client for the backend HTTP API (`docs/API.md`). Prefixes requests with
  `VITE_API_BASE` (empty by default; dev server proxies `/api` to `http://localhost:5000`).
- `src/fixtures/` — contract-verbatim API response fixtures used by tests.
- `src/*.test.tsx` — vitest (+ @testing-library/react, jsdom) tests.

## Commands

`npm run dev` (dev server) · `npm run build` · `npm run lint` (typecheck) · `npm test`
