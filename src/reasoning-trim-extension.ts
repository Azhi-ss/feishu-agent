import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { trimFinalAnswerReasoning, trimReplayedReasoning, type AgentMessage } from "./reasoning-trim.js";

/**
 * Built-in replay-reasoning trim (#45). One semantic policy covers every
 * model-request entry:
 *  - normal requests via the "context" hook (the transient AgentMessage view);
 *  - automatic and manual compaction via "session_before_compact"
 *    (messagesToSummarize + split-turn prefix);
 *  - branch summaries via "session_before_tree" (entriesToSummarize).
 *
 * The filter computes replacements first into temporary structures and only
 * applies them upon complete success. Any failure leaves the incoming view
 * verbatim; nothing is rebuilt from disk. Diagnostics are fixed English lines
 * that never include message text, requests, signatures, or secrets.
 */

const DIAGNOSTIC = "Warning: Replay reasoning trim unavailable for this request; original context was kept unchanged.";

interface MessageEntry {
  type: "message";
  message: AgentMessage;
  [key: string]: unknown;
}

function isMessageEntry(entry: unknown): entry is MessageEntry {
  return typeof entry === "object" && entry !== null &&
    (entry as { type?: unknown }).type === "message" &&
    typeof (entry as { message?: unknown }).message === "object" &&
    (entry as { message?: unknown }).message !== null;
}

function applyBranchTrimming(entries: unknown): void {
  if (!Array.isArray(entries)) throw new Error("invalid branch entries");
  // Compute the full staged array first (compute-then-commit). If any item
  // fails, entries is left untouched.
  const staged = entries.map((entry) => {
    if (!isMessageEntry(entry)) return entry;
    const trimmed = trimFinalAnswerReasoning(entry.message);
    return trimmed === entry.message ? entry : { ...entry, message: trimmed };
  });
  for (let i = 0; i < staged.length; i++) entries[i] = staged[i];
}

export function reasoningTrimExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const warn = (message: string): void => {
      try { process.stderr.write(`${message}\n`); }
      catch { /* best-effort diagnostic; never block a request */ }
    };

    pi.on("context", (event) => {
      try {
        return { messages: trimReplayedReasoning(event.messages) };
      } catch {
        warn(DIAGNOSTIC);
        return undefined; // Keep the unfiltered incoming view.
      }
    });

    pi.on("session_before_compact", (event) => {
      try {
        const preparation = event.preparation as unknown as {
          messagesToSummarize: AgentMessage[];
          turnPrefixMessages: AgentMessage[];
        };
        // Stage both lists first; commit to preparation only when both succeed.
        const nextSummarize = trimReplayedReasoning(preparation.messagesToSummarize);
        const nextPrefix = trimReplayedReasoning(preparation.turnPrefixMessages);
        preparation.messagesToSummarize = nextSummarize;
        preparation.turnPrefixMessages = nextPrefix;
      } catch {
        warn(DIAGNOSTIC);
      }
      return undefined;
    });

    pi.on("session_before_tree", (event) => {
      try {
        applyBranchTrimming(event.preparation.entriesToSummarize);
      } catch {
        warn(DIAGNOSTIC);
      }
      return undefined;
    });
  };
}
