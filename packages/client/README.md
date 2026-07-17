# pixelperfectsnapshot

Capture DOM snapshots in e2e tests and upload them to a
[PixelPerfectSnapshot](https://github.com/stolau/PixelPerfectSnapshot) backend for rendering,
diffing, and approval.

## Install

```sh
npm install --save-dev pixelperfectsnapshot
```

## Usage

```ts
import { captureSnapshot, createRun, sendSnapshots } from "pixelperfectsnapshot";

const { id: runId } = await createRun({ serverUrl: "http://localhost:5000" });
const snapshot = await captureSnapshot(document, "my-page");
await sendSnapshots([snapshot], { serverUrl: "http://localhost:5000", runId });
```

## Browser bundles

The package also ships two dependency-free IIFE bundles for injecting into pages
(e.g. via Playwright's `addScriptTag`):

- `dist/capture.js` — installs `window.__ppsCapture(document, name): Promise<Snapshot>`
- `dist/rehydrate.js` — installs `window.__ppsRehydrate(snapshot): Promise<void>`

## Note on monorepo / git installs

Installing this package from git or a monorepo checkout with `--omit=dev` cannot run the
`prepare` build (typescript/esbuild are devDependencies), so `dist/` will be missing. The
published tarball ships `dist/` prebuilt.
