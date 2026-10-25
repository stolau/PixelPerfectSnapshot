import { writeFile } from "node:fs/promises";
import type { Snapshot } from "./index.js";
import { zip } from "./zip.js";

/**
 * Writes the client form of a run bundle (docs/BUNDLE_FORMAT.md) to
 * `filePath`: a manifest.json plus each snapshot document, in input order.
 * Node-only; published as the `pixelperfectsnapshot/bundle` subpath.
 *
 * Refuses, before writing anything, duplicate snapshot names, a snapshot
 * with `when` but no `spec`, a name, category, spec or when outside the
 * shapes docs/snapshot.schema.json allows, a viewport side that is not an
 * integer >= 1, and a bundle too large for zip32.
 */
export async function writeBundle(snapshots: Snapshot[], filePath: string): Promise<void> {
  const seen = new Set<string>();
  for (const s of snapshots) {
    if (seen.has(s.name)) throw new Error(`writeBundle: duplicate snapshot name ${JSON.stringify(s.name)}`);
    seen.add(s.name);
    if (s.when !== undefined && s.spec === undefined) {
      throw new Error(`writeBundle: snapshot ${JSON.stringify(s.name)} has when without spec`);
    }
    checkShape(s);
  }

  const width = Math.max(4, String(snapshots.length).length);
  const entries: { name: string; data: Buffer }[] = [];
  const manifestSnapshots = snapshots.map((s, i) => {
    const snapshotPath = `snapshots/${String(i + 1).padStart(width, "0")}/snapshot.json`;
    entries.push({ name: snapshotPath, data: Buffer.from(JSON.stringify(s), "utf8") });
    return {
      name: s.name,
      viewport: { width: s.viewport.width, height: s.viewport.height },
      category: s.category ?? null,
      spec: s.spec ?? null,
      when: s.when ?? null,
      status: null,
      files: { snapshot: snapshotPath },
    };
  });
  const manifest = {
    bundleVersion: 0,
    producer: "client",
    run: null,
    snapshots: manifestSnapshots,
  };
  entries.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });

  await writeFile(filePath, zip(entries));
}

// The shapes of docs/snapshot.schema.json, kept once here; bundle.test.ts
// derives its cases from the schema file so the two cannot drift silently.
const TAG_MAX = 200;
const WHEN_MAX = 500;

function checkShape(s: Snapshot): void {
  const fail = (what: string) => {
    throw new Error(`writeBundle: snapshot ${JSON.stringify(s.name)} has ${what}`);
  };
  // Lengths are code points, as JSON Schema (Ajv, Python jsonschema) counts them.
  const text = (field: string, v: unknown, max: number, noSlash: boolean) => {
    if (typeof v !== "string") return fail(`${field} that is not a string`);
    const n = [...v].length;
    if (n < 1 || n > max) fail(`${field} of ${n} characters, outside 1..${max}`);
    if (noSlash && v.includes("/")) fail(`${field} containing "/"`);
  };
  text("name", s.name, TAG_MAX, true);
  if (s.category !== undefined) text("category", s.category, TAG_MAX, true);
  if (s.spec !== undefined) text("spec", s.spec, TAG_MAX, true);
  if (s.when !== undefined) text("when", s.when, WHEN_MAX, false);
  for (const side of ["width", "height"] as const) {
    const v = s.viewport[side];
    if (!Number.isInteger(v) || v < 1) fail(`viewport.${side} ${JSON.stringify(v)}, not an integer >= 1`);
  }
}
