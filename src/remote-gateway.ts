// The Feishu Remote Bridge transport port (ADR-0001): one narrow interface with
// two adapters. The production Feishu SDK WSClient adapter lands in a later
// ticket; this slice ships the loopback HTTP adapter used by tests, selected
// via environment injection (same pattern as the fake model server).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REMOTE_SECRET_ENV = "FEISHU_REMOTE_APP_SECRET";
export const REMOTE_AUTOSTART_ENV = "FEISHU_REMOTE";
export const REMOTE_LOOPBACK_ENV = "FEISHU_REMOTE_LOOPBACK_URL";

export interface RemoteInboundEvent {
  ownerOpenId: string;
  chatId: string;
  chatType: string;
  messageId: string;
  messageType: string;
  text: string;
}

export interface RemoteGateway {
  start(onEvent: (event: RemoteInboundEvent) => void, onPollError: (error: Error) => void): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  close(): Promise<void>;
}

export interface RemoteCredentials {
  appId: string;
  ownerOpenId: string;
}

/** Owner-only P2P gate: only the owner's 1-on-1 chat may drive the session. */
export function authorizeInbound(event: RemoteInboundEvent, ownerOpenId: string): boolean {
  return event.chatType === "p2p" && event.ownerOpenId === ownerOpenId;
}

/** In-memory seen-set keyed by message id, swept on insert when the TTL passes. */
export class MessageDedup {
  private readonly seen = new Map<string, number>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly now: () => number = Date.now) {}

  claim(messageId: string): boolean {
    const now = this.now();
    for (const [id, seenAt] of this.seen) if (now - seenAt > this.ttlMs) this.seen.delete(id);
    if (this.seen.has(messageId)) return false;
    this.seen.set(messageId, now);
    return true;
  }
}

interface LarkConfig {
  apps?: Array<{ appId?: string; brand?: string; users?: Array<{ userOpenId?: string }> }>;
}

/**
 * Resolve the bridge identity from the on-disk lark-cli config (zero network):
 * the existing bot app id and the owner open_id. The app secret is NOT here —
 * it lives in the keychain behind a {source:"keychain"} reference, so it is
 * supplied separately via REMOTE_SECRET_ENV.
 */
export function resolveRemoteCredentials(home: string, read: (path: string) => string | undefined = defaultRead): { credentials: RemoteCredentials } | { error: string } {
  const paths = [join(home, ".lark-cli", "config.json"), join(home, ".config", "lark-cli", "config.json")];
  for (const path of paths) {
    const raw = read(path);
    if (raw === undefined) continue;
    let config: LarkConfig;
    try {
      config = JSON.parse(raw) as LarkConfig;
    } catch {
      return { error: `Remote bridge cannot read the lark-cli config at ${path}: invalid JSON. Run \`lark-cli auth login\` to repair it.` };
    }
    const app = config.apps?.find((entry) => entry.brand === "feishu" || entry.brand === "lark") ?? config.apps?.[0];
    if (!app?.appId || !app.users?.[0]?.userOpenId) return { error: `Remote bridge found no usable lark-cli app identity in ${path}. Run \`lark-cli auth login\` first.` };
    return { credentials: { appId: app.appId, ownerOpenId: app.users[0].userOpenId } };
  }
  return { error: "Remote bridge found no lark-cli config (~/.lark-cli/config.json). Run `lark-cli auth login` first." };
}

function defaultRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function createGatewayFromEnv(env: NodeJS.ProcessEnv = process.env): { gateway: RemoteGateway; transport: string } | { error: string } {
  const loopback = env[REMOTE_LOOPBACK_ENV];
  if (loopback) return { gateway: new LoopbackGateway(loopback), transport: "loopback" };
  return { error: `Remote bridge has no transport configured: the production Feishu SDK adapter lands in a later release; set ${REMOTE_LOOPBACK_ENV} to use the loopback gateway.` };
}

/** HTTP long-poll adapter for the loopback fake Feishu server (tests only). */
export class LoopbackGateway implements RemoteGateway {
  private stopped = false;
  private controller: AbortController | undefined;

  constructor(private readonly baseUrl: string) {}

  async start(onEvent: (event: RemoteInboundEvent) => void, onPollError: (error: Error) => void): Promise<void> {
    this.stopped = false;
    await this.pollOnce(onEvent, onPollError);
    void this.pollLoop(onEvent, onPollError);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/send-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId, text }),
    });
    if (!response.ok) throw new Error(`loopback send failed: HTTP ${response.status}`);
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    try {
      await fetch(`${this.baseUrl}/disconnect`, { method: "POST" });
    } catch { /* teardown is best-effort */ }
  }

  private async pollOnce(onEvent: (event: RemoteInboundEvent) => void, onPollError: (error: Error) => void): Promise<void> {
    try {
      for (const event of await this.fetchEvents()) onEvent(event);
    } catch (error) {
      if (this.stopped) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      onPollError(failure);
      throw failure;
    }
  }

  private async pollLoop(onEvent: (event: RemoteInboundEvent) => void, onPollError: (error: Error) => void): Promise<void> {
    while (!this.stopped) {
      try {
        for (const event of await this.fetchEvents()) onEvent(event);
      } catch (error) {
        if (this.stopped) return;
        onPollError(error instanceof Error ? error : new Error(String(error)));
        await new Promise((done) => setTimeout(done, 1000));
      }
    }
  }

  private async fetchEvents(): Promise<RemoteInboundEvent[]> {
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await fetch(`${this.baseUrl}/events`, { signal: controller.signal });
      if (!response.ok) throw new Error(`loopback events failed: HTTP ${response.status}`);
      return (await response.json()) as RemoteInboundEvent[];
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
}
