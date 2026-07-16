import { expect, test } from "vitest";
import { FORMAT_VERSION } from "./index.js";

test("exports the current snapshot format version", () => {
  expect(FORMAT_VERSION).toBe(0);
});
