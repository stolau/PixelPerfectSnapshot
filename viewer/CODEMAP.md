# viewer — CODEMAP

**Deprecated.** This project's code map lives on ProbaImpera, one row per file, recorded by the
change that touched it:

```sh
sh .claude/plugins/probaimpera/hooks/call.sh GET \
  "http://127.0.0.1:8200/api/projects/pixelperfectsnapshot/codemap.md?path=viewer"
```

Do not add to this file. The long-form map it used to hold is in git history (`f97b99b`); it was
transcribed into the server map by LLM-PPS-11. Only the commands below are kept here, since they
describe no single file.

## Commands

`npm run dev` (dev server) · `npm run build` · `npm run lint` (typecheck) · `npm test`
