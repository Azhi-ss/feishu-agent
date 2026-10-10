import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  run,
  lines,
  fixture,
  configuredPackages,
  assertCompleteSummary,
} from "./helpers/init-e2e-fixture.js";

for (const failure of ["model", "doctor", "package", "skills"] as const) {
  test(`init rerun after injected ${failure} failure completes only missing persistent work`, async () => {
    const f = await fixture(failure);
    try {
      const first = await run(f.project, f.env, ["init", "--model", "fake/fake-model", "--thinking", "medium"]);
      assert.notEqual(first.code, 0, `${failure} failure was not injected`);
      assert.doesNotMatch(first.stdout + first.stderr, new RegExp(f.secret));
      if (failure === "model") f.writeModels(true);
      const systemBefore = readFileSync(join(f.agentHome, "SYSTEM.md"));
      const installsBefore = lines(f.npmLog).length;
      const syncsBefore = lines(f.larkLog).filter((line) => line.endsWith("|skills list --json")).length;

      const requestedModel = failure === "model" ? "fake/other-model" : "fake/fake-model";
      const second = await run(f.project, f.env, ["init", "--model", requestedModel, "--thinking", "high"]);
      assert.equal(second.code, 0, second.stderr);
      assertCompleteSummary(second.stdout, f.agentHome, requestedModel.slice(5));
      assert.deepEqual(readFileSync(join(f.agentHome, "SYSTEM.md")), systemBefore);
      assert.equal(existsSync(join(f.agentHome, "mem0-config.json")), false);
      assert.equal(configuredPackages(f.agentHome).filter((entry) => entry.includes("@mem0/")).length, 0);
      assert.equal(existsSync(join(f.project, ".pi")), false);
      assert.doesNotMatch(second.stdout + second.stderr, new RegExp(f.secret));

      const installsAfter = lines(f.npmLog).length;
      const syncsAfter = lines(f.larkLog).filter((line) => line.endsWith("|skills list --json")).length;
      if (failure === "skills") {
        assert.equal(installsBefore, 1, "the completed Remote install must survive Skill failure");
        assert.equal(installsAfter, 1, "Skill rerun must not reinstall packages");
        assert.equal(syncsBefore, 1); assert.equal(syncsAfter, 2);
      } else if (failure === "package") {
        assert.equal(installsBefore, 1); assert.equal(installsAfter, 2, "failed Remote install is the missing work");
        assert.equal(syncsBefore, 0); assert.equal(syncsAfter, 1);
      } else {
        assert.equal(installsBefore, 0); assert.equal(installsAfter, 1);
        assert.equal(syncsBefore, 0); assert.equal(syncsAfter, 1);
      }
    } finally { f.close(); }
  });
}
