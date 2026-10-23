# packages/client — CODEMAP

**Deprecated.** This project's code map lives on ProbaImpera, one row per file, recorded by the
change that touched it:

```sh
sh .claude/plugins/probaimpera/hooks/call.sh GET \
  "http://127.0.0.1:8200/api/projects/pixelperfectsnapshot/codemap.md?path=packages/client"
```

Do not add to this file. The long-form map it used to hold is in git history (`f97b99b`); it was
transcribed into the server map by LLM-PPS-11. Only the commands below are kept here, since they
describe no single file.

## Commands

`npm run build` (tsc → `dist/`, then `scripts/bundle.mjs`) · `npm run lint` (typecheck) ·
`npm test` (pretest installs Chromium via `playwright install chromium`, then build, then vitest —
browser tests need the built `dist/` bundles) · `prepare` runs the build, so a root `npm ci`
produces `dist/` automatically. Package `exports` exposes only `"."` — subpath types would lie
because `scripts/bundle.mjs` overwrites tsc's `dist/capture.js`/`dist/rehydrate.js` while their
`.d.ts` siblings remain.
