import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  authorizeInbound,
  createGatewayFromEnv,
  MessageDedup,
  REMOTE_LOOPBACK_ENV,
  resolveRemoteCredentials,
  type RemoteInboundEvent,
  type FeishuGatewaySdk,
  FeishuGateway,
  REMOTE_APP_ID_ENV,
  REMOTE_OWNER_OPEN_ID_ENV,
  REMOTE_OUTBOUND_TIMEOUT_ENV,
  REMOTE_OUTBOUND_TIMEOUT_MS,
  outboundTimeoutMs,
  REMOTE_HANDSHAKE_TIMEOUT_ENV,
  REMOTE_HANDSHAKE_TIMEOUT_MS,
  REMOTE_PROBE_TIMEOUT_ENV,
  REMOTE_PROBE_TIMEOUT_MS,
  handshakeTimeoutMs,
  probeTimeoutMs,
  withOutboundBudget,
  type RemoteGateway,
} from "../packages/feishu-remote/extensions/remote-gateway.js";
import { THINKING_STATUS } from "../packages/feishu-remote/extensions/stream-card.js";

function inbound(overrides: Partial<RemoteInboundEvent>): RemoteInboundEvent {
  return { ownerOpenId: "ou_owner", chatId: "oc_chat", chatType: "p2p", messageId: "msg-1", messageType: "text", text: "hi", ...overrides };
}

/** Run `body` under the handshake env override, restoring the previous value. */
async function withHandshakeBudget(ms: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env[REMOTE_HANDSHAKE_TIMEOUT_ENV];
  process.env[REMOTE_HANDSHAKE_TIMEOUT_ENV] = ms;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env[REMOTE_HANDSHAKE_TIMEOUT_ENV];
    else process.env[REMOTE_HANDSHAKE_TIMEOUT_ENV] = previous;
  }
}

test("authorizeInbound accepts owner P2P and explicitly mentioned group messages", () => {
  assert.equal(authorizeInbound(inbound({}), "ou_owner"), true);
  assert.equal(authorizeInbound(inbound({ ownerOpenId: "ou_intruder" }), "ou_owner"), false);
  assert.equal(authorizeInbound(inbound({ chatType: "group" }), "ou_owner"), false);
  assert.equal(authorizeInbound(inbound({ chatType: "group", mentionedBot: true }), "ou_owner"), true);
  assert.equal(authorizeInbound(inbound({ chatType: "p2p", ownerOpenId: "ou_owner" }), "ou_other-owner"), false);
});

test("MessageDedup claims a message id once and expires it after the TTL", () => {
  let now = 0;
  const dedup = new MessageDedup(10 * 60_000, () => now);
  assert.equal(dedup.claim("msg-1"), true);
  assert.equal(dedup.claim("msg-1"), false);
  assert.equal(dedup.claim("msg-2"), true);
  now = 11 * 60_000;
  assert.equal(dedup.claim("msg-1"), true, "expired ids are claimable again");
});

test("resolveRemoteCredentials reads app id and owner from the lark-cli config", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-remote-cred-"));
  const home = join(root, "home");
  const larkConfig = join(home, ".lark-cli", "config.json");
  mkdirSync(join(home, ".lark-cli"), { recursive: true });
  writeFileSync(larkConfig, JSON.stringify({ apps: [{ appId: "cli_fake", brand: "feishu", users: [{ userOpenId: "ou_fake_owner" }] }] }));
  const result = resolveRemoteCredentials(home);
  assert.ok("credentials" in result);
  assert.deepEqual(result.credentials, { appId: "cli_fake", ownerOpenId: "ou_fake_owner" });
});

test("resolveRemoteCredentials prefers the feishu/lark app in a multi-app config", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-remote-cred-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".lark-cli"), { recursive: true });
  writeFileSync(join(home, ".lark-cli", "config.json"), JSON.stringify({ apps: [
    { appId: "cli_other", brand: "slack", users: [{ userOpenId: "ou_other" }] },
    { appId: "cli_feishu", brand: "feishu", users: [{ userOpenId: "ou_owner" }] },
  ] }));
  const result = resolveRemoteCredentials(home);
  assert.ok("credentials" in result);
  assert.deepEqual(result.credentials, { appId: "cli_feishu", ownerOpenId: "ou_owner" });
});

test("resolveRemoteCredentials falls back to XDG path and reports actionable errors without dumping config", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-remote-cred-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "lark-cli"), { recursive: true });
  writeFileSync(join(home, ".config", "lark-cli", "config.json"), JSON.stringify({ apps: [{ appId: "cli_xdg", users: [{ userOpenId: "ou_xdg" }] }] }));
  const fallback = resolveRemoteCredentials(home);
  assert.ok("credentials" in fallback);
  assert.equal(fallback.credentials.appId, "cli_xdg");

  const missing = resolveRemoteCredentials(join(root, "no-home"));
  assert.ok("error" in missing);
  assert.match(missing.error, /lark-cli auth login/);
  assert.doesNotMatch(missing.error, /cli_xdg/);

  mkdirSync(join(home, ".lark-cli"), { recursive: true });
  writeFileSync(join(home, ".lark-cli", "config.json"), '{"apps":[{"appId":"SECRET-CONTENT-MUST-NOT-LEAK"}]}');
  const noUsers = resolveRemoteCredentials(home);
  assert.ok("error" in noUsers);
  assert.match(noUsers.error, /no usable lark-cli app identity/);
  assert.doesNotMatch(noUsers.error, /SECRET-CONTENT-MUST-NOT-LEAK/);
});

test("resolveRemoteCredentials uses env identity only when no lark-cli config exists", () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-remote-cred-"));
  const missingHome = join(root, "no-home");
  const fromEnv = resolveRemoteCredentials(missingHome, undefined, {
    [REMOTE_APP_ID_ENV]: "cli_env",
    [REMOTE_OWNER_OPEN_ID_ENV]: "ou_env",
  });
  assert.ok("credentials" in fromEnv);
  assert.deepEqual(fromEnv.credentials, { appId: "cli_env", ownerOpenId: "ou_env" });

  const home = join(root, "home");
  mkdirSync(join(home, ".lark-cli"), { recursive: true });
  writeFileSync(join(home, ".lark-cli", "config.json"), '{"apps":[{"appId":"SECRET-MUST-NOT-LEAK"}]}');
  const broken = resolveRemoteCredentials(home, undefined, {
    [REMOTE_APP_ID_ENV]: "cli_env",
    [REMOTE_OWNER_OPEN_ID_ENV]: "ou_env",
  });
  assert.ok("error" in broken);
  assert.match(broken.error, /no usable lark-cli app identity/);
  assert.doesNotMatch(broken.error, /SECRET-MUST-NOT-LEAK|cli_env/);
});

test("createGatewayFromEnv selects the loopback gateway only via env injection", () => {
  const created = createGatewayFromEnv({ [REMOTE_LOOPBACK_ENV]: "http://127.0.0.1:1" });
  assert.ok("gateway" in created);
  assert.equal(created.transport, "loopback");

  const missing = createGatewayFromEnv({});
  assert.ok("error" in missing);
  assert.match(missing.error, /credentials/);
});

test("createGatewayFromEnv selects the production gateway with credentials and secret", () => {
  const created = createGatewayFromEnv({ FEISHU_REMOTE_APP_SECRET: "secret-not-returned" }, { appId: "cli_app", ownerOpenId: "ou_owner" });
  assert.ok("gateway" in created);
  assert.equal(created.transport, "feishu-sdk");
});

test("the outbound budget is one shared default with an env override for tests", () => {
  assert.equal(REMOTE_OUTBOUND_TIMEOUT_MS, 15_000, "a 15s default, the same order as the WS handshake");
  assert.equal(outboundTimeoutMs({}), REMOTE_OUTBOUND_TIMEOUT_MS);
  assert.equal(outboundTimeoutMs({ [REMOTE_OUTBOUND_TIMEOUT_ENV]: "250" }), 250);
  for (const invalid of ["0", "-5", "abc", "1.5", ""]) {
    assert.equal(outboundTimeoutMs({ [REMOTE_OUTBOUND_TIMEOUT_ENV]: invalid }), REMOTE_OUTBOUND_TIMEOUT_MS, `"${invalid}" must fall back to the shared default`);
  }
});

test("the WS handshake budget is one shared default with an env override for tests", () => {
  assert.equal(REMOTE_HANDSHAKE_TIMEOUT_MS, 45_000, "a 45s default shared by the outer wait and the SDK: above the 16.4-23.6s handshake measured on a real device");
  assert.equal(handshakeTimeoutMs({}), REMOTE_HANDSHAKE_TIMEOUT_MS);
  assert.equal(handshakeTimeoutMs({ [REMOTE_HANDSHAKE_TIMEOUT_ENV]: "60000" }), 60_000, "the override can raise the budget past the default");
  for (const invalid of ["0", "-5", "abc", "1.5", ""]) {
    assert.equal(handshakeTimeoutMs({ [REMOTE_HANDSHAKE_TIMEOUT_ENV]: invalid }), REMOTE_HANDSHAKE_TIMEOUT_MS, `"${invalid}" must fall back to the shared default`);
  }
});

test("the reachability probe budget is one shared default with an env override for tests", () => {
  assert.equal(REMOTE_PROBE_TIMEOUT_MS, 5_000, "a 5s default: dead-path detection must not wait for the 45s handshake budget");
  assert.equal(probeTimeoutMs({}), REMOTE_PROBE_TIMEOUT_MS);
  assert.equal(probeTimeoutMs({ [REMOTE_PROBE_TIMEOUT_ENV]: "250" }), 250);
  for (const invalid of ["0", "-5", "abc", "1.5", ""]) {
    assert.equal(probeTimeoutMs({ [REMOTE_PROBE_TIMEOUT_ENV]: invalid }), REMOTE_PROBE_TIMEOUT_MS, `"${invalid}" must fall back to the shared default`);
  }
});

test("a dead network path fails start() in the probe budget without waiting for the handshake or opening a WS", async () => {
  let wsCreated = false;
  const sdk: FeishuGatewaySdk = {
    probe: async (host, port, timeoutMs) => {
      await new Promise((done) => setTimeout(done, 5));
      throw new Error(`Remote bridge cannot reach ${host}:${port} within ${timeoutMs}ms: check the network or proxy, then run /remote start again.`);
    },
    createClient: () => ({}) as never,
    createDispatcher: () => ({ register: () => undefined }),
    createWsClient: () => {
      wsCreated = true;
      return { start: async () => { /* would hang on a dead path */ }, close: () => undefined };
    },
  };
  const gateway = new FeishuGateway({ appId: "cli_app", ownerOpenId: "ou_owner", brand: "feishu" }, "secret-must-stay-in-memory", sdk, 45_000, 150);
  const started = Date.now();
  await assert.rejects(gateway.start(() => undefined, () => undefined), (error: Error) => {
    assert.match(error.message, /cannot reach open\.feishu\.cn:443 within 150ms/, "the error must name the host and the probe budget");
    assert.match(error.message, /run \/remote start again/, "the error must say what to do next");
    assert.doesNotMatch(error.message, /secret-must-stay-in-memory/);
    return true;
  });
  assert.ok(Date.now() - started < 45_000, "a dead path must not cost the whole handshake budget");
  assert.equal(wsCreated, false, "no WebSocket may be opened once the probe failed");
});

test("the probe targets the WS host of the configured brand", async () => {
  const probed: string[] = [];
  const makeSdk = (): FeishuGatewaySdk => ({
    probe: async (host) => { probed.push(host); },
    createClient: () => ({}) as never,
    createDispatcher: () => ({ register: () => undefined }),
    createWsClient: (options) => ({ start: async () => { options.onReady(); }, close: () => undefined }),
  });
  await new FeishuGateway({ appId: "cli_app", ownerOpenId: "ou_owner", brand: "feishu" }, "secret-must-stay-in-memory", makeSdk()).start(() => undefined, () => undefined);
  await new FeishuGateway({ appId: "cli_app", ownerOpenId: "ou_owner", brand: "lark" }, "secret-must-stay-in-memory", makeSdk()).start(() => undefined, () => undefined);
  assert.deepEqual(probed, ["open.feishu.cn", "open.larksuite.com"]);
});

test("withOutboundBudget turns a hung outbound call into a failure at the budget", async () => {
  const never = () => new Promise<never>(() => {});
  const stalled: RemoteGateway = {
    start: async () => {},
    sendMessage: never,
    addReaction: never,
    openStreamCard: never,
    setStatusLine: never,
    appendStreamText: never,
    closeStreamCard: never,
    close: async () => {},
  };
  const bounded = withOutboundBudget(stalled, 50);
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["message send", () => bounded.sendMessage("oc_chat", "hi")],
    ["reaction add", () => bounded.addReaction("om_1", "PARTY")],
    ["card open", () => bounded.openStreamCard("oc_chat")],
    ["card status write", () => bounded.setStatusLine("card-1", "working")],
    ["card append", () => bounded.appendStreamText("card-1", "text", 1, "uuid-1")],
    ["card close", () => bounded.closeStreamCard("card-1", "final")],
  ];
  for (const [label, call] of calls) {
    await assert.rejects(call(), new RegExp(`Remote bridge ${label} timed out after 50ms`), `${label} must reject at the budget`);
  }
});

test("createGatewayFromEnv bounds the loopback transport with the env-configured budget", async () => {
  // A server that accepts the request and never answers: only the client-side
  // budget can end the call, so this is red before the fix.
  const server = createServer(() => { /* hung on purpose */ });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    const created = createGatewayFromEnv({ [REMOTE_LOOPBACK_ENV]: `http://127.0.0.1:${address.port}`, [REMOTE_OUTBOUND_TIMEOUT_ENV]: "100" });
    assert.ok("gateway" in created);
    await assert.rejects(created.gateway.sendMessage("oc_chat", "hi"), /Remote bridge message send timed out after 100ms/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("FeishuGateway maps WS events and Card Kit operations without exposing the secret", async () => {
  const calls: Array<{ operation: string; payload?: unknown }> = [];
  let receivedSecret = "";
  let handlers: Record<string, (event: unknown) => unknown> = {};
  let wsOptions: { appId: string; appSecret: string; domain: "feishu" | "lark"; onReconnecting: () => void; onReconnected: () => void } | undefined;
  const client = {
    request: async <T = unknown>() => ({ bot: { open_id: "ou_bot" } } as T),
    im: { v1: { message: {
      create: async (payload: unknown) => {
        calls.push({ operation: "send", payload });
        return { code: 0, data: { message_id: "om_card-message" } };
      },
      get: async () => { throw new Error("unexpected parent fetch"); },
      }, messageReaction: { create: async (payload: unknown) => { calls.push({ operation: "reaction", payload }); return { code: 0 }; } } } },
    cardkit: {
      v1: {
        card: {
          create: async (payload: unknown) => {
            calls.push({ operation: "card-create", payload });
            return { code: 0, data: { card_id: "card-1" } };
          },
          settings: async (payload: unknown) => {
            calls.push({ operation: "card-settings", payload });
            return { code: 0 };
          },
        },
        cardElement: {
          content: async (payload: unknown) => {
            calls.push({ operation: "card-content", payload });
            return { code: 0 };
          },
        },
      },
    },
  };
  const sdk: FeishuGatewaySdk = {
    probe: async () => undefined,
    createClient: (params) => {
      receivedSecret = params.appSecret;
      calls.push({ operation: "client" });
      return client;
    },
    createDispatcher: () => ({ register: (registered) => {
      handlers = registered;
      return undefined;
    } }),
    createWsClient: (options) => {
      wsOptions = options;
      return {
        start: async () => { options.onReady(); },
        close: () => calls.push({ operation: "ws-close" }),
      };
    },
  };
  const gateway = new FeishuGateway({ appId: "cli_app", ownerOpenId: "ou_owner", brand: "lark" }, "secret-must-stay-in-memory", sdk);
  const received: RemoteInboundEvent[] = [];
  const errors: Error[] = [];
  const recovered: true[] = [];

  await gateway.start((event) => received.push(event), (error) => errors.push(error), () => recovered.push(true));
  assert.equal(wsOptions?.domain, "lark");
  assert.equal(wsOptions?.appSecret, "secret-must-stay-in-memory");
  await handlers["im.message.receive_v1"]?.({
    sender: { sender_id: { open_id: "ou_owner" } },
    message: { message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "hello from phone" }) },
  });
  assert.deepEqual(received, [{ ownerOpenId: "ou_owner", chatId: "oc_1", chatType: "p2p", messageId: "om_1", messageType: "text", text: "hello from phone" }]);
  await handlers["im.message.receive_v1"]?.({
    sender: { sender_id: { open_id: "ou_group_member" } },
    message: { message_id: "om_group", chat_id: "oc_group", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@feishu-agent 请回复" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] },
  });
  assert.deepEqual(received[1], { ownerOpenId: "ou_group_member", chatId: "oc_group", chatType: "group", mentionedBot: true, messageId: "om_group", messageType: "text", text: "@feishu-agent 请回复" });
  await handlers["im.message.receive_v1"]?.({
    sender: { sender_id: { open_id: "ou_group_member" } },
    message: { message_id: "om_other_mention", chat_id: "oc_group", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "@someone 请回复" }), mentions: [{ key: "@_user_2", id: { open_id: "ou_other" } }] },
  });
  assert.equal(received[2]?.mentionedBot, false);

  await gateway.addReaction("om_1", "PARTY");
  assert.deepEqual(calls[1]?.payload, { path: { message_id: "om_1" }, data: { reaction_type: { emoji_type: "PARTY" } } });
  await gateway.sendMessage("oc_1", "plain reply");
  const cardId = await gateway.openStreamCard("oc_1");
  const cardCreate = calls.find((call) => call.operation === "card-create")?.payload as { data?: { data?: string } } | undefined;
  const initialCard = JSON.parse(cardCreate?.data?.data ?? "{}") as { config?: { summary?: { content?: string } }; body?: { elements?: Array<{ element_id?: string; content?: string }> } };
  assert.equal(initialCard.config?.summary?.content, THINKING_STATUS);
  assert.equal(initialCard.body?.elements?.find((element) => element.element_id === "stream_md")?.content, THINKING_STATUS);
  await gateway.setStatusLine(cardId, "🛠️ Running bash");
  await gateway.appendStreamText(cardId, "partial reply", 1, "uuid-1");
  await gateway.closeStreamCard(cardId, "complete reply");
  assert.equal(receivedSecret, "secret-must-stay-in-memory");
  assert.deepEqual(calls.map(({ operation }) => operation), ["client", "reaction", "send", "card-create", "send", "card-content", "card-content", "card-content", "card-settings"]);
  wsOptions?.onReconnecting();
  wsOptions?.onReconnected();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /reconnect/i);
  assert.deepEqual(recovered, [true]);
  await gateway.close();
  assert.equal(calls.at(-1)?.operation, "ws-close");
});

test("FeishuGateway quotes the message a text reply points at", async () => {
  const fetched: string[] = [];
  const long = "y".repeat(2500);
  const parents: Record<string, () => Promise<{ code: number; data: { items: Array<{ msg_type: string; body: { content: string } }> } }>> = {
    om_digest: async () => ({
      code: 0,
      data: { items: [{ msg_type: "post", body: { content: JSON.stringify({ zh_cn: { title: "日报", content: [[{ tag: "md", text: "第一篇：主动学习\n第二篇：知识图谱" }]] } }) } }] },
    }),
    om_long: async () => ({
      code: 0,
      data: { items: [{ msg_type: "post", body: { content: JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: long }]] } }) } }] },
    }),
    om_card: async () => ({
      code: 0,
      data: { items: [{ msg_type: "interactive", body: { content: "{\"card\":true}" } }] },
    }),
    om_fail: async () => { throw new Error("lookup failed secret-must-stay-in-memory"); },
  };
  let handlers: Record<string, (event: unknown) => unknown> = {};
  const sdk: FeishuGatewaySdk = {
    probe: async () => undefined,
    createClient: () => ({
      request: async <T = unknown>() => ({ bot: { open_id: "ou_bot" } } as T),
      im: { v1: { message: {
        create: async () => ({ code: 0, data: { message_id: "om_out" } }),
        get: async (payload: { path: { message_id: string } }) => {
          fetched.push(payload.path.message_id);
          return parents[payload.path.message_id]!();
        },
        }, messageReaction: { create: async () => ({ code: 0 }) } } },
      cardkit: { v1: { card: { create: async () => ({ code: 0 }), settings: async () => ({ code: 0 }) }, cardElement: { content: async () => ({ code: 0 }) } } },
    }),
    createDispatcher: () => ({ register: (registered) => { handlers = registered; } }),
    createWsClient: (options) => ({ start: async () => { options.onReady(); }, close: () => undefined }),
  };
  const gateway = new FeishuGateway({ appId: "cli_app", ownerOpenId: "ou_owner" }, "secret-must-stay-in-memory", sdk);
  const received: RemoteInboundEvent[] = [];
  await gateway.start((event) => received.push(event), () => undefined);
  const inbound = (messageId: string, text: string, parentId?: string) => handlers["im.message.receive_v1"]?.({
    sender: { sender_id: { open_id: "ou_owner" } },
    message: { message_id: messageId, chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }), parent_id: parentId },
  });

  await inbound("om_reply_digest", "存第二篇", "om_digest");
  await inbound("om_reply_long", "再看看", "om_long");
  await inbound("om_reply_card", "停", "om_card");
  await inbound("om_reply_fail", "继续", "om_fail");
  await inbound("om_plain", "普通消息");

  assert.equal(received[0]?.text, "[replying to]\n日报\n第一篇：主动学习\n第二篇：知识图谱\n\n存第二篇");
  assert.match(received[1]?.text ?? "", /^\[replying to]\ny{2000}…\n\n再看看$/);
  assert.equal(received[2]?.text, "停");
  assert.equal(received[3]?.text, "继续");
  assert.equal(received[4]?.text, "普通消息");
  assert.deepEqual(fetched, ["om_digest", "om_long", "om_card", "om_fail"]);
  assert.equal(received.some((event) => event.text.includes("secret-must-stay-in-memory")), false);
  await gateway.close();
});

test("FeishuGateway rejects a hard initial WS failure without leaking the secret", async () => {
  const sdk: FeishuGatewaySdk = {
    probe: async () => undefined,
    createClient: () => ({}) as never,
    createDispatcher: () => ({ register: () => undefined }),
    createWsClient: (options) => ({
      start: async () => { options.onError(new Error("connect failed: secret-must-stay-in-memory")); },
      close: () => undefined,
    }),
  };
  const gateway = new FeishuGateway({ appId: "cli_app", ownerOpenId: "ou_owner", brand: "feishu" }, "secret-must-stay-in-memory", sdk);
  await assert.rejects(gateway.start(() => undefined, () => undefined), (error: Error) => {
    assert.match(error.message, /connect failed/);
    assert.doesNotMatch(error.message, /secret-must-stay-in-memory/);
    return true;
  });
});

test("FeishuGateway close aborts an in-flight handshake so start() does not hang", async () => {
  const previous = process.env[REMOTE_HANDSHAKE_TIMEOUT_ENV];
  delete process.env[REMOTE_HANDSHAKE_TIMEOUT_ENV];
  let wsOptions: { handshakeTimeoutMs: number } | undefined;
  const sdk: FeishuGatewaySdk = {
    probe: async () => undefined,
    createClient: () => ({}) as never,
    createDispatcher: () => ({ register: () => undefined }),
    createWsClient: (options) => {
      wsOptions = options;
      return {
        start: async () => { /* stay connecting until close() */ },
        close: () => undefined,
      };
    },
  };
  let gateway: FeishuGateway | undefined;
  try {
    gateway = new FeishuGateway({ appId: "cli_app", ownerOpenId: "ou_owner", brand: "feishu" }, "secret-must-stay-in-memory", sdk);
    const started = gateway.start(() => undefined, () => undefined);
    started.catch(() => undefined); // asserted below; a failed assertion must not also surface as an unhandled rejection
    await new Promise((done) => setImmediate(done)); // let the reachability probe settle before the WS client exists
    assert.equal(wsOptions?.handshakeTimeoutMs, REMOTE_HANDSHAKE_TIMEOUT_MS, "without an override the SDK budget is the shared default");
    await gateway.close();
    await assert.rejects(started, /Remote gateway closed/);
  } finally {
    await gateway?.close();
    if (previous === undefined) delete process.env[REMOTE_HANDSHAKE_TIMEOUT_ENV];
    else process.env[REMOTE_HANDSHAKE_TIMEOUT_ENV] = previous;
  }
});

test("FeishuGateway takes the WS handshake budget from the env override, not the default literal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let wsOptions: { handshakeTimeoutMs: number } | undefined;
  const sdk: FeishuGatewaySdk = {
    probe: async () => undefined,
    createClient: () => ({}) as never,
    createDispatcher: () => ({ register: () => undefined }),
    createWsClient: (options) => {
      wsOptions = options;
      return { start: async () => { /* never becomes ready */ }, close: () => undefined };
    },
  };
  await withHandshakeBudget("150", async () => {
    const gateway = new FeishuGateway({ appId: "cli_app", ownerOpenId: "ou_owner", brand: "feishu" }, "secret-must-stay-in-memory", sdk);
    const started = gateway.start(() => undefined, () => undefined);
    const rejection = assert.rejects(started, /Feishu WebSocket handshake timed out/, "a never-completing handshake must keep the existing actionable error");
    rejection.catch(() => undefined); // only awaited below; a failed assertion must not also surface as an unhandled rejection
    try {
      await new Promise((done) => setImmediate(done)); // let the reachability probe settle before the WS client exists
      assert.equal(wsOptions?.handshakeTimeoutMs, 150, "the SDK handshake budget must come from the shared override, not a default literal");
      t.mock.timers.tick(150);
      await rejection;
    } finally {
      await gateway.close();
    }
  });
});

test("a handshake slower than the default succeeds when the override raises the budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let wsOptions: { handshakeTimeoutMs: number } | undefined;
  const sdk: FeishuGatewaySdk = {
    probe: async () => undefined,
    createClient: () => ({}) as never,
    createDispatcher: () => ({ register: () => undefined }),
    createWsClient: (options) => {
      wsOptions = options;
      return {
        start: async () => { await new Promise((done) => setTimeout(done, 50_000)); options.onReady(); },
        close: () => undefined,
      };
    },
  };
  await withHandshakeBudget("60000", async () => {
    const gateway = new FeishuGateway({ appId: "cli_app", ownerOpenId: "ou_owner", brand: "feishu" }, "secret-must-stay-in-memory", sdk);
    const started = gateway.start(() => undefined, () => undefined);
    started.catch(() => undefined); // only awaited below; a failed assertion must not also surface as an unhandled rejection
    try {
      await new Promise((done) => setImmediate(done)); // let the reachability probe settle before the WS client exists
      assert.equal(wsOptions?.handshakeTimeoutMs, 60_000, "the SDK handshake budget must follow the override past the 45s default");
      t.mock.timers.tick(50_000);
      await started;
    } finally {
      await gateway.close();
    }
  });
});

test("loopback gateway polls events, sends messages, and closes with a recorded disconnect", async () => {
  const state = { pending: [] as RemoteInboundEvent[], waiters: [] as Array<(events: RemoteInboundEvent[]) => void>, sends: [] as Array<{ chatId: string; text: string }>, closes: 0, polls: 0 };
  const server = createServer((request, response) => {
    if (request.url === "/events") {
      state.polls++;
      const flush = (events: RemoteInboundEvent[]) => {
        if (response.writableEnded) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(events));
      };
      if (state.pending.length) return flush(state.pending.splice(0));
      const waiter = (events: RemoteInboundEvent[]) => flush(events);
      state.waiters.push(waiter);
      setTimeout(() => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) state.waiters.splice(index, 1);
        flush([]);
      }, 2000).unref();
      return;
    }
    let body = "";
    request.on("data", (chunk) => body += chunk);
    request.on("end", () => {
      if (request.url === "/send-message") { state.sends.push(JSON.parse(body)); response.writeHead(200).end(); }
      else if (request.url === "/disconnect") { state.closes++; response.writeHead(200).end(); }
      else response.writeHead(404).end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;

  const created = createGatewayFromEnv({ [REMOTE_LOOPBACK_ENV]: url });
  assert.ok("gateway" in created);
  const gateway = created.gateway;
  const received: RemoteInboundEvent[] = [];
  const pollErrors: Error[] = [];
  await gateway.start((event) => received.push(event), (error) => pollErrors.push(error));
  assert(state.polls >= 1, "gateway polls the loopback event endpoint");

  state.pending.push(inbound({ messageId: "m-1", text: "phone hello" }));
  for (const waiter of state.waiters.splice(0)) waiter([]);
  for (let attempt = 0; attempt < 20 && !received.length; attempt++) await new Promise((done) => setTimeout(done, 50));
  assert.deepEqual(received.map((event) => event.text), ["phone hello"]);

  await gateway.sendMessage("oc_chat", "plain reply");
  assert.deepEqual(state.sends, [{ chatId: "oc_chat", text: "plain reply" }]);

  const pollsBeforeClose = state.polls;
  await gateway.close();
  assert.equal(state.closes, 1);
  await new Promise((done) => setTimeout(done, 300));
  assert(state.polls <= pollsBeforeClose + 1, "no polling continues after close");
  assert.equal(pollErrors.length, 0);

  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});
