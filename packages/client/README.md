# pixelperfectsnapshot

Capture DOM snapshots in e2e tests and upload them to a
[PixelPerfectSnapshot](https://github.com/stolau/PixelPerfectSnapshot) backend for rendering,
diffing, and approval.

## Install

Not yet published to npm. Until it is, install it locally from a checkout of this repo:

```sh
cd packages/client && npm install
npm link
# then, in your project:
npm link pixelperfectsnapshot
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

## Browser bundles

The package also ships two dependency-free IIFE bundles for injecting into pages
(e.g. via Playwright's `addScriptTag`):

- `dist/capture.js` — installs `window.__ppsCapture(document, name): Promise<Snapshot>`
- `dist/rehydrate.js` — installs `window.__ppsRehydrate(snapshot): Promise<void>`

## Note on monorepo / git installs

Installing this package from git or a monorepo checkout with `--omit=dev` cannot run the
`prepare` build (typescript/esbuild are devDependencies), so `dist/` will be missing. The
published tarball ships `dist/` prebuilt.
