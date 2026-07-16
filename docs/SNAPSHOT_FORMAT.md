# Snapshot format v0

**Status: FROZEN.** Changes require a version bump (v0.1) landed as its own change — never edited
concurrently with work that consumes this contract. Machine-readable schema:
[`snapshot.schema.json`](snapshot.schema.json). Example: [`examples/example-snapshot.json`](examples/example-snapshot.json).

A snapshot is a single self-contained JSON document describing one captured page state. It must be
re-renderable in a headless browser with no network access to the captured origin.

## Fields

| Field | Type | Meaning |
|---|---|---|
| `formatVersion` | `0` (const) | Format version of this document. |
| `name` | string | Snapshot name chosen by the test author, e.g. `"checkout-page"`. Identifies the snapshot within a run. Must not contain `/` (names appear as URL path segments, see [API.md](API.md)). Baselines are keyed by **(name, viewport)**. |
| `viewport` | `{width, height}` | CSS-pixel viewport size at capture time. Re-rendering uses exactly this viewport. |
| `html` | string | The serialized DOM: doctype plus `documentElement.outerHTML` at capture time. All same-origin asset references (`img src`, CSS `url(...)` in inline styles, `@font-face` font files) are replaced with `data:` URIs before serialization. |
| `stylesheets` | array of `{href, content}` | Same-origin stylesheets in document order. `href` is the resolved URL of the `<link rel="stylesheet">` it came from (`null` for entries not tied to a link element). `content` is the CSS text with same-origin `url(...)` references inlined as `data:` URIs. |

## Rehydration semantics

Rehydration is performed by the single shared browser artifact `rehydrate.js` (built in
`packages/client`, injected by both TS tests and the Python render engine — never reimplemented):

1. Load `html` into a fresh page (no network access to the captured origin).
2. For each `stylesheets` entry in order: replace the `<link rel="stylesheet">` whose resolved
   `href` matches the entry with a `<style>` element containing `content`, preserving position.
   Entries with `href: null` are appended as `<style>` elements at the end of `<head>`.
3. Render at exactly `viewport`, with animations/transitions disabled and after fonts and images
   have loaded.

## v0 scope

**In scope:** static DOM, same-origin stylesheets, same-origin assets (images, `@font-face` font
files) inlined as data URIs, inline styles.

**Out of scope (explicitly, for v0):** cross-origin assets and stylesheets (left as-is; may render
differently or not at all), shadow DOM, `<canvas>`/`<video>` content, iframes, constructed/adopted
stylesheets, dynamic state not reflected in the DOM (scroll position, focus, `:hover`).

## Transport

Run identity is **not** part of the snapshot — it is transport-level, carried by the upload URL
(`POST /api/runs/<run_id>/snapshots`, see [API.md](API.md)).
