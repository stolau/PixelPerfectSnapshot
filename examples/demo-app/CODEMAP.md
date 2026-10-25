# examples/demo-app — CODEMAP

**Deprecated.** This project's code map lives on ProbaImpera, one row per file, recorded by the
change that touched it:

```sh
sh .claude/plugins/probaimpera/hooks/call.sh GET \
  "http://127.0.0.1:8200/api/projects/pixelperfectsnapshot/codemap.md?path=examples/demo-app"
```

Do not add to this file. The long-form map it used to hold is in git history (`f97b99b`); it was
transcribed into the server map by LLM-PPS-11. Only the commands below are kept here, since they
describe no single file.

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
without Python. A direct `vitest run` skips the `pretest:e2e` viewer build and fails; use the
npm script.

In a git worktree (e.g. `.claude/worktrees/<card>`), either run the prerequisites above inside it
(its own venv, slower) or, after only `npm ci`, reuse the main checkout's venv:

```sh
MAIN=$(git worktree list | head -1 | cut -d' ' -f1)   # the main checkout
PPS_FLASK=$MAIN/backend/.venv/bin/flask npm run test:e2e -w examples/demo-app
```

flask runs with this worktree's `backend/` as cwd, so the worktree's `app` is the one under test.
For backend tests the same way, see `backend/CODEMAP.md`.

To also dogfood a real, persistent, already-deployed instance while the suite runs:

```sh
PPS_DOGFOOD_SERVER_URL=https://your-backend [PPS_DOGFOOD_TOKEN=...] \
  npm run test:e2e -w examples/demo-app
```
