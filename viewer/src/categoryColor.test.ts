import { expect, test } from "vitest";
import { categoryColor } from "./categoryColor.js";

test("categoryColor is deterministic for the same name", () => {
  expect(categoryColor("Example Base")).toEqual(categoryColor("Example Base"));
});

test("categoryColor gives different names visibly different colors most of the time", () => {
  const names = ["Example Base", "App Shell", "Nav Bar", "Footer", "Sidebar", "Header"];
  const colors = new Set(names.map((n) => categoryColor(n).border));
  expect(colors.size).toBeGreaterThan(1);
});

test("categoryColor returns a full color triple (border/bg/dot)", () => {
  const color = categoryColor("Example Base");
  expect(color.border).toMatch(/^border-/);
  expect(color.bg).toMatch(/^bg-/);
  expect(color.dot).toMatch(/^bg-/);
});
