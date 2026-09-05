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
} from "../src/remote-gateway.js";

function inbound(overrides: Partial<RemoteInboundEvent>): RemoteInboundEvent {
  return { ownerOpenId: "ou_owner", chatId: "oc_chat", chatType: "p2p", messageId: "msg-1", messageType: "text", text: "hi", ...overrides };
}

test("authorizeInbound accepts only owner P2P messages", () => {
  assert.equal(authorizeInbound(inbound({}), "ou_owner"), true);
  assert.equal(authorizeInbound(inbound({ ownerOpenId: "ou_intruder" }), "ou_owner"), false);
  assert.equal(authorizeInbound(inbound({ chatType: "group" }), "ou_owner"), false);
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

test("createGatewayFromEnv selects the loopback gateway only via env injection", () => {
  const created = createGatewayFromEnv({ [REMOTE_LOOPBACK_ENV]: "http://127.0.0.1:1" });
  assert.ok("gateway" in created);
  assert.equal(created.transport, "loopback");

  const missing = createGatewayFromEnv({});
  assert.ok("error" in missing);
  assert.match(missing.error, new RegExp(REMOTE_LOOPBACK_ENV));
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
