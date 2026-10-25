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

## Spec tags

Pass `options.spec` to tag a snapshot with the spec id of the screen it shows, and `options.when`
with the state it shows, so a consumer can tie the snapshot to a spec and one of its states (see
[docs/SNAPSHOT_FORMAT.md](https://github.com/stolau/PixelPerfectSnapshot/blob/main/docs/SNAPSHOT_FORMAT.md)). Both are optional and have no effect
on rendering, diffing or baselines; `when` is allowed only with `spec` (a type error, and
`captureSnapshot` rejects it at run time):

```ts
const snapshot = await captureSnapshot(document, "checkout-page", {
  spec: "pps-checkout",
  when: "cart has two items",
});
```

## Run bundles

`writeBundle(snapshots, filePath)` writes the client form of a run bundle, a `.zip` of a
`manifest.json` and each snapshot document, in the format of
[docs/BUNDLE_FORMAT.md](https://github.com/stolau/PixelPerfectSnapshot/blob/main/docs/BUNDLE_FORMAT.md). It is Node-only, so it lives in its own
subpath and the main entry stays free of Node built-ins:

```ts
import { writeBundle } from "pixelperfectsnapshot/bundle";

await writeBundle([snapshot], "run.zip");
```

The client bundle holds snapshot documents only: `run` and every `status` are `null`. It rejects,
before writing anything, duplicate snapshot names, a snapshot with `when` but no `spec`, a name,
category, spec or when outside the snapshot format's shapes, a non-integer or zero viewport, and a
bundle beyond zip32 (more than 65535 entries or 4 GiB). The server produces the same format with
images and statuses for an uploaded run; see `GET /api/runs/<run_id>/export.zip` in
[docs/API.md](https://github.com/stolau/PixelPerfectSnapshot/blob/main/docs/API.md).

## Browser bundles

The package also ships two dependency-free IIFE bundles for injecting into pages
(e.g. via Playwright's `addScriptTag`):

- `dist/capture.js` — installs `window.__ppsCapture(document, name, options?): Promise<Snapshot>`,
  taking the same options as `captureSnapshot`
- `dist/rehydrate.js` — installs `window.__ppsRehydrate(snapshot): Promise<void>`

## Note on monorepo / git installs

Installing this package from git or a monorepo checkout with `--omit=dev` cannot run the
`prepare` build (typescript/esbuild are devDependencies), so `dist/` will be missing. The
published tarball ships `dist/` prebuilt.
