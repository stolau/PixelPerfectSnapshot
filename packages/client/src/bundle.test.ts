import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, expect, test } from "vitest";
import { writeBundle } from "./bundle.js";
import type { Snapshot } from "./index.js";
import { assertZip32, MAX_ZIP32, zip } from "./zip.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const bundleSchemaPath = fileURLToPath(new URL("../../../docs/bundle.schema.json", import.meta.url));
const snapshotSchemaPath = fileURLToPath(new URL("../../../docs/snapshot.schema.json", import.meta.url));

const tmp = mkdtempSync(path.join(tmpdir(), "pps-bundle-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function snap(name: string, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    formatVersion: 0,
    name,
    ...extra,
    viewport: { width: 800, height: 600 },
    html: `<!DOCTYPE html><html><body><p>${name}</p></body></html>`,
    stylesheets: [{ href: "http://example.test/a.css", content: "p{color:red}" }],
  };
}

const SNAPSHOTS: Snapshot[] = [
  snap("tagged", { category: "app-shell", spec: "pps-checkout", when: "cart has two items" }),
  snap("spec-only", { spec: "pps-login" }),
  snap("bare"),
];

/**
 * A zip reader of the test's own, independent of zip.ts: walks the central
 * directory from the end record, checks each local header against it,
 * inflates every entry and checks node's zlib.crc32 against the stored CRC.
 */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.length - 22;
  expect(buf.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = buf.readUInt16LE(eocd + 10);
  expect(buf.readUInt16LE(eocd + 8)).toBe(count);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  expect(cdOffset + cdSize).toBe(eocd);

  const out = new Map<string, Buffer>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    expect(buf.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(buf.readUInt32LE(localOffset + 14)).toBe(crc);
    expect(buf.readUInt32LE(localOffset + 18)).toBe(csize);
    expect(buf.readUInt32LE(localOffset + 22)).toBe(usize);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    expect(buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString("utf8")).toBe(name);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + csize);
    expect(method).toBe(8);
    const data = inflateRawSync(raw);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
  }
  expect(p).toBe(eocd);
  return out;
}

test("writeBundle round-trips through an independent reader", async () => {
  const file = path.join(tmp, "roundtrip.zip");
  await writeBundle(SNAPSHOTS, file);
  const entries = readZip(readFileSync(file));

  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validateManifest = ajv.compile(JSON.parse(readFileSync(bundleSchemaPath, "utf8")));
  expect(validateManifest(manifest), JSON.stringify(validateManifest.errors)).toBe(true);
  const validateSnapshot = ajv.compile(JSON.parse(readFileSync(snapshotSchemaPath, "utf8")));

  expect(manifest.bundleVersion).toBe(0);
  expect(manifest.producer).toBe("client");
  expect(manifest.run).toBeNull();
  expect(manifest.snapshots).toHaveLength(3);
  for (const s of manifest.snapshots) expect(s.status).toBeNull();
  expect(manifest.snapshots[0]).toMatchObject({
    name: "tagged",
    viewport: { width: 800, height: 600 },
    category: "app-shell",
    spec: "pps-checkout",
    when: "cart has two items",
  });
  expect(manifest.snapshots[1]).toMatchObject({ name: "spec-only", category: null, spec: "pps-login", when: null });
  expect(manifest.snapshots[2]).toMatchObject({ name: "bare", category: null, spec: null, when: null });

  manifest.snapshots.forEach((entry: { files: { snapshot: string } }, i: number) => {
    const doc = JSON.parse(entries.get(entry.files.snapshot)!.toString("utf8"));
    expect(doc).toEqual(SNAPSHOTS[i]);
    expect(validateSnapshot(doc), JSON.stringify(validateSnapshot.errors)).toBe(true);
  });
});

test("manifest resolves files only through files.*", async () => {
  const file = path.join(tmp, "files.zip");
  await writeBundle(SNAPSHOTS, file);
  const entries = readZip(readFileSync(file));
  const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));

  expect(manifest.snapshots.map((s: { name: string }) => s.name)).toEqual(SNAPSHOTS.map((s) => s.name));
  const paths = manifest.snapshots.map((s: { files: Record<string, string> }) => {
    expect(Object.keys(s.files)).toEqual(["snapshot"]);
    expect(entries.has(s.files.snapshot)).toBe(true);
    return s.files.snapshot;
  });
  expect(new Set(paths).size).toBe(SNAPSHOTS.length);
  for (const [i, p] of paths.entries()) {
    expect(p).not.toContain(SNAPSHOTS[i].name);
    // The producer's ordinal is the 1-based input position (docs/BUNDLE_FORMAT.md);
    // a consumer still must not derive it, which is what files.* is for.
    expect(Number(p.split("/")[1])).toBe(i + 1);
  }
  expect([...entries.keys()].sort()).toEqual(["manifest.json", ...paths].sort());
});

test("writeBundle refuses duplicate names and when without spec", async () => {
  const dup = path.join(tmp, "dup.zip");
  await expect(writeBundle([snap("ok"), snap("a"), snap("a")], dup)).rejects.toThrow(/duplicate/);
  expect(existsSync(dup)).toBe(false);

  const noSpec = path.join(tmp, "nospec.zip");
  await expect(writeBundle([snap("ok"), snap("b", { when: "open" })], noSpec)).rejects.toThrow(/when without spec/);
  expect(existsSync(noSpec)).toBe(false);
});

test("zip refuses more than 65535 entries", () => {
  const tiny = Buffer.from("x");
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `e${i}`, data: tiny }));
  expect(() => zip(make(65536))).toThrow(/65536 entries exceeds the zip32 limit of 65535/);
  const ok = zip(make(65535));
  expect(ok.readUInt16LE(ok.length - 22 + 10)).toBe(65535);

  expect(() => assertZip32(MAX_ZIP32 + 1, "size")).toThrow(/4 GiB/);
  expect(() => assertZip32(MAX_ZIP32, "size")).not.toThrow();
}, 60_000);

test("the ./bundle subpath resolves to the built node bundle", async () => {
  // A non-literal specifier: tsc cannot resolve a package's import of itself
  // through its own exports map (TS2209), so the types entry is checked below.
  const specifier: string = "pixelperfectsnapshot/bundle";
  const mod = await import(specifier);
  expect(typeof mod.writeBundle).toBe("function");
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  expect(existsSync(path.join(pkgDir, pkg.exports["./bundle"].types))).toBe(true);
  const index = readFileSync(path.join(pkgDir, "dist", "index.js"), "utf8");
  expect(index).not.toContain("node:zlib");
  expect(index).not.toContain("node:fs");
});
