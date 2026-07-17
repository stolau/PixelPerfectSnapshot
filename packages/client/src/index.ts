import "./global.js";

/** Snapshot format version this library produces. See docs/SNAPSHOT_FORMAT.md. */
export const FORMAT_VERSION = 0;

/** A captured snapshot per docs/snapshot.schema.json (format v0). */
export interface Snapshot {
  formatVersion: 0;
  name: string;
  viewport: { width: number; height: number };
  html: string;
  stylesheets: { href: string; content: string }[];
}

export { captureSnapshot } from "./capture.js";
export { rehydrate } from "./rehydrate.js";
export { sendSnapshots } from "./send.js";
