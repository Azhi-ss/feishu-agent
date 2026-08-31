import assert from "node:assert/strict";
import test from "node:test";
import { approveHighRisk, approvalFromExactRequest, authorizeHighRisk, authorizeLarkCommand } from "../src/high-risk.js";

test("High-risk Approval is exact and one-shot", () => {
  const approval = approveHighRisk("delete", "doc-1", "user", "one document");
  authorizeHighRisk(approval, { action: "delete", target: "doc-1", identity: "user", scope: "one document" });
  assert.throws(() => authorizeHighRisk(approval, { action: "delete", target: "doc-1", identity: "user", scope: "one document" }), /required/);
  const fresh = approveHighRisk("delete", "doc-1", "user", "one document");
  assert.throws(() => authorizeHighRisk(fresh, { action: "delete", target: "doc-2", identity: "user", scope: "one document" }), /does not exactly match/);
  assert.throws(() => approveHighRisk("delete", "", "user", "one document"), /requires exact/);
});

test("lark-cli --yes approval is derived from an exact natural request and consumed once", () => {
  const command = "lark-cli doc delete --id doc-1 --as user --scope one-document --yes";
  const approval = approvalFromExactRequest("delete doc-1 as user for one-document");
  authorizeLarkCommand(command, approval);
  assert.throws(() => authorizeLarkCommand(command, approval), /exact one-shot approval/);
  assert.throws(() => authorizeLarkCommand("lark-cli doc delete --id doc-2 --as user --scope one-document --yes", approvalFromExactRequest("delete doc-1 as user for one-document")), /required/);
  assert.throws(() => authorizeLarkCommand("lark-cli doc remove --id doc-1 --as user --scope one-document --yes", approvalFromExactRequest("delete doc-1 as user for one-document")), /required/);
  assert.throws(() => authorizeLarkCommand("lark-cli doc delete --id doc-1 --as bot --scope one-document --yes", approvalFromExactRequest("delete doc-1 as user for one-document")), /required/);
  assert.throws(() => authorizeLarkCommand("lark-cli doc delete --id doc-1 --as user --scope all-documents --yes", approvalFromExactRequest("delete doc-1 as user for one-document")), /required/);
  assert.throws(() => authorizeLarkCommand(`${command} && lark-cli doc delete --id doc-2 --as user --yes`, approvalFromExactRequest("delete doc-1 as user for one-document")), /required/);
  assert.throws(() => authorizeLarkCommand(command), /Print mode cannot prompt/);
  assert.equal(approvalFromExactRequest("delete the document"), undefined);
});
