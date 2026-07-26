# pixelperfectsnapshot

Capture DOM snapshots in e2e tests and upload them to a
[PixelPerfectSnapshot](https://github.com/stolau/PixelPerfectSnapshot) backend for rendering,
diffing, and approval.

## Install

```sh
npm install --save-dev pixelperfectsnapshot
```

(Or add it as a git dependency — see "Note on monorepo / git installs" below.)

## Usage

```ts
import { captureSnapshot, createRun, processRun, sendSnapshots } from "pixelperfectsnapshot";

const { id: runId } = await createRun({ serverUrl: "http://localhost:5000" });
const snapshot = await captureSnapshot(document, "my-page");
await sendSnapshots([snapshot], { serverUrl: "http://localhost:5000", runId });
await processRun({ serverUrl: "http://localhost:5000", runId });
```

`serverUrl` is optional on `createRun`, `sendSnapshots`, and `processRun` — if omitted, it falls
back to the `PPS_SERVER_URL` environment variable; an error is thrown if neither is set.

`token` is also optional on `createRun`, `sendSnapshots`, and `processRun` — if omitted, it falls
back to the `PPS_API_TOKEN` environment variable. Unlike `serverUrl`, it's fine for neither to be
set (the request is just sent without an `Authorization` header, e.g. against a backend with auth
off); when a token is resolved, it's sent as `Authorization: Bearer <token>`.

## Blocking elements

Pass `options.blockSelectors` to blank out matching elements (content cleared, size preserved via
inline `width`/`height`, `src` stripped) before their assets are captured:

```ts
const snapshot = await captureSnapshot(document, "my-page", {
  blockSelectors: [".user-avatar", "#chat-widget"],
});
```

Note: this does not strip a blocked element's own inline
`style="background-image:url(...)"` — it is left as-is (and still inlined as a `data:` URI if
same-origin).

## Mask categories

Pass `options.category` to tag a snapshot with a mask category — masks saved against that category
in the viewer apply to every snapshot sharing it, regardless of `name`. Useful for a recurring
same-position element (e.g. a version stamp) that appears across many differently-named snapshots,
without repeating a per-image mask on each one:

```ts
const snapshot = await captureSnapshot(document, "checkout-page", {
  category: "app-shell",
});
```

All snapshots sharing a category must have the same viewport — the backend rejects an upload whose
`category` conflicts with the viewport already established for it.

## Browser bundles

The package also ships two dependency-free IIFE bundles for injecting into pages
(e.g. via Playwright's `addScriptTag`):

- `dist/capture.js` — installs `window.__ppsCapture(document, name): Promise<Snapshot>`
- `dist/rehydrate.js` — installs `window.__ppsRehydrate(snapshot): Promise<void>`

## Note on monorepo / git installs

Installing this package from git or a monorepo checkout with `--omit=dev` cannot run the
`prepare` build (typescript/esbuild are devDependencies), so `dist/` will be missing. The
published tarball ships `dist/` prebuilt.
