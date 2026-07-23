import type { Snapshot } from "./index.js";

declare global {
  interface Window {
    /** Installed by dist/rehydrate.js. */
    __ppsRehydrate: (snapshot: Snapshot) => Promise<void>;
    /** Installed by dist/capture.js. */
    __ppsCapture: (
      doc: Document,
      name: string,
      options?: { blockSelectors?: string[] },
    ) => Promise<Snapshot>;
  }
}

export {};
