import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  // Browser bundles injected into pages by tests and the render engine.
  { entry: "src/rehydrate-entry.ts", outfile: "dist/rehydrate.js", format: "iife" },
  { entry: "src/capture-entry.ts", outfile: "dist/capture.js", format: "iife" },
  // The iife bundles above overwrite tsc's dist/capture.js and
  // dist/rehydrate.js, so the library entry is rebundled self-contained
  // (tsc still emits the .d.ts files, including dist/index.d.ts).
  { entry: "src/index.ts", outfile: "dist/index.js", format: "esm" },
];

for (const { entry, outfile, format } of targets) {
  await build({
    entryPoints: [path.join(pkgDir, entry)],
    outfile: path.join(pkgDir, outfile),
    bundle: true,
    format,
    target: "es2020",
  });
}
