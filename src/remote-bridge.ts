// Feishu Remote Bridge: mirrors the ACTIVE interactive Feishu Runtime to the
// owner's 1-on-1 Feishu chat. Inert by default — activation is explicit via
// /remote start or FEISHU_REMOTE=1, so the offline-startup invariant holds.
// Inbound owner text is injected with pi.sendUserMessage; turn ownership is an
// active-turn flag plus a FIFO follow-up queue drained one item per turn end
// (which structurally avoids Pi's "agent already processing" error). Each
// phone-triggered turn opens ONE Feishu streaming card; assistant text streams
// into it in coalesced segments and the card is finalized with the complete
// reply (sharded when over-long). Reasoning/thinking text never reaches the card.
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  authorizeInbound,
  createGatewayFromEnv,
  MessageDedup,
  REMOTE_AUTOSTART_ENV,
  REMOTE_SECRET_ENV,
  resolveRemoteCredentials,
  type RemoteCredentials,
  type RemoteGateway,
  type RemoteInboundEvent,
} from "./remote-gateway.js";
import { shardText, StreamCardSession, visibleAssistantText } from "./stream-card.js";
import { setRemoteStatus, type RemoteStatus } from "./tui-status.js";

const MISSING_SECRET = `Remote bridge needs an app secret: set ${REMOTE_SECRET_ENV} to the existing bot app's secret (view it in the Feishu developer console — do not reset it), then run /remote start.`;

interface QueuedMessage {
  chatId: string;
  text: string;
}

interface ActiveCard {
  session: StreamCardSession | undefined;
  open: Promise<StreamCardSession | undefined>;
}

function lastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string | undefined {
  const last = [...messages].reverse().find((message) => message.role === "assistant");
  if (!last) return undefined;
  const text = visibleAssistantText(last.content);
  return text || undefined;
}

export function remoteBridgeExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    let gateway: RemoteGateway | undefined;
    let transport: string | undefined;
    let status: RemoteStatus = "off";
    let credentials: RemoteCredentials | undefined;
    let secret: string | undefined; // in memory only; dropped on stop
    let activeTurn: { chatId: string } | undefined;
    let activeCard: ActiveCard | undefined;
    const queue: QueuedMessage[] = [];
    let latestCtx: ExtensionContext | undefined;
    let lastError: string | undefined;
    let reportedPollError = false;
    let reportedCardError = false;
    const dedup = new MessageDedup();

    function paint(ctx: ExtensionContext | undefined): void {
      try {
        if (ctx?.mode === "tui") setRemoteStatus(ctx, status);
      } catch { /* stale ctx during shutdown */ }
    }

    function notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error" = "info"): void {
      try {
        if (ctx?.mode === "tui") ctx.ui.notify(message, type);
      } catch { /* stale ctx during shutdown */ }
    }

    function setState(next: RemoteStatus, ctx?: ExtensionContext | undefined, error?: string): void {
      status = next;
      if (error) lastError = error;
      paint(ctx ?? latestCtx);
    }

    function busy(): boolean {
      return activeTurn !== undefined || !(latestCtx?.isIdle() ?? true);
    }

    function beginCard(chatId: string): ActiveCard | undefined {
      const gw = gateway;
      if (!gw) return undefined;
      const card: ActiveCard = { session: undefined, open: Promise.resolve(undefined) };
      card.open = gw.openStreamCard(chatId).then(
        (cardId) => {
          const session = new StreamCardSession(
            cardId,
            {
              append: (id, text, sequence, uuid) => gw.appendStreamText(id, text, sequence, uuid),
              closeCard: (id, text) => gw.closeStreamCard(id, text),
            },
            (error) => {
              if (reportedCardError) return;
              reportedCardError = true;
              notify(latestCtx, `Remote bridge card write failed (the final reply is still delivered): ${error instanceof Error ? error.message : String(error)}`, "warning");
            },
          );
          card.session = session;
          return session;
        },
        (error) => {
          notify(latestCtx, `Remote bridge could not open the streaming card (the reply will arrive as a plain message): ${error instanceof Error ? error.message : String(error)}`, "warning");
          return undefined;
        },
      );
      return card;
    }

    function submit(next: QueuedMessage, deliverAs?: "followUp"): void {
      activeTurn = { chatId: next.chatId };
      try {
        pi.sendUserMessage(next.text, deliverAs ? { deliverAs } : undefined);
      } catch (error) {
        activeTurn = undefined;
        setState("error", latestCtx, `Remote bridge could not start the turn: ${error instanceof Error ? error.message : String(error)}`);
        notify(latestCtx, lastError!, "error");
        return;
      }
      activeCard = beginCard(next.chatId);
    }

    function deliver(next: QueuedMessage): void {
      if (busy()) {
        queue.push(next);
        return;
      }
      submit(next);
    }

    function onInbound(event: RemoteInboundEvent): void {
      if (!credentials || !authorizeInbound(event, credentials.ownerOpenId)) return;
      if (!dedup.claim(event.messageId)) return;
      if (event.messageType !== "text") return; // v1: text-only, handled gracefully in a later slice
      deliver({ chatId: event.chatId, text: event.text });
    }

    async function start(ctx: ExtensionContext): Promise<void> {
      if (gateway) {
        notify(ctx, "Remote bridge is already connected.");
        return;
      }
      const resolved = resolveRemoteCredentials(process.env.HOME ?? "");
      if ("error" in resolved) {
        setState("error", ctx, resolved.error);
        notify(ctx, resolved.error, "error");
        return;
      }
      credentials = resolved.credentials;
      secret = process.env[REMOTE_SECRET_ENV];
      if (!secret) {
        setState("error", ctx, MISSING_SECRET);
        notify(ctx, MISSING_SECRET, "error");
        return;
      }
      const created = createGatewayFromEnv();
      if ("error" in created) {
        setState("error", ctx, created.error);
        notify(ctx, created.error, "error");
        return;
      }
      setState("connecting", ctx);
      reportedPollError = false;
      const candidate = created.gateway;
      try {
        await candidate.start(onInbound, (error) => {
          if (reportedPollError) return;
          reportedPollError = true;
          setState("error", undefined, `Remote bridge lost the gateway connection: ${error.message}`);
          notify(latestCtx, lastError!, "warning");
        });
      } catch (error) {
        setState("error", ctx, `Remote bridge could not connect: ${error instanceof Error ? error.message : String(error)}`);
        notify(ctx, lastError!, "error");
        return;
      }
      gateway = candidate;
      transport = created.transport;
      setState("connected", ctx);
      notify(ctx, `Remote bridge connected (transport ${transport}, app ${credentials.appId}).`);
    }

    async function stop(paintCtx?: ExtensionContext): Promise<void> {
      const candidate = gateway;
      const card = activeCard;
      gateway = undefined;
      transport = undefined;
      activeTurn = undefined;
      activeCard = undefined;
      queue.length = 0;
      secret = undefined;
      reportedPollError = false;
      reportedCardError = false;
      // Close any in-flight streaming card before dropping the gateway so the
      // phone never watches a card hang in streaming mode.
      const session = await card?.open;
      if (session) await session.finalize("").catch(() => {});
      await candidate?.close();
      // No paint on session_shutdown: the captured ctx is stale and the UI is going away.
      status = "off";
      if (paintCtx) paint(paintCtx);
    }

    pi.on("session_start", (_event, ctx) => {
      latestCtx = ctx;
      paint(ctx);
      if (ctx.mode === "tui" && process.env[REMOTE_AUTOSTART_ENV] === "1" && !gateway) void start(ctx);
    });

    pi.on("session_shutdown", (_event) => {
      void stop();
    });

    pi.on("message_update", (event) => {
      const card = activeCard;
      if (!card?.session) return;
      if ((event.message as { role?: string }).role !== "assistant") return;
      card.session.update(visibleAssistantText((event.message as { content?: unknown }).content));
    });

    pi.on("agent_end", async (event) => {
      const turn = activeTurn;
      if (!turn) {
        const next = queue.shift();
        if (next) submit(next, "followUp");
        return;
      }
      activeTurn = undefined;
      const card = activeCard;
      activeCard = undefined;
      const reply = lastAssistantText(event.messages) ?? "";
      // Drain the queue BEFORE awaiting the outbound send so activeTurn is never
      // undefined while turns can still start: an inbound message arriving during
      // the card finalize would otherwise start an untracked turn and steal the next reply.
      const next = queue.shift();
      if (next) submit(next, "followUp");
      if (!card) return;
      const session = await card.open;
      if (!session) {
        // Card open failed: the plain-message path still delivers the answer.
        if (gateway && reply) await gateway.sendMessage(turn.chatId, reply).catch(() => { /* outbound failures never abort the turn */ });
        return;
      }
      const shards = shardText(reply);
      await session.finalize(shards[0]);
      const gw = gateway;
      for (const shard of shards.slice(1)) await gw?.sendMessage(turn.chatId, shard).catch(() => {});
    });

    pi.registerCommand("remote", {
      description: "Manage the Feishu Remote Bridge (phone control of this session)",
      handler: async (args, ctx) => {
        latestCtx = ctx;
        switch (args.trim()) {
          case "start":
            await start(ctx);
            break;
          case "stop":
            if (!gateway) notify(ctx, "Remote bridge is not running.");
            else {
              await stop(ctx);
              notify(ctx, "Remote bridge stopped.");
            }
            break;
          default: // status
            if (status === "connected" && gateway) notify(ctx, `Remote bridge: connected (transport ${transport}, app ${credentials?.appId ?? "unknown"}).`);
            else if (status === "connecting") notify(ctx, "Remote bridge: connecting…");
            else if (status === "error") notify(ctx, `Remote bridge: error — ${lastError ?? "run /remote start again."}`, "error");
            else notify(ctx, "Remote bridge: off — run /remote start to enable phone control.");
        }
      },
    });
  };
}
