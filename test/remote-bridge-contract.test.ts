import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { REMOTE_OUTBOUND_TIMEOUT_ENV, REMOTE_OUTBOUND_TIMEOUT_MS } from "../packages/feishu-remote/extensions/remote-gateway.js";

// SPEC §9.1 is the single source of truth for the Remote Bridge delivery contract;
// packages/feishu-remote/README.md and docs/remote-bridge.md restate parts of it in prose
// and are not guarded here. This is a phrase-presence guard: it catches a clause being
// deleted or reworded, not whether the text stays consistent with
// packages/feishu-remote/extensions/remote-bridge.ts — that half still needs a reader.
// Each clause is asserted inside its own bullet, so one bullet's wording cannot satisfy
// another bullet's check.
const spec = readFileSync(new URL("../../SPEC.md", import.meta.url), "utf8");
const section = spec.split(/^### 9\.1\. /m)[1]?.split(/^### /m)[0] ?? "";

function bullet(marker: string): string {
  const line = section.split("\n").find((candidate) => candidate.startsWith("- ") && candidate.includes(marker)) ?? "";
  assert.ok(line, `SPEC §9.1 must have a bullet about "${marker}"`);
  return line;
}

function requireAll(text: string, phrases: string[]): void {
  const lower = text.toLowerCase();
  for (const phrase of phrases) assert.ok(lower.includes(phrase.toLowerCase()), `SPEC §9.1 must state: "${phrase}"`);
}

test("SPEC §9.1 is present and scoped to the Feishu Remote Package", () => {
  assert.match(section, /Feishu Remote Package/, "SPEC §9.1 section heading/body not found");
});

test("SPEC §9.1: a failed card write falls back to one plain message with the complete reply", () => {
  requireAll(bullet("卡片投递收尾"), ["建卡", "追加", "关闭", "普通消息", "完整回复正文", "恰好一次", "重试一次", "不写空卡"]);
});

test("SPEC §9.1: stop, handoff, session replacement and shutdown keep the streamed body", () => {
  requireAll(bullet("停桥收尾"), ["/remote stop", "/remote switch", "/new", "/reload", "关停", "不擦除", "流式快照", "排队", "条数"]);
});

test("SPEC §9.1: one bounded outbound budget covers every outbound call", () => {
  requireAll(bullet("出站有界预算"), [
    "预算",
    "建卡",
    "追加",
    "关闭",
    "普通消息",
    "reaction",
    "不得写死毫秒",
    "settlement",
    "/quit",
    REMOTE_OUTBOUND_TIMEOUT_ENV,
    String(REMOTE_OUTBOUND_TIMEOUT_MS),
  ]);
});
