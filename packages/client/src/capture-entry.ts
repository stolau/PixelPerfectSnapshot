import { captureSnapshot } from "./capture.js";

window.__ppsCapture = (doc, name, options) => captureSnapshot(doc, name, options);
