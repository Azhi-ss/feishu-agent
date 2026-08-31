import assert from "node:assert/strict";
import test from "node:test";
import { memoryWarning, redactSecrets } from "../src/memory-degradation.js";

test("memory degradation is visible without leaking API keys", () => {
  process.env.MEM0_API_KEY = "sentinel-memory-secret";
  assert.equal(redactSecrets("failed sentinel-memory-secret"), "failed [REDACTED]");
  for (const feature of ["load", "health", "recall", "capture", "dream"] as const) {
    const warning = memoryWarning(feature, new Error("failed sentinel-memory-secret"));
    assert.match(warning, /Long-term Memory .* unavailable for this session/);
    assert.doesNotMatch(warning, /sentinel-memory-secret/);
  }
});
