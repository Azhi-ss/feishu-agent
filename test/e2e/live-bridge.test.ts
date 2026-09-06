import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveRemoteCredentials } from "../../src/remote-gateway.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repoRoot, "dist/src/cli.js");

function resolveSecret(): string | undefined {
  if (process.env.FEISHU_REMOTE_APP_SECRET) return process.env.FEISHU_REMOTE_APP_SECRET;
  try {
    const bashrc = readFileSync(join(homedir(), ".bashrc"), "utf8");
    const match = bashrc.match(/export FEISHU_REMOTE_APP_SECRET="([^"]+)"/);
    if (match) return match[1];
  } catch {}
  return undefined;
}

function resolveBotChatId(): string {
  // Known P2P conversation between user and "曾宇的飞书 CLI" bot
  const fallbackChatId = "oc_9645dc5f61e71f332cae29999c2ad05b";
  try {
    const botOpenId = "ou_e5799f9cb19bdb8320caca9759b211b6";
    const res = execFileSync("lark-cli", [
      "im", "+chat-messages-list",
      "--user-id", botOpenId,
      "--as", "user",
      "--json",
      "--page-size", "1"
    ], { encoding: "utf8", timeout: 15_000 });
    const parsed = JSON.parse(res);
    const chatId = parsed.data?.messages?.[0]?.chat_id;
    if (chatId) return chatId;
  } catch {}
  return fallbackChatId;
}

function capturePane(session: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", session], { encoding: "utf8" });
  } catch {
    return "";
  }
}

function waitForPane(session: string, pattern: RegExp | string, timeoutMs = 25_000): string {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pane = capturePane(session);
    const matched = typeof pattern === "string" ? pane.includes(pattern) : pattern.test(pane);
    if (matched) return pane;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error(`Timeout waiting for [${pattern}] in tmux pane. Current content:\n${capturePane(session)}`);
}

function waitForIdle(session: string, timeoutMs = 35_000): string {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pane = capturePane(session);
    if (!pane.includes("Working...") && !pane.includes("Thinking...") && pane.includes("remote:connected")) {
      return pane;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return capturePane(session);
}

const secret = resolveSecret();
const creds = resolveRemoteCredentials(homedir());
const canRunLiveE2E = Boolean(secret && !("error" in creds) && existsSync(cliPath));

test("Live Remote Bridge E2E (Real Feishu Device/Bot Cutover)", { skip: !canRunLiveE2E ? "Skipped: FEISHU_REMOTE_APP_SECRET or lark-cli credentials not available" : false }, async (t) => {
  const sessionName = `feishu-live-e2e-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const chatId = resolveBotChatId();
  let firstCardMessageId = "";

  // Teardown guard: ensure tmux session is killed on test exit
  t.after(() => {
    try {
      execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
    } catch {}
  });

  await t.test("1. Startup in tmux with FEISHU_REMOTE=1 connects to real Feishu WebSocket", () => {
    execFileSync("tmux", [
      "new-session", "-d", "-s", sessionName,
      "-c", repoRoot,
      "-e", "FEISHU_REMOTE=1",
      "-e", `FEISHU_REMOTE_APP_SECRET=${secret}`,
      "-x", "120", "-y", "36",
      process.execPath, cliPath
    ]);

    // Wait for the status bar to show remote:connected
    const pane = waitForPane(sessionName, "remote:connected", 20_000);
    assert.match(pane, /remote:connected/, "Status bar must show remote:connected");
    assert.match(pane, /Remote bridge connected/, "Startup log must confirm bridge connection");
  });

  await t.test("2. Outbound message from user via lark-cli drives live session and returns Card Kit reply", () => {
    const nonce = `e2e-${Date.now()}`;
    const testPrompt = `E2E-PROBE-${nonce}: 快速测试，请只回复单个英文单词 PONG`;

    // Send message as user into the P2P chat with the bot
    const sendRes = execFileSync("lark-cli", [
      "im", "+messages-send",
      "--chat-id", chatId,
      "--text", testPrompt,
      "--as", "user",
      "--json"
    ], { encoding: "utf8", timeout: 15_000 });
    const sendJson = JSON.parse(sendRes);
    assert.equal(sendJson.ok, true, "lark-cli +messages-send must succeed");

    // Verify prompt appears in the tmux TUI
    const pane = waitForPane(sessionName, nonce, 25_000);
    assert.match(pane, new RegExp(nonce), "User prompt must arrive in tmux TUI");

    // Verify Feishu chat receives the bot's interactive card reply
    const startWait = Date.now();
    let gotInteractiveCard = false;
    while (Date.now() - startWait < 45_000) {
      try {
        const listRes = execFileSync("lark-cli", [
          "im", "+chat-messages-list",
          "--chat-id", chatId,
          "--as", "user",
          "--json",
          "--page-size", "5"
        ], { encoding: "utf8", timeout: 15_000 });
        const listJson = JSON.parse(listRes);
        const messages: Array<{ sender?: { sender_type?: string }; msg_type?: string; message_id?: string }> = listJson.data?.messages ?? [];
        const botCard = messages.find((m) => m.sender?.sender_type === "app" && m.msg_type === "interactive");
        if (botCard?.message_id) {
          gotInteractiveCard = true;
          firstCardMessageId = botCard.message_id;
          break;
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    // Wait until agent finishes the turn and returns to idle
    waitForIdle(sessionName);
    assert.equal(gotInteractiveCard, true, `Bot must reply with an interactive card message in chat ${chatId}`);
    assert.ok(firstCardMessageId.startsWith("om_"), `Card message ID must be valid: ${firstCardMessageId}`);
  });

  await t.test("3. Tool execution turn runs locally and delivers finalized card", () => {
    const nonce = `tool-${Date.now()}`;
    const testPrompt = `E2E-TOOL-${nonce}: 请只使用 bash 工具执行 echo E2E_TOOL_PASSED 并简短汇报`;

    const sendRes = execFileSync("lark-cli", [
      "im", "+messages-send",
      "--chat-id", chatId,
      "--text", testPrompt,
      "--as", "user",
      "--json"
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(JSON.parse(sendRes).ok, true);

    const pane = waitForPane(sessionName, nonce, 25_000);
    assert.match(pane, new RegExp(nonce));

    // Verify a new card reply arrives in chat (different from the first card)
    const startWait = Date.now();
    let gotReply = false;
    let toolCardMessageId = "";
    while (Date.now() - startWait < 45_000) {
      try {
        const listRes = execFileSync("lark-cli", [
          "im", "+chat-messages-list",
          "--chat-id", chatId,
          "--as", "user",
          "--json",
          "--page-size", "5"
        ], { encoding: "utf8", timeout: 15_000 });
        const listJson = JSON.parse(listRes);
        const messages: Array<{ sender?: { sender_type?: string }; msg_type?: string; message_id?: string }> = listJson.data?.messages ?? [];
        const botCard = messages.find((m) => m.sender?.sender_type === "app" && m.msg_type === "interactive" && m.message_id !== firstCardMessageId);
        if (botCard?.message_id) {
          gotReply = true;
          toolCardMessageId = botCard.message_id;
          break;
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    // Wait until agent finishes the tool turn and returns to idle
    waitForIdle(sessionName);
    assert.equal(gotReply, true, "Bot must deliver reply for tool turn");
    assert.ok(toolCardMessageId.startsWith("om_"));
  });

  await t.test("4. /remote stop disconnects the bridge and reflects in TUI", () => {
    waitForIdle(sessionName);
    // Send /remote stop in tmux TUI
    execFileSync("tmux", ["send-keys", "-t", sessionName, "/remote stop", "Enter"]);

    // Verify status transitions to remote:off
    const pane = waitForPane(sessionName, /remote:off|Remote bridge stopped/, 15_000);
    assert.match(pane, /remote:off|Remote bridge stopped/, "TUI must reflect stopped bridge");

    // Clean exit
    execFileSync("tmux", ["send-keys", "-t", sessionName, "/quit", "Enter"]);
  });
});
