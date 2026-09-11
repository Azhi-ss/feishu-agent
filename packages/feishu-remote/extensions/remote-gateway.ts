// The Feishu Remote Bridge transport port (ADR-0001): one narrow interface with
// loopback and production adapters. The production adapter only creates SDK
// clients when the bridge is explicitly started.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";

export const REMOTE_SECRET_ENV = "FEISHU_REMOTE_APP_SECRET";
export const REMOTE_AUTOSTART_ENV = "FEISHU_REMOTE";
export const REMOTE_LOOPBACK_ENV = "FEISHU_REMOTE_LOOPBACK_URL";
export const REMOTE_APP_ID_ENV = "FEISHU_REMOTE_APP_ID";
export const REMOTE_OWNER_OPEN_ID_ENV = "FEISHU_REMOTE_OWNER_OPEN_ID";

export interface RemoteInboundEvent {
  ownerOpenId: string;
  chatId: string;
  chatType: string;
  messageId: string;
  messageType: string;
  text: string;
}

export interface RemoteGateway {
  start(onEvent: (event: RemoteInboundEvent) => void, onPollError: (error: Error) => void, onPollRecovered?: () => void): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  /** Open a streaming card in the chat; resolves with the card id. */
  openStreamCard(chatId: string): Promise<string>;
  /** Update the card's transient status area; text is empty to clear it. */
  setStatusLine(cardId: string, text: string): Promise<void>;
  /** Append a complete-content snapshot. sequence is monotonic per card; uuid unique per write. */
  appendStreamText(cardId: string, text: string, sequence: number, uuid: string): Promise<void>;
  /** Finalize the card with the complete reply (one envelope; the bridge shards over-long finals). */
  closeStreamCard(cardId: string, finalText: string): Promise<void>;
  close(): Promise<void>;
}

export interface RemoteCredentials {
  appId: string;
  ownerOpenId: string;
  brand?: "feishu" | "lark";
}

interface FeishuResponse<T = unknown> {
  code?: number;
  msg?: string;
  data?: T;
}

interface FeishuClient {
  im: { v1: { message: { create(payload: unknown): Promise<FeishuResponse<{ message_id?: string }>> } } };
  cardkit: {
    v1: {
      card: {
        create(payload: unknown): Promise<FeishuResponse<{ card_id?: string }>>;
        settings(payload: unknown): Promise<FeishuResponse>;
      };
      cardElement: { content(payload: unknown): Promise<FeishuResponse> };
    };
  };
}

interface FeishuDispatcher {
  register(handlers: Record<string, (event: unknown) => unknown>): unknown;
}

interface FeishuWsClient {
  start(params: { eventDispatcher: FeishuDispatcher }): Promise<void>;
  close(params?: { force?: boolean }): void;
}

/** Small SDK factory seam: unit tests can exercise the adapter without Feishu or credentials. */
export interface FeishuGatewaySdk {
  createClient(params: { appId: string; appSecret: string; domain: "feishu" | "lark" }): FeishuClient;
  createDispatcher(): FeishuDispatcher;
  createWsClient(options: {
    appId: string;
    appSecret: string;
    domain: "feishu" | "lark";
    autoReconnect: boolean;
    handshakeTimeoutMs: number;
    onReady: () => void;
    onError: (error: Error) => void;
    onReconnecting: () => void;
    onReconnected: () => void;
  }): FeishuWsClient;
}

export class FeishuGateway implements RemoteGateway {
  private readonly sequences = new Map<string, number>();
  private clientCache: FeishuClient | undefined;
  private ws: FeishuWsClient | undefined;
  #appSecret: string | undefined;
  private closed = false;
  private abortHandshake: ((error: Error) => void) | undefined;

  constructor(
    private readonly credentials: RemoteCredentials,
    appSecret: string,
    private readonly sdk: FeishuGatewaySdk = loadFeishuGatewaySdk(),
  ) {
    this.#appSecret = appSecret;
  }

  async start(onEvent: (event: RemoteInboundEvent) => void, onPollError: (error: Error) => void, onPollRecovered?: () => void): Promise<void> {
    const appSecret = this.requireSecret();
    this.closed = false;
    const dispatcher = this.sdk.createDispatcher();
    dispatcher.register({
      "im.message.receive_v1": (raw) => {
        const event = raw as {
          sender?: { sender_id?: { open_id?: string } };
          message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string };
        };
        const message = event.message;
        if (!message?.message_id || !message.chat_id || !message.chat_type || !message.message_type) return;
        onEvent({
          ownerOpenId: event.sender?.sender_id?.open_id ?? "",
          chatId: message.chat_id,
          chatType: message.chat_type,
          messageId: message.message_id,
          messageType: message.message_type,
          text: message.message_type === "text" ? parseTextContent(message.content) : "",
        });
      },
    });

    const domain = this.credentials.brand === "lark" ? "lark" : "feishu";
    let ready = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ws: FeishuWsClient | undefined;
    const finish = (resolve: () => void, reject: (error: Error) => void, error?: Error) => {
      if (settled) return;
      settled = true;
      this.abortHandshake = undefined;
      if (timer) clearTimeout(timer);
      if (error) reject(error); else resolve();
    };

    const handshake = new Promise<void>((resolve, reject) => {
      this.abortHandshake = (error) => finish(resolve, reject, error);
      timer = setTimeout(() => {
        this.closed = true;
        ws?.close({ force: true });
        finish(resolve, reject, new Error("Feishu WebSocket handshake timed out"));
      }, 15_000);
      try {
        ws = this.sdk.createWsClient({
          appId: this.credentials.appId,
          appSecret,
          domain,
          autoReconnect: true,
          handshakeTimeoutMs: 15_000,
          onReady: () => {
            ready = true;
            finish(resolve, reject);
          },
          onError: (error) => {
            const safe = safeGatewayError(error, appSecret);
            if (!ready && !this.closed) finish(resolve, reject, safe);
            else if (!this.closed) onPollError(safe);
          },
          onReconnecting: () => {
            if (ready && !this.closed) onPollError(new Error("Feishu WebSocket reconnecting"));
          },
          onReconnected: () => {
            if (!this.closed) onPollRecovered?.();
          },
        });
        this.ws = ws;
        void ws.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
          const safe = safeGatewayError(error, appSecret);
          if (!ready && !this.closed) finish(resolve, reject, safe);
          else if (!this.closed) onPollError(safe);
        });
      } catch (error) {
        finish(resolve, reject, safeGatewayError(error, appSecret));
      }
    });

    try {
      await handshake;
    } catch (error) {
      if (this.ws === ws) this.ws = undefined;
      ws?.close({ force: true });
      this.#appSecret = undefined;
      throw safeGatewayError(error, appSecret);
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const appSecret = this.requireSecret();
    try {
      const response = await this.client().im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
      });
      ensureSuccess(response, "Feishu message send");
    } catch (error) {
      throw safeGatewayError(error, appSecret);
    }
  }

  async openStreamCard(chatId: string): Promise<string> {
    const appSecret = this.requireSecret();
    try {
      const client = this.client();
      const response = await client.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(streamingCard()) } });
      ensureSuccess(response, "Feishu Card Kit card creation");
      const cardId = response.data?.card_id;
      if (!cardId) throw new Error("Feishu Card Kit did not return a card id");
      const sent = await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }) },
      });
      ensureSuccess(sent, "Feishu streaming card send");
      return cardId;
    } catch (error) {
      throw safeGatewayError(error, appSecret);
    }
  }

  async setStatusLine(cardId: string, text: string): Promise<void> {
    const appSecret = this.requireSecret();
    try {
      const sequence = this.nextSequence(cardId);
      const response = await this.client().cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: "stream_status" },
        data: { content: text, sequence, uuid: `status_${cardId}_${sequence}` },
      });
      ensureSuccess(response, "Feishu Card Kit status update");
    } catch (error) {
      throw safeGatewayError(error, appSecret);
    }
  }

  async appendStreamText(cardId: string, text: string, sequence: number, uuid: string): Promise<void> {
    const appSecret = this.requireSecret();
    try {
      const feishuSequence = this.nextSequence(cardId, sequence);
      const response = await this.client().cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: "stream_md" },
        data: { content: text, sequence: feishuSequence, uuid },
      });
      ensureSuccess(response, "Feishu Card Kit text update");
    } catch (error) {
      throw safeGatewayError(error, appSecret);
    }
  }

  async closeStreamCard(cardId: string, finalText: string): Promise<void> {
    const appSecret = this.requireSecret();
    try {
      const client = this.client();
      const contentSequence = this.nextSequence(cardId);
      const content = await client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: "stream_md" },
        data: { content: finalText, sequence: contentSequence, uuid: `final_${cardId}_${contentSequence}` },
      });
      ensureSuccess(content, "Feishu Card Kit final text update");
      const closeSequence = this.nextSequence(cardId);
      const settings = await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: finalText.replace(/\s+/g, " ").slice(0, 50) } } }),
          sequence: closeSequence,
          uuid: `close_${cardId}_${closeSequence}`,
        },
      });
      ensureSuccess(settings, "Feishu Card Kit card close");
    } catch (error) {
      throw safeGatewayError(error, appSecret);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const abort = this.abortHandshake;
    this.abortHandshake = undefined;
    abort?.(new Error("Remote gateway closed"));
    const ws = this.ws;
    this.ws = undefined;
    this.clientCache = undefined;
    this.sequences.clear();
    this.#appSecret = undefined;
    ws?.close({ force: true });
  }

  private nextSequence(cardId: string, requested = 0): number {
    const sequence = Math.max((this.sequences.get(cardId) ?? 0) + 1, requested);
    this.sequences.set(cardId, sequence);
    return sequence;
  }

  private requireSecret(): string {
    if (!this.#appSecret) throw new Error("Feishu Remote Gateway is closed");
    return this.#appSecret;
  }

  private client(): FeishuClient {
    const appSecret = this.requireSecret();
    const domain = this.credentials.brand === "lark" ? "lark" : "feishu";
    this.clientCache ??= this.sdk.createClient({ appId: this.credentials.appId, appSecret, domain });
    return this.clientCache;
  }
}

function ensureSuccess(response: FeishuResponse, operation: string): void {
  if (response.code !== undefined && response.code !== 0) throw new Error(`${operation} failed${response.msg ? `: ${response.msg}` : ` (code ${response.code})`}`);
}

function parseTextContent(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return content;
  }
}

function feishuErrorDetail(error: unknown): string | undefined {
  const body = (error as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
  if (!body || typeof body.code !== "number") return undefined;
  return body.msg ? `Feishu code ${body.code}: ${body.msg}` : `Feishu code ${body.code}`;
}

function safeGatewayError(error: unknown, appSecret?: string): Error {
  const detail = feishuErrorDetail(error);
  const base = error instanceof Error ? error.message : String(error);
  const message = detail ? `${detail} (HTTP ${(error as { response?: { status?: number } })?.response?.status ?? "?"})` : base;
  return new Error(appSecret ? message.split(appSecret).join("[credential]") : message);
}

function streamingCard(): object {
  return {
    schema: "2.0",
    config: { streaming_mode: true, summary: { content: "[Generating…]" }, streaming_config: { print_strategy: "fast" } },
    body: { elements: [
      { tag: "markdown", element_id: "stream_status", content: "" },
      { tag: "markdown", element_id: "stream_md", content: "" },
    ] },
  };
}

function loadFeishuGatewaySdk(): FeishuGatewaySdk {
  const quietLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  return {
    createClient: (params) => new lark.Client({
      appId: params.appId,
      appSecret: params.appSecret,
      domain: params.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
      logger: quietLogger,
      loggerLevel: lark.LoggerLevel.fatal,
      source: "feishu-remote",
    }) as unknown as FeishuClient,
    createDispatcher: () => new lark.EventDispatcher({ logger: quietLogger, loggerLevel: lark.LoggerLevel.fatal }) as unknown as FeishuDispatcher,
    createWsClient: (options) => new lark.WSClient({
      ...options,
      domain: options.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
      logger: quietLogger,
      loggerLevel: lark.LoggerLevel.fatal,
      source: "feishu-remote",
    }) as unknown as FeishuWsClient,
  };
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
  apps?: Array<{ appId?: string; brand?: "feishu" | "lark"; users?: Array<{ userOpenId?: string }> }>;
}

/**
 * Resolve the bridge identity from the on-disk lark-cli config (zero network):
 * the existing bot app id and the owner open_id. The app secret is NOT here —
 * it lives in the keychain behind a {source:"keychain"} reference, so it is
 * supplied separately via REMOTE_SECRET_ENV.
 */
export function resolveRemoteCredentials(home: string, read: (path: string) => string | undefined = defaultRead, env: NodeJS.ProcessEnv = process.env): { credentials: RemoteCredentials } | { error: string } {
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
    const credentials: RemoteCredentials = { appId: app.appId, ownerOpenId: app.users[0].userOpenId };
    if (app.brand === "lark") credentials.brand = "lark";
    return { credentials };
  }
  const appId = env[REMOTE_APP_ID_ENV];
  const ownerOpenId = env[REMOTE_OWNER_OPEN_ID_ENV];
  if (appId && ownerOpenId) return { credentials: { appId, ownerOpenId } };
  return { error: "Remote bridge found no lark-cli config (~/.lark-cli/config.json). Run `lark-cli auth login` first, or set FEISHU_REMOTE_APP_ID and FEISHU_REMOTE_OWNER_OPEN_ID." };
}

function defaultRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function createGatewayFromEnv(env: NodeJS.ProcessEnv = process.env, credentials?: RemoteCredentials): { gateway: RemoteGateway; transport: string } | { error: string } {
  const loopback = env[REMOTE_LOOPBACK_ENV];
  if (loopback) return { gateway: new LoopbackGateway(loopback), transport: "loopback" };
  if (!credentials) return { error: "Remote bridge cannot create the Feishu gateway without credentials." };
  const secret = env[REMOTE_SECRET_ENV];
  if (!secret) return { error: `Remote bridge needs ${REMOTE_SECRET_ENV} to use the Feishu SDK gateway.` };
  return { gateway: new FeishuGateway(credentials, secret), transport: "feishu-sdk" };
}

/** HTTP long-poll adapter for the loopback fake Feishu server (tests only). */
export class LoopbackGateway implements RemoteGateway {
  private stopped = false;
  private controller: AbortController | undefined;

  constructor(private readonly baseUrl: string) {}

  async start(onEvent: (event: RemoteInboundEvent) => void, onPollError: (error: Error) => void, onPollRecovered?: () => void): Promise<void> {
    this.stopped = false;
    // The FIRST poll is the connect handshake: a failure here throws to start()
    // (hard connect failure) and must NOT fire the reconnect error callback —
    // no retry loop is running yet. Only pollLoop reports transient errors.
    for (const event of await this.fetchEvents()) onEvent(event);
    void this.pollLoop(onEvent, onPollError, onPollRecovered);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.post("send-message", { chatId, text }, "loopback send failed");
  }

  async openStreamCard(chatId: string): Promise<string> {
    const response = await this.post("open-stream-card", { chatId }, "loopback card open failed");
    const data = (await response.json()) as { cardId?: string };
    if (!data.cardId) throw new Error("loopback card open failed: no card id");
    return data.cardId;
  }

  async setStatusLine(cardId: string, text: string): Promise<void> {
    await this.post("set-status-line", { cardId, text }, "loopback card status failed");
  }

  async appendStreamText(cardId: string, text: string, sequence: number, uuid: string): Promise<void> {
    await this.post("append-stream-text", { cardId, text, sequence, uuid }, "loopback card append failed");
  }

  async closeStreamCard(cardId: string, finalText: string): Promise<void> {
    await this.post("close-stream-card", { cardId, text: finalText }, "loopback card close failed");
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    try { await this.post("disconnect", {}, "loopback disconnect failed"); }
    catch { /* teardown is best-effort */ }
  }

  private async post(path: string, body: unknown, failure: string): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${failure}: HTTP ${response.status}`);
    return response;
  }

  private async pollLoop(onEvent: (event: RemoteInboundEvent) => void, onPollError: (error: Error) => void, onPollRecovered?: () => void): Promise<void> {
    let recovering = false;
    while (!this.stopped) {
      try {
        for (const event of await this.fetchEvents()) onEvent(event);
        if (recovering) {
          recovering = false;
          onPollRecovered?.();
        }
      } catch (error) {
        if (this.stopped) return;
        recovering = true;
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
