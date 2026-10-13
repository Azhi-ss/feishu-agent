# Feishu Agent

Shared language for the Feishu Remote Bridge conversation and card experience.

## Remote Bridge Card

**Phase status**:
A short application-controlled label that tells the recipient what the active turn is doing: `💭 思考中…` or `⚙️ working中…`. It clears when visible reply text starts.
_Avoid_: Raw thinking, internal reasoning

**Raw thinking**:
The model's internal reasoning content, which is not shown in the Feishu card.
_Avoid_: Phase status, reply text

**Reply body**:
The visible answer text streamed into the card and retained in the finalized reply.
_Avoid_: Thinking, tool output
