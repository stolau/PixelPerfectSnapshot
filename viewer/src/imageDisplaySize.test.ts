import { afterEach, expect, test } from "vitest";
import { getImageSize, imageSizePx, setImageSize } from "./imageDisplaySize.js";

afterEach(() => {
  localStorage.clear();
});

test("getImageSize defaults to medium when nothing is stored", () => {
  expect(getImageSize()).toBe("medium");
});

test("setImageSize persists, and getImageSize reads it back", () => {
  setImageSize("large");
  expect(getImageSize()).toBe("large");
});

test("getImageSize falls back to medium on a corrupted/unknown stored value", () => {
  localStorage.setItem("pps_image_size", "huge");
  expect(getImageSize()).toBe("medium");
});

test("imageSizePx returns increasing pixel widths for small < medium < large", () => {
  expect(imageSizePx("small")).toBeLessThan(imageSizePx("medium"));
  expect(imageSizePx("medium")).toBeLessThan(imageSizePx("large"));
});
