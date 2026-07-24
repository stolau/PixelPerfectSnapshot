import { beforeEach, vi } from "vitest";

// jsdom doesn't implement URL.createObjectURL/revokeObjectURL. AuthenticatedImage relies on
// both, so stub them here for every test file rather than duplicating the stub per-file.
beforeEach(() => {
  let counter = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock-${++counter}`);
  URL.revokeObjectURL = vi.fn();
});
