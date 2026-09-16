import type { ContextEvent } from "@earendil-works/pi-coding-agent";

/** AgentMessage is not part of the public index; derive it from a public event. */
export type AgentMessage = ContextEvent["messages"][number];

/**
 * Replay-reasoning trim (#45): the request-context view of history omits
 * reasoning from assistant messages that are verified-complete, text-only
 * final answers. The on-disk session record is never rewritten; callers only
 * filter the transient message lists that would otherwise be serialized.
 *
 * Conservative protocol rule: a message is eligible only when every block is
 * a plain, unsigned thinking block or an ordinary text block, it carries at
 * least one non-empty reasoning block, at least one non-empty answer text
 * block, no tool calls, and the message demonstrably completed normally
 * (stopReason "stop"). A thinking block that carries a signature, redaction
 * marker, or any other field is part of a signed/encrypted chain and stays;
 * one such block makes the whole message ineligible. Reasoning on tool steps,
 * in-progress/aborted/error/truncated output, and messages that never produced
 * an answer are all retained.
 */

type ContentBlock = Record<string, unknown>;

const PLAIN_REASONING_FIELD_NAMES = new Set([
  "reasoning",
  "reasoning_content",
  "reasoning_text",
]);

function isAssistant(message: AgentMessage): message is AgentMessage & { role: "assistant" } {
  return (message as { role?: unknown }).role === "assistant";
}

function isPlainReasoningBlock(block: ContentBlock): boolean {
  if (block.type !== "thinking") return false;
  if (typeof block.thinking !== "string" || block.thinking.trim() === "") return false;
  if (block.redacted) return false;

  for (const key of Object.keys(block)) {
    if (key === "type" || key === "thinking") continue;
    if (key === "thinkingSignature") {
      const sig = block.thinkingSignature;
      if (typeof sig === "string" && PLAIN_REASONING_FIELD_NAMES.has(sig)) continue;
      // Any other signature (cryptographic, opaque, or custom) must be preserved.
      return false;
    }
    // Any other unknown property means we cannot prove it's safe to trim.
    return false;
  }
  return true;
}

/**
 * Return true when this assistant message is a verified-complete, text-only
 * final answer carrying at least one safely removable reasoning block.
 */
export function isTrimmableFinalAnswer(message: AgentMessage): boolean {
  if (!isAssistant(message)) return false;
  const assistant = message as { stopReason?: unknown; content?: unknown };
  if (assistant.stopReason !== "stop") return false;
  if (!Array.isArray(assistant.content)) return false;
  let reasoningCount = 0;
  let textBlockCount = 0;
  for (const block of assistant.content as ContentBlock[]) {
    if (typeof block !== "object" || block === null) return false;
    const type = block.type;
    if (type === "thinking") {
      if (!isPlainReasoningBlock(block)) return false;
      reasoningCount += 1;
    } else if (type === "text") {
      const keys = Object.keys(block).filter((key) => key !== "type" && key !== "text");
      if (keys.length > 0) return false;
      if (typeof block.text !== "string" || block.text.trim() === "") return false;
      textBlockCount += 1;
    } else {
      // Tool calls, images, and any unknown block structure veto trimming.
      return false;
    }
  }
  return reasoningCount > 0 && textBlockCount > 0;
}

/**
 * Return a shallow-cloned eligible message with only the plain reasoning
 * blocks removed. Non-eligible messages come back untouched.
 */
export function trimFinalAnswerReasoning<T extends AgentMessage>(message: T): T {
  if (!isTrimmableFinalAnswer(message)) return message;
  const original = message as unknown as { content: ContentBlock[] };
  const content = original.content.filter((block) => block.type !== "thinking") as typeof original.content;
  return { ...message, content } as T;
}

/** Compute the filtered view; always returns a fresh list for atomic apply. */
export function trimReplayedReasoning<T extends AgentMessage>(messages: readonly T[]): T[] {
  return messages.map((message) => trimFinalAnswerReasoning(message));
}
