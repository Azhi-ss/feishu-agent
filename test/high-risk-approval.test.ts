import assert from "node:assert/strict";
import test from "node:test";
import { approveHighRisk, authorizeHighRisk } from "../src/high-risk.js";

test("High-risk Approval is exact and one-shot", () => {
  const approval = approveHighRisk("delete", "doc-1", "user", "one document");
  authorizeHighRisk(approval, { action: "delete", target: "doc-1", identity: "user", scope: "one document" });
  assert.throws(() => authorizeHighRisk(approval, { action: "delete", target: "doc-1", identity: "user", scope: "one document" }), /required/);
  const fresh = approveHighRisk("delete", "doc-1", "user", "one document");
  assert.throws(() => authorizeHighRisk(fresh, { action: "delete", target: "doc-2", identity: "user", scope: "one document" }), /does not exactly match/);
  assert.throws(() => approveHighRisk("delete", "", "user", "one document"), /requires exact/);
});
