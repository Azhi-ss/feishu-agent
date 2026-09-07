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
import { acquireRemoteLock, clearHandoffRequest, describeHolder, hasHandoffRequest, readRemoteLock, releaseRemoteLock, requestRemoteHandover, waitForRemoteLockRelease } from "./remote-lock.js";
import { shardText, StreamCardSession, visibleAssistantText } from "./stream-card.js";

type RemoteStatus = "off" | "standby" | "connecting" | "connected" | "error";
const REMOTE_STATUS_KEY = "feishu-3-remote";

const MISSING_SECRET = `Remote bridge needs an app secret: set ${REMOTE_SECRET_ENV} to the existing bot app's secret (view it in the Feishu developer console — do not reset it), then run /remote start.`;

interface QueuedMessage {
  chatId: string;
  text: string;
}

interface ActiveCard {
  open: Promise<StreamCardSession | undefined>;
}

function toolStatusLine(toolName: string): string {
  return `\u{1F6E0}\uFE0F Running ${toolName}`;
}

/** Latest tool-call name in an assistant message content (the tool signal that reaches extensions during a streamed turn), if any. */
function assistantToolName(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "toolCall") {
      const name = (part as { name?: unknown }).name;
      if (typeof name === "string" && name) return name;
    }
  }
  return undefined;
}

function isAbortWord(text: string): boolean {
  const command = text.trim().toLowerCase();
  return command === "stop" || command === "abort" || command === "/stop" || command === "/abort";
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
    let pendingGateway: RemoteGateway | undefined;
    let generation = 0;
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
    let lockedAppId: string | undefined;
    let standbyHolder: string | undefined;
    const dedup = new MessageDedup();
    let handoffTimer: NodeJS.Timeout | undefined;

    // /remote switch from another window: the requester writes a yield file
    // (no signals — SIGUSR2 interrupts the TUI raw-mode stdin read). While this
    // window holds the bridge it polls for that file and stops gracefully.
    function startHandoffWatch(): void {
      if (handoffTimer || !lockedAppId) return;
      const appId = lockedAppId;
      handoffTimer = setInterval(() => {
        const home = process.env.HOME ?? "";
        if (appId !== lockedAppId || !(gateway || pendingGateway)) return;
        if (!hasHandoffRequest(home, appId)) return;
        clearHandoffRequest(home, appId);
        // Stop quietly from the timer (not a slash-command response): no TUI
        // notify — a prompt opened outside a command turn could eat the next
        // keystrokes. The requester window prints its own handover progress;
        // this window signals the handoff via the status line moving to off.
        void stop(latestCtx).catch(() => { /* handover is best-effort */ });
      }, 250);
      handoffTimer.unref();
    }

    function stopHandoffWatch(): void {
      if (handoffTimer) { clearInterval(handoffTimer); handoffTimer = undefined; }
    }

    function isStaleRunner(error: unknown): boolean {
      return error instanceof Error && error.message.includes("stale after session");
    }

    function dropLock(): void {
      if (!lockedAppId) return;
      releaseRemoteLock(process.env.HOME ?? "", lockedAppId);
      lockedAppId = undefined;
    }

    function enterStandby(ctx: ExtensionContext | undefined, error: string): void {
      // Keep the status strip short: the lock error already names the holder as
      // "(pid 12345 in project)"; reuse that as the standby label.
      const label = error.match(/\((pid \d+[^)]*)\)/)?.[1] ?? "held by another window";
      standbyHolder = label;
      setState("standby", ctx, `standby (held by ${label})`);
    }

    function paint(ctx: ExtensionContext | undefined): void {
      try {
        if (ctx?.mode !== "tui") return;
        const ui = ctx.ui as { setStatus?: (key: string, text: string | undefined) => void; theme?: { fg(color: string, text: string): string } };
        if (!ui.setStatus) return;
        const color = status === "connected" ? "success" : status === "error" ? "warning" : "muted";
        const label = `│ → remote:${status}`;
        ui.setStatus(REMOTE_STATUS_KEY, process.env.NO_COLOR ? label : ui.theme?.fg?.(color, label) ?? label);
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
      const card: ActiveCard = { open: Promise.resolve(undefined) };
      card.open = gw.openStreamCard(chatId).then(
        (cardId) => {
          const session = new StreamCardSession(
            cardId,
            {
              append: (id, text, sequence, uuid) => gw.appendStreamText(id, text, sequence, uuid),
              setStatus: (id, text) => gw.setStatusLine(id, text),
              closeCard: (id, text) => gw.closeStreamCard(id, text),
            },
            (error) => {
              if (reportedCardError) return;
              reportedCardError = true;
              notify(latestCtx, `Remote bridge card write failed (the final reply is still delivered): ${error instanceof Error ? error.message : String(error)}`, "warning");
            },
          );
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
        if (isStaleRunner(error)) {
          acknowledge(next.chatId, "Remote bridge: this session was replaced. Run /remote start again.");
          void stop();
          return;
        }
        setState("error", latestCtx, `Remote bridge could not start the turn: ${error instanceof Error ? error.message : String(error)}`);
        notify(latestCtx, lastError!, "error");
        return;
      }
      activeCard = beginCard(next.chatId);
    }

    function acknowledge(chatId: string, text: string): void {
      void gateway?.sendMessage(chatId, text).catch(() => { /* acknowledgements are best-effort */ });
    }

    function abortCurrentTurn(chatId: string): void {
      acknowledge(chatId, "Remote bridge: stop requested; the current turn will be interrupted.");
      latestCtx?.abort();
    }

    function deliver(next: QueuedMessage): void {
      if (isAbortWord(next.text)) {
        if (busy()) abortCurrentTurn(next.chatId);
        else acknowledge(next.chatId, "Remote bridge: no turn is running.");
        return;
      }
      if (busy()) {
        queue.push(next);
        acknowledge(next.chatId, `Remote bridge: queued (position ${queue.length}). Send stop to interrupt the current turn.`);
        return;
      }
      submit(next);
    }

    function unsupportedMessageType(messageType: string): string {
      return `Remote bridge: unsupported ${messageType || "message type"} messages in v1. Send text instead.`;
    }

    function onInbound(event: RemoteInboundEvent): void {
      if (!credentials || !authorizeInbound(event, credentials.ownerOpenId)) return;
      if (!dedup.claim(event.messageId)) return;
      if (event.messageType !== "text") {
        acknowledge(event.chatId, unsupportedMessageType(event.messageType));
        return;
      }
      deliver({ chatId: event.chatId, text: event.text });
    }

    async function start(ctx: ExtensionContext, options: { quietIfHeld?: boolean } = {}): Promise<void> {
      if (gateway || pendingGateway) {
        notify(ctx, gateway ? "Remote bridge is already connected." : "Remote bridge is already connecting.");
        return;
      }
      const resolved = resolveRemoteCredentials(process.env.HOME ?? "");
      if ("error" in resolved) {
        setState("error", ctx, resolved.error);
        notify(ctx, resolved.error, "error");
        return;
      }
      credentials = resolved.credentials;
      const lock = acquireRemoteLock(process.env.HOME ?? "", credentials.appId);
      if (!lock.ok) {
        if (options.quietIfHeld) {
          enterStandby(ctx, lock.error);
          return;
        }
        setState("error", ctx, lock.error);
        notify(ctx, lock.error, "error");
        return;
      }      lockedAppId = credentials.appId;
      standbyHolder = undefined;
      startHandoffWatch();
      secret = process.env[REMOTE_SECRET_ENV];
      if (!secret) {
        dropLock();
        setState("error", ctx, MISSING_SECRET);
        notify(ctx, MISSING_SECRET, "error");
        return;
      }
      const created = createGatewayFromEnv(process.env, resolved.credentials);
      if ("error" in created) {
        dropLock();
        setState("error", ctx, created.error);
        notify(ctx, created.error, "error");
        return;
      }
      const epoch = generation;
      setState("connecting", ctx);
      reportedPollError = false;
      const candidate = created.gateway;
      pendingGateway = candidate;
      try {
        await candidate.start(onInbound, (error) => {
          if (generation !== epoch) return;
          if (reportedPollError) return; // warn once per outage; recovery re-arms the latch
          reportedPollError = true;
          setState("error", undefined, `Remote bridge lost the gateway connection: ${error.message}`);
          notify(latestCtx, `Remote bridge connection interrupted; reconnecting: ${error.message}`, "warning");
        }, () => {
          if (generation !== epoch) return;
          reportedPollError = false;
          setState("connected");
          notify(latestCtx, "Remote bridge reconnected.", "info");
        });
      } catch (error) {
        if (pendingGateway === candidate) pendingGateway = undefined;
        if (generation !== epoch) return;
        dropLock();
        setState("error", ctx, `Remote bridge could not connect: ${error instanceof Error ? error.message : String(error)}`);
        notify(ctx, lastError!, "error");
        return;
      }
      if (generation !== epoch || pendingGateway !== candidate) {
        if (pendingGateway === candidate) pendingGateway = undefined;
        await candidate.close().catch(() => {});
        if (generation !== epoch) return;
        dropLock();
        return;
      }
      pendingGateway = undefined;
      gateway = candidate;
      transport = created.transport;
      setState("connected", ctx);
      notify(ctx, `Remote bridge connected (transport ${transport}, app ${credentials.appId}).`);
      startHandoffWatch();
    }

    async function stop(paintCtx?: ExtensionContext): Promise<void> {
      generation += 1;
      const candidate = gateway ?? pendingGateway;
      const card = activeCard;
      gateway = undefined;
      pendingGateway = undefined;
      stopHandoffWatch();
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
      dropLock();
      // No paint on session_shutdown: the captured ctx is stale and the UI is going away.
      status = "off";
      if (paintCtx) paint(paintCtx);
    }

    pi.on("session_start", (_event, ctx) => {
      latestCtx = ctx;
      paint(ctx);
      if (ctx.mode === "tui" && process.env[REMOTE_AUTOSTART_ENV] === "1" && !gateway && !pendingGateway) void start(ctx, { quietIfHeld: true });
    });

    pi.on("session_shutdown", () => stop());

    pi.on("message_update", (event) => {
      const card = activeCard;
      if (!card) return;
      if ((event.message as { role?: string }).role !== "assistant") return;
      const content = (event.message as { content?: unknown }).content;
      const tool = assistantToolName(content);
      const text = visibleAssistantText(content);
      // Route through the open promise: updates/status that fire while the card-open
      // REST call is still in flight must not be dropped. Snapshots are cumulative
      // and StreamCardSession coalesces, so the resolved session catches up.
      void card.open.then((session) => {
        if (!session) return;
        if (text) session.setStatus(""); // the status strip clears when visible assistant text actually starts
        else if (tool) session.setStatus(toolStatusLine(tool)); // toolCall content part = a tool is running
        session.update(text);
      });
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

    async function switchBridge(ctx: ExtensionContext): Promise<void> {
      if (gateway || pendingGateway) {
        notify(ctx, "Remote bridge is already connected in this window.");
        return;
      }
      const resolved = resolveRemoteCredentials(process.env.HOME ?? "");
      if ("error" in resolved) {
        setState("error", ctx, resolved.error);
        notify(ctx, resolved.error, "error");
        return;
      }
      const appId = resolved.credentials.appId;
      if (!process.env[REMOTE_SECRET_ENV]) {
        setState("error", ctx, MISSING_SECRET);
        notify(ctx, MISSING_SECRET, "error");
        return;
      }
      const holder = readRemoteLock(process.env.HOME ?? "", appId);
      if (holder) {
        const signaled = requestRemoteHandover(process.env.HOME ?? "", appId);
        if (signaled) notify(ctx, `Remote bridge: asking ${describeHolder(holder)} to hand over…`);
        const released = await waitForRemoteLockRelease(process.env.HOME ?? "", appId, signaled ? 10_000 : 1_000);
        if (!released) {
          const error = signaled
            ? `Remote bridge handover timed out: ${describeHolder(holder)} did not release the lock. Stop it there first.`
            : "Remote bridge handover failed: the lock holder is not a reachable Feishu bridge. Stop it there first.";
          enterStandby(ctx, error);
          notify(ctx, error, "error");
          return;
        }
      }
      await start(ctx);
    }

    pi.registerCommand("remote", {
      description: "Manage the Feishu Remote Bridge (phone control of this session)",
      handler: async (args, ctx) => {
        latestCtx = ctx;
        switch (args.trim()) {
          case "start":
            await start(ctx);
            break;
          case "stop":
            if (!gateway && !pendingGateway && status !== "connecting") notify(ctx, "Remote bridge is not running.");
            else {
              await stop(ctx);
              notify(ctx, "Remote bridge stopped.");
            }
            break;
          case "switch":
            await switchBridge(ctx);
            break;
          default: // status
            if (status === "connected" && gateway) notify(ctx, `Remote bridge: connected (transport ${transport}, app ${credentials?.appId ?? "unknown"}).`);
            else if (status === "connecting") notify(ctx, "Remote bridge: connecting…");
            else if (status === "standby") notify(ctx, `Remote bridge: standby (held by ${standbyHolder ?? "another window"}). Run /remote switch to take over.`);
            else if (status === "error") notify(ctx, `Remote bridge: error — ${lastError ?? "run /remote start again."}`, "error");
            else notify(ctx, "Remote bridge: off — run /remote start to enable phone control.");
        }
      },
    });
  };
}
