/** One message as `lark-cli im +chat-messages-list` returns it. */
export interface ChatMessage {
  sender?: { sender_type?: string };
  msg_type?: string;
  message_id?: string;
}

/**
 * The newest bot card strictly newer than `afterId` in a newest-first page (the CLI's
 * `--order desc`). Undefined when the baseline is not on the page — keep polling — or no
 * such card has arrived yet.
 */
export function newestCardAfter(page: ChatMessage[], afterId: string): string | undefined {
  const baselineIndex = page.findIndex((message) => message.message_id === afterId);
  if (baselineIndex < 0) return undefined;
  return page.slice(0, baselineIndex).find((message) => message.sender?.sender_type === "app" && message.msg_type === "interactive")?.message_id;
}

/**
 * Violations of "this turn produced exactly one card and no extra plain message" for a
 * newest-first page: the card must be on the page and the bot must have sent nothing
 * after it; when the pre-turn baseline is still on the page, the bot must also have sent
 * exactly that one card since it. Returns human-readable violations, empty when clean.
 */
export function oneCardNoExtraViolations(page: ChatMessage[], baselineId: string | undefined, cardId: string): string[] {
  const cardIndex = page.findIndex((message) => message.message_id === cardId);
  if (cardIndex < 0) return [`the new card ${cardId} is not in the newest messages`];
  const afterCard = page.slice(0, cardIndex).filter((message) => message.sender?.sender_type === "app");
  if (afterCard.length) return [`the bot sent ${afterCard.length} extra message(s) after the card: ${afterCard.map((message) => message.msg_type).join(", ")}`];
  const baselineIndex = baselineId ? page.findIndex((message) => message.message_id === baselineId) : -1;
  if (baselineIndex < 0) return []; // baseline scrolled off the page: the after-card check above is the strong one and it passed
  const sinceBaseline = page.slice(0, baselineIndex).filter((message) => message.sender?.sender_type === "app").map((message) => message.msg_type);
  return sinceBaseline.length === 1 && sinceBaseline[0] === "interactive"
    ? []
    : [`the turn's bot messages were [${sinceBaseline.join(", ")}], expected exactly one interactive card`];
}
