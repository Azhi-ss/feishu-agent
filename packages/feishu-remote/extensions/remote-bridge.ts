// Feishu Remote Bridge: mirrors the ACTIVE interactive Feishu Runtime to the
// owner's 1-on-1 Feishu chat. Inert by default — activation is explicit via
// /remote start or FEISHU_REMOTE=1, so the offline-startup invariant holds.
// Inbound owner text is injected with pi.sendUserMessage; turn ownership is an
// active-turn flag plus a FIFO queue drained one item per settled run
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
import { fallbackReaction, parseReactionChoice, REACTION_PROMPT_FOR_MODEL, type ReactionChoice } from "./reaction-selector.js";
import { shardText, StreamCardSession, THINKING_STATUS, WORKING_STATUS, visibleAssistantText } from "./stream-card.js";

/** One short, actionable line the phone gets instead of an empty card when a settled turn has no visible reply body. */
export const EMPTY_REPLY_NOTICE = "Remote bridge: this turn ended without a reply. Send your message again, or check the terminal.";

/** One line the phone gets when stopping the bridge drops messages that were queued but never answered. */
export function droppedQueueNotice(count: number): string {
  return `Remote bridge stopped: ${count} queued ${count === 1 ? "message" : "messages"} did not get an answer.`;
}

type RemoteStatus = "off" | "standby" | "connecting" | "connected" | "error";
const REMOTE_STATUS_KEY = "feishu-3-remote";

const MISSING_SECRET = `Remote bridge needs an app secret: set ${REMOTE_SECRET_ENV} to the existing bot app's secret (view it in the Feishu developer console — do not reset it), then run /remote start.`;

interface QueuedMessage {
  chatId: string;
  text: string;
  opening?: string;
}

interface ActiveCard {
  open: Promise<StreamCardSession | undefined>;
  /** Why the card could not be opened; the fallback warning reports it at settle. */
  openError?: unknown;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The most complete reply body known at stop time: the settled reply, else the last streamed card
 * snapshot. The longer one wins, so a settled reply from an earlier low-level run of the same turn
 * can never shrink the card past content it already streamed. */
function knownReplyBody(reply: string | undefined, session: StreamCardSession | undefined): string {
  const streamed = session?.replyBody() ?? "";
  return streamed.length > (reply?.length ?? 0) ? streamed : reply || "";
}

function droppedByChat(messages: QueuedMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) counts.set(message.chatId, (counts.get(message.chatId) ?? 0) + 1);
  return counts;
}

function toolStatusLine(): string {
  return WORKING_STATUS;
}

function classifierText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((part): part is { type?: string; text?: string } => Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text"))
    .map((part) => part.text ?? "").join("").trim();
}

async function chooseReaction(ctx: ExtensionContext | undefined, text: string): Promise<ReactionChoice> {
  if (!ctx?.model) return fallbackReaction;
  try {
    const context = {
      systemPrompt: REACTION_PROMPT_FOR_MODEL,
      messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
    } as Parameters<typeof ctx.modelRegistry.complete>[1];
    const response = await ctx.modelRegistry.complete(ctx.model, context, { reasoning: "off", maxTokens: 96, signal: AbortSignal.timeout(5000) });
    return parseReactionChoice(classifierText(response));
  } catch {
    return fallbackReaction;
  }
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
    let activeTurn: { chatId: string; reply?: string; stopRequested?: boolean } | undefined;
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
    let autostartTimer: NodeJS.Timeout | undefined;

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

    function beginCard(chatId: string, initialText?: string): ActiveCard | undefined {
      const gw = gateway;
      if (!gw) return undefined;
      const card: ActiveCard = { open: Promise.resolve(undefined) };
      card.open = gw.openStreamCard(chatId, initialText || undefined).then(
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
              // Non-fatal: the final close rewrites the complete reply. Say only that.
              notify(latestCtx, `Remote bridge card stream write failed; the card may be incomplete until it closes: ${errorText(error)}`, "warning");
            },
          );
          return session;
        },
        (error) => {
          card.openError = error;
          return undefined;
        },
      );
      return card;
    }

    async function plainFallback(chatId: string, text: string): Promise<boolean> {
      const gw = gateway;
      if (!gw) return false;
      // The send error itself is dropped: the card failure is the actionable cause,
      // and the warning already states whether the fallback landed.
      return gw.sendMessage(chatId, text).then(() => true, () => false);
    }

    function fallbackText(sent: boolean, notice: boolean): string {
      if (notice) return sent ? "the notice was sent as a plain message" : "the notice could not be sent either";
      return sent ? "the reply was sent as a plain message" : "the plain-message fallback also failed";
    }

    async function finalizeCard(turn: { chatId: string; reply?: string }, card: ActiveCard): Promise<void> {
      const reply = turn.reply ?? "";
      // A settle with no visible reply body — every low-level run failed, or the turn
      // only produced internal reasoning — owes the phone an actionable line: an empty
      // card is indistinguishable from a bridge that is still working.
      const notice = !reply;
      const text = notice ? EMPTY_REPLY_NOTICE : reply;
      const session = await card.open;
      if (!session) {
        const sent = await plainFallback(turn.chatId, text);
        notify(latestCtx, `Remote bridge could not open the streaming card; ${fallbackText(sent, notice)}: ${errorText(card.openError)}`, "warning");
        return;
      }
      const shards = shardText(text);
      const outcome = await session.finalize(shards[0]);
      if (!outcome.closed) {
        // The card may still be streaming: deliver the complete text as a plain
        // message instead, exactly once, rather than leaving partial text. One
        // message, not sharded: a reply above Feishu's text-message limit would
        // need sharding here.
        const sent = await plainFallback(turn.chatId, text);
        notify(latestCtx, `Remote bridge card close failed after a retry; ${fallbackText(sent, notice)} (the card may still be streaming): ${errorText(outcome.error)}`, "warning");
        return;
      }
      const gw = gateway;
      for (const shard of shards.slice(1)) await gw?.sendMessage(turn.chatId, shard).catch(() => {});
    }

    function submit(next: QueuedMessage): void {
      // One card-write warning per turn: a card outage that spans turns must not
      // go silent after the first warning, so re-arm the latch at each new turn.
      reportedCardError = false;
      activeTurn = { chatId: next.chatId };
      try {
        pi.sendUserMessage(next.text);
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
      activeCard = beginCard(next.chatId, next.opening);
    }

    function acknowledge(chatId: string, text: string): void {
      void gateway?.sendMessage(chatId, text).catch(() => { /* acknowledgements are best-effort */ });
    }

    function abortCurrentTurn(chatId: string): void {
      acknowledge(chatId, "Remote bridge: stop requested; the current turn will be interrupted.");
      if (activeTurn) activeTurn.stopRequested = true;
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

    async function onInbound(event: RemoteInboundEvent): Promise<void> {
      if (!credentials || !authorizeInbound(event, credentials.ownerOpenId)) return;
      if (!dedup.claim(event.messageId)) return;
      if (event.messageType !== "text") {
        acknowledge(event.chatId, unsupportedMessageType(event.messageType));
        return;
      }
      const choice = event.chatType === "group" ? await chooseReaction(latestCtx, event.text) : undefined;
      if (choice && gateway) await gateway.addReaction(event.messageId, choice.emojiType).catch(() => {});
      deliver({ chatId: event.chatId, text: event.text, opening: choice?.opening });
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
      const turn = activeTurn;
      const dropped = queue.splice(0);
      gateway = undefined;
      pendingGateway = undefined;
      stopHandoffWatch();
      transport = undefined;
      activeTurn = undefined;
      activeCard = undefined;
      secret = undefined;
      reportedPollError = false;
      reportedCardError = false;
      // Finalize any in-flight streaming card BEFORE dropping the gateway so the
      // phone never watches a card hang in streaming mode. Stop shares the
      // settle-time rule — close with the most complete reply body known at stop
      // time (the settled reply, else the last streamed snapshot), sharded like a
      // settle — and falls back to one plain message when the close does not land,
      // never empty content that would erase what the phone already saw. It
      // reports nothing: the session is going away.
      const session = await card?.open;
      if (turn) {
        const body = knownReplyBody(turn.reply, session) || EMPTY_REPLY_NOTICE;
        const shards = shardText(body);
        // Best-effort: the session is going away, so a failed outbound is not reported.
        const send = (text: string) => candidate?.sendMessage(turn.chatId, text).catch(() => { /* stop is best-effort: a failed outbound must not fail it */ });
        const closed = session ? (await session.finalize(shards[0])).closed : false;
        if (closed) for (const shard of shards.slice(1)) await send(shard);
        else await send(body);
      }
      // Queued phone messages are dropped, not answered: say how many, once per
      // chat. Best-effort and untried — a failed notice never fails the stop.
      if (candidate) {
        for (const [queuedChatId, count] of droppedByChat(dropped)) {
          await candidate.sendMessage(queuedChatId, droppedQueueNotice(count)).catch(() => { /* the dropped-message notice is best-effort; stop must not fail on it */ });
        }
      }
      await candidate?.close();
      dropLock();
      // No paint on session_shutdown: the captured ctx is stale and the UI is going away.
      status = "off";
      if (paintCtx) paint(paintCtx);
    }

    pi.on("session_start", (_event, ctx) => {
      latestCtx = ctx;
      paint(ctx);
      if (ctx.mode === "tui" && process.env[REMOTE_AUTOSTART_ENV] === "1" && !gateway && !pendingGateway) {
        // Let the TUI finish its first paint before any remote handshake can
        // enter the event loop. Explicit /remote start remains immediate.
        if (autostartTimer) clearTimeout(autostartTimer);
        autostartTimer = setTimeout(() => {
          autostartTimer = undefined;
          if (!gateway && !pendingGateway) void start(ctx, { quietIfHeld: true });
        }, 100);
      }
    });

    pi.on("session_shutdown", () => {
      if (autostartTimer) {
        clearTimeout(autostartTimer);
        autostartTimer = undefined;
      }
      return stop();
    });

    pi.on("agent_start", (_event, ctx) => {
      // sendUserMessage starts asynchronously: a same-batch stop can precede
      // the SDK's abort signal. Retain it on this turn, never on its successor.
      if (activeTurn?.stopRequested) ctx.abort();
    });

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
        else if (tool) session.setStatus(toolStatusLine()); // toolCall content part = a tool is running
        else session.setStatus(THINKING_STATUS); // reasoning or a post-tool turn is still in progress
        session.update(text);
      });
    });

    pi.on("agent_end", (event) => {
      // agent_end closes ONE low-level run: auto-retry after a provider error,
      // overflow recovery and compaction can still produce the answer in a later
      // run of the same turn. Keep the last run that actually produced text and
      // let agent_settled finalize; closing here sent an empty card and dropped
      // the retried answer from the phone.
      const turn = activeTurn;
      if (!turn) return;
      const reply = lastAssistantText(event.messages);
      if (reply) turn.reply = reply;
    });

    pi.on("agent_settled", async () => {
      const turn = activeTurn;
      activeTurn = undefined;
      const card = activeCard;
      activeCard = undefined;
      if (turn && card) await finalizeCard(turn, card);
      // An aborted run does not drain follow-ups queued during settlement in
      // Pi 0.87.1, and a phone message that arrived while the card closed may
      // already own the next turn. Pi defers the fresh run until every
      // agent_settled handler has finished.
      if (activeTurn) return;
      const next = queue.shift();
      if (next) submit(next);
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
      if (holder && requestRemoteHandover(process.env.HOME ?? "", appId)) {
        notify(ctx, `Remote bridge: asking ${describeHolder(holder)} to hand over…`);
        const released = await waitForRemoteLockRelease(process.env.HOME ?? "", appId, 10_000);
        if (!released) {
          const error = `Remote bridge handover timed out: ${describeHolder(holder)} did not release the lock. Stop it there first.`;
          enterStandby(ctx, error);
          notify(ctx, error, "error");
          return;
        }
      }
      // No holder, or a dead one (crashed window): nothing to ask — fall
      // through and let acquireRemoteLock reclaim the stale lock (SPEC §221:
      // 无锁/死 pid 锁直接回收后连接).
      await start(ctx);
    }

    const REMOTE_SUBCOMMANDS = [
      { value: "start", label: "start", description: "Connect the remote bridge" },
      { value: "switch", label: "switch", description: "Take over the bridge from another window" },
      { value: "status", label: "status", description: "Show connection and lock status" },
      { value: "stop", label: "stop", description: "Disconnect the bridge and release lock" },
    ];

    pi.registerCommand("remote", {
      description: "Manage the Feishu Remote Bridge (phone control of this session)",
      getArgumentCompletions: (argumentPrefix: string) => {
        const query = argumentPrefix.trim().toLowerCase();
        return REMOTE_SUBCOMMANDS.filter((item) => item.value.startsWith(query));
      },
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

export default remoteBridgeExtension();
