# backend — CODEMAP

**Deprecated.** This project's code map lives on ProbaImpera, one row per file, recorded by the
change that touched it:

```sh
sh .claude/plugins/probaimpera/hooks/call.sh GET \
  "http://127.0.0.1:8200/api/projects/pixelperfectsnapshot/codemap.md?path=backend"
```

Do not add to this file. The long-form map it used to hold is in git history (`f97b99b`); it was
transcribed into the server map by LLM-PPS-11. Only the commands below are kept here, since they
describe no single file.

## Commands

```sh
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check . && .venv/bin/pytest
.venv/bin/flask --app app run              # dev server
.venv/bin/flask --app app process-pending  # render + compare pending snapshots
```

`process-pending` needs the built client artifact (`npm ci && npm run build -w packages/client` at
the repo root) and an installed browser (`.venv/bin/playwright install chromium`).

In a git worktree reusing the main checkout's venv, run tests from the worktree's `backend/` as
`<main checkout>/backend/.venv/bin/python -m pytest`, never bare `.venv/bin/pytest`: the venv's
editable install maps `app` to the main checkout, so bare `pytest` tests main, not the worktree.
