import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, run, allFiles } from "./helpers/init-e2e-fixture.js";
import { hermeticEnv } from "./helpers/hermetic-env.js";

test("automation Skill is explicit-init-only, discoverable, missing-only, and preserves edited workspace instructions", async () => {
  const f = await fixture();
  const jobs = join(f.root, "jobs");
  const bin = join(f.root, "bin");
  const serviceLog = join(f.root, "service.log");
  const env = hermeticEnv({ HOME: f.home, PATH: f.env.PATH, PI_OFFLINE: "1", MEM0_API_KEY: f.secret, MEM0_API_HOST: f.env.MEM0_API_HOST,
    FEISHU_AUTOMATION_HOME: jobs, FEISHU_REMOTE: "0", FEISHU_UNATTENDED: "0" });
  for (const executable of ["systemctl", "launchctl"]) {
    writeFileSync(join(bin, executable), `#!/bin/sh\nprintf 'unexpected service call\\n' >> ${JSON.stringify(serviceLog)}\nexit 1\n`, { mode: 0o755 });
  }
  const skill = join(f.agentHome, "skills", "feishu-automation", "SKILL.md");
  try {
    const printed = await run(f.project, env, ["-p", "ping"]);
    assert.equal(printed.code, 0, printed.stderr);
    assert.equal(existsSync(skill), false, "ordinary startup must not install the Skill");
    assert.equal(existsSync(jobs), false);

    const initialized = await run(f.project, env, ["init", "--identity", "alice", "--model", "fake/fake-model"]);
    assert.equal(initialized.code, 0, initialized.stderr);
    assert.equal(existsSync(skill), true, "explicit init installs the private automation Skill");
    const original = readFileSync(skill, "utf8");
    assert.match(original, /^---\nname: feishu-automation\n/);
    assert.equal(existsSync(jobs), false, "init must not set up the scheduler workspace");
    assert.equal((await run(f.project, env, ["-p", "How do I schedule a Feishu task?"])).code, 0);
    assert.match(JSON.stringify(f.modelRequests.at(-1)), /feishu-automation[\s\S]*SKILL.md/);

    mkdirSync(jobs, { recursive: true });
    const standing = join(jobs, "AGENTS.md");
    writeFileSync(standing, "USER-EDITED-STANDING-INSTRUCTIONS\n");
    const edited = `${original}\nUSER-EDITED-AUTOMATION-SKILL\n`;
    writeFileSync(skill, edited);
    assert.equal((await run(f.project, env, ["init"])).code, 0);
    assert.equal(readFileSync(skill, "utf8"), edited);
    rmSync(skill);
    assert.equal((await run(f.project, env, ["-p", "ping"])).code, 0);
    assert.equal(existsSync(skill), false, "existing homes also get no startup installation");
    assert.equal((await run(f.project, env, ["init"])).code, 0);
    assert.equal(readFileSync(skill, "utf8"), original, "explicit rerun fills the missing Skill");
    assert.equal(readFileSync(standing, "utf8"), "USER-EDITED-STANDING-INSTRUCTIONS\n");
    assert.equal(existsSync(serviceLog), false, "init and Print never probe/install/start services");
    for (const root of [join(f.home, ".agents"), join(f.pi, "skills"), join(f.project, ".agents"), join(f.project, ".pi")]) assert.equal(existsSync(root), false);
    for (const path of allFiles(f.agentHome)) assert(!readFileSync(path, "utf8").includes(f.secret), path);
    assert(!(initialized.stdout + initialized.stderr + printed.stdout + printed.stderr).includes(f.secret));
  } finally { f.close(); }
});
