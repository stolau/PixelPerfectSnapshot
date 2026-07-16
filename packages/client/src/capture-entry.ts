import { captureSnapshot } from "./capture.js";

window.__ppsCapture = (doc, name) => captureSnapshot(doc, name);
