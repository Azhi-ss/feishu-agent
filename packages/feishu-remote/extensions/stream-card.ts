// Feishu streaming-card state machine, adapted from the OpenClaw Card Kit
// reference: coalesce rapid assistant-text updates behind a throttle, force a
// flush on a significant delta or sentence/newline boundary, serialize writes
// through a promise chain with a monotonic sequence + unique id per write, and
// treat stream write failures as non-fatal (the final close is authoritative).
// Pure decision helpers stay module-level so tests can cover them directly.

export const STREAM_UPDATE_THROTTLE_MS = 160;
export const STREAM_SIGNIFICANT_DELTA_CHARS = 18;
export const THINKING_STATUS = "💭 思考中…";
export const WORKING_STATUS = "⚙️ working中…";
/** Feishu card envelope: cards hold ~30KB of text (UTF-8); over-long finals are sharded. */
export const STREAM_CARD_TEXT_LIMIT_BYTES = 30_000;

// Sentence/newline boundaries. A bare "." is deliberately absent: it would
// force a flush on every abbreviation and decimal.
const STREAM_BOUNDARY = /[\n。！？!?；;：:]$/;

export function shouldFlushStreamUpdate(previousText: string, nextText: string, elapsedMs: number): boolean {
  return (
    previousText === "" ||
    STREAM_BOUNDARY.test(nextText) ||
    nextText.length - previousText.length >= STREAM_SIGNIFICANT_DELTA_CHARS ||
    elapsedMs >= STREAM_UPDATE_THROTTLE_MS
  );
}

/**
 * Visible assistant text: text parts only, reasoning stripped. Thinking parts
 * and text parts carrying a commentary-phase v1 signature (reasoning tags) are
 * internal chain-of-thought and never reach the phone card.
 */
export function visibleAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { text?: string; textSignature?: string } => {
      if (!part || typeof part !== "object") return false;
      const candidate = part as { type?: string; text?: string; textSignature?: string };
      if (candidate.type !== "text") return false;
      const signature = candidate.textSignature;
      if (typeof signature !== "string" || !signature.startsWith("{")) return true;
      try {
        const parsed = JSON.parse(signature) as { v?: number; phase?: string };
        return !(parsed?.v === 1 && parsed?.phase === "commentary");
      } catch {
        return true; // malformed signature: keep the text
      }
    })
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Split over-long final replies at newline seams inside the byte envelope. */
export function shardText(text: string, limit = STREAM_CARD_TEXT_LIMIT_BYTES): string[] {
  const shards: string[] = [];
  let remaining = text;
  while (byteLength(remaining) > limit) {
    let bytes = 0;
    let cut = 0;
    let seam = -1;
    for (let i = 0; i < remaining.length; i++) {
      const size = byteLength(remaining[i]);
      if (bytes + size > limit) break;
      bytes += size;
      cut = i + 1;
      if (remaining[i] === "\n") seam = cut;
    }
    let split = seam > cut / 2 ? seam : cut;
    // Never split a surrogate pair: a lone half would mangle the emoji at the seam.
    if (remaining.charCodeAt(split - 1) >= 0xd800 && remaining.charCodeAt(split - 1) <= 0xdbff) split -= 1;
    shards.push(remaining.slice(0, split));
    remaining = remaining.slice(split);
  }
  shards.push(remaining);
  return shards;
}

export interface StreamCardOps {
  append(cardId: string, text: string, sequence: number, uuid: string): Promise<void>;
  setStatus(cardId: string, text: string): Promise<void>;
  closeCard(cardId: string, finalText: string): Promise<void>;
}

/** Outcome of the authoritative close: `closed` false means the final text never
 * landed, so the caller must deliver the reply another way. */
export interface CardCloseResult {
  closed: boolean;
  error?: unknown;
}

export class StreamCardSession {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private sentText = "";
  private writingText: string | undefined;
  private pendingText: string | undefined;
  private statusText = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt = 0;
  private sequence = 0;
  private closeRun: Promise<CardCloseResult> | undefined;
  private latestReplyBody = "";

  constructor(
    readonly cardId: string,
    private readonly ops: StreamCardOps,
    private readonly onWriteError: (error: unknown) => void,
  ) {}

  /** Feed the complete visible text so far; rapid updates are coalesced behind the throttle. */
  update(text: string): void {
    if (this.closed || !text) return;
    this.latestReplyBody = text;
    // Decide against what the card already shows OR what an in-flight/queued
    // write is about to show, so the first-text force does not re-fire while
    // the first append is still on the wire.
    const previous = this.writingText ?? this.sentText;
    if (text === previous) return;
    this.pendingText = text;
    void this.flush();
  }

  /** Update the transient phase content; an empty string clears it. */
  setStatus(text: string): void {
    if (this.closed || text === this.statusText) return;
    this.statusText = text;
    this.enqueueStatus(text);
  }

  /**
   * The latest visible reply body snapshot fed to this card ("" until the first
   * streamed text). Stop-time finalization reads it so closing a card mid-turn
   * does not fall back to an emptier body than what the phone already saw.
   */
  replyBody(): string {
    return this.latestReplyBody;
  }

  /**
   * Authoritative close: delivers the complete final text even if stream writes
   * failed. Reports whether the final write landed so the caller can send the
   * reply as a plain message instead; a close that fails is retried exactly
   * once, so a transient CardKit error never duplicates the reply.
   */
  finalize(finalText: string): Promise<CardCloseResult> {
    if (!this.closeRun) {
      this.closed = true;
      this.clearTimer();
      if (this.statusText) {
        // Strip the status strip before the final close so it never reaches the finalized reply.
        this.statusText = "";
        this.enqueueStatus("");
      }
      this.closeRun = this.closeOnce(finalText);
    }
    return this.closeRun;
  }

  private async closeOnce(finalText: string): Promise<CardCloseResult> {
    await this.queue;
    let error: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ops.closeCard(this.cardId, finalText);
        return { closed: true };
      } catch (failure) {
        error = failure;
      }
    }
    return { closed: false, error };
  }

  private enqueueStatus(text: string): void {
    // CardKit rejects empty content with HTTP 400 / 99992402 "the min len is 1":
    // a single space clears the strip visually while satisfying the constraint.
    const wireText = text || " ";
    this.queue = this.queue.then(async () => {
      try {
        await this.ops.setStatus(this.cardId, wireText);
      } catch (error) {
        this.onWriteError(error); // status writes are best-effort
      }
    });
  }

  private clearTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      this.clearTimer();
      const text = this.pendingText;
      if (text === undefined || text === this.sentText || text === this.writingText) return;
      // Queue delays and coalescing can invalidate an earlier flush decision.
      // Check the latest snapshot here and timestamp the actual dispatch.
      const elapsed = Date.now() - this.lastFlushAt;
      if (!shouldFlushStreamUpdate(this.sentText, text, elapsed)) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          void this.flush();
        }, STREAM_UPDATE_THROTTLE_MS - elapsed);
        return;
      }
      this.pendingText = undefined;
      this.writingText = text;
      this.lastFlushAt = Date.now();
      this.sequence += 1;
      try {
        await this.ops.append(this.cardId, text, this.sequence, `s_${this.cardId}_${this.sequence}`);
        this.sentText = text;
      } catch (error) {
        this.onWriteError(error); // non-fatal: the final close is authoritative
      }
      if (this.writingText === text) this.writingText = undefined;
    });
    return this.queue;
  }
}
