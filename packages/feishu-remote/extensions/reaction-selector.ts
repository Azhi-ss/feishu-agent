export const REACTION_PROMPT = `你是“小欠”的群聊回应设计师。

根据用户刚刚发送的消息，自主选择一个最合适的飞书 reaction，表达小欠此刻对这条消息的直觉反应。可以俏皮、聪明、温和或有一点幽默，但要符合语境，不要嘲讽，不要过度夸张。

这个 reaction 会永久保留在原消息上，所以请选择即使任务完成后仍然合适的表情，不要表达错误的持续状态。

生成一句很短的开场文案，像小欠自然地回应了一下。最多 16 个中文字符，不换行，不复述用户原话，不声称任务已经完成。

只能从 ALLOWED_EMOJI_TYPES 中选择，禁止输出 Unicode 表情或列表外的值。不要输出思考过程，只返回严格 JSON：
{"emoji_type":"合法的飞书 emoji_type","opening":"简短的趣味回应"}

ALLOWED_EMOJI_TYPES:
OK, THUMBSUP, THANKS, MUSCLE, FINGERHEART, APPLAUSE, FISTBUMP, JIAYI, DONE, SMILE, BLUSH, LAUGH, SMIRK, LOL, FACEPALM, LOVE, WINK, PROUD, WITTY, SMART, SCOWL, THINKING, SOB, CRY, ERROR, NOSEPICK, HAUGHTY, SLAP, SPITBLOOD, TOASTED, GLANCE, DULL, INNOCENTSMILE, JOYFUL, WOW, TRICK, YEAH, ENOUGH, TEARS, EMBARRASSED, KISS, SMOOCH, DROOL, OBSESSED, MONEY, TEASE, SHOWOFF, COMFORT, CLAP, PRAISE, STRIVE, XBLUSH, SILENT, WAVE, WHAT, FROWN, SHY, DIZZY, LOOKDOWN, CHUCKLE, WAIL, CRAZY, WHIMPER, HUG, BLUBBER, WRONGED, HUSKY, SHHH, SMUG, ANGRY, HAMMER, SHOCKED, TERROR, PETRIFIED, SKULL, SWEAT, SPEECHLESS, SLEEP, DROWSY, YAWN, SICK, PUKE, BETRAYED, HEADSET, EatingFood, MeMeMe, Sigh, Typing, Lemon, Get, LGTM, OnIt, OneSecond, VRHeadset, YouAreTheBest, SALUTE, SHAKE, HIGHFIVE, UPPERLEFT, ThumbsDown, SLIGHT, TONGUE, EYESCLOSED, RoarForYou, CALF, BEAR, BULL, RAINBOWPUKE, ROSE, HEART, PARTY, LIPS, BEER, CAKE, GIFT, CUCUMBER, Drumstick, Pepper, CANDIEDHAWS, BubbleTea, Coffee, Yes, No, OKR, CheckMark, CrossMark, MinusOne, Hundred, AWESOMEN, Pin, Alarm, Loudspeaker, Trophy, Fire, BOMB, Music, XmasTree, Snowman, XmasHat, FIREWORKS, 2022, REDPACKET, FORTUNE, LUCK, FIRECRACKER, StickyRiceBalls, HEARTBROKEN, POOP, StatusFlashOfInspiration, 18X, CLEAVER, Soccer, Basketball, GeneralDoNotDisturb, Status_PrivateMessage, GeneralInMeetingBusy, StatusReading, StatusInFlight, GeneralBusinessTrip, StatusWorkFromHome, StatusEnjoyLife, GeneralTravellingCar, StatusBus, GeneralSun, GeneralMoonRest, MoonRabbit, Mooncake, JubilantRabbit, TV, Movie, Pumpkin, BeamingFace, Delighted, ColdSweat, FullMoonFace, Partying, GoGoGo, ThanksFace, SaluteFace, Shrug, ClownFace, HappyDragon`;

export const REACTION_PROMPT_FOR_MODEL = REACTION_PROMPT.replaceAll("StatusWorkFromHome", "GeneralWorkFromHome");
const EMOJI_TYPES = new Set(REACTION_PROMPT_FOR_MODEL.split("ALLOWED_EMOJI_TYPES:\n")[1].split(", "));
const FALLBACK = { emojiType: "GLANCE", opening: "小欠看到啦～" } as const;

export interface ReactionChoice {
  emojiType: string;
  opening: string;
}

function cleanOpening(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\r\n\u0000-\u001f]/g, "").trim();
  return cleaned ? Array.from(cleaned).slice(0, 16).join("") : undefined;
}

export function parseReactionChoice(text: string): ReactionChoice {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return FALLBACK;
    const parsed = JSON.parse(text.slice(start, end + 1)) as { emoji_type?: unknown; opening?: unknown };
    const emojiType = typeof parsed.emoji_type === "string" && EMOJI_TYPES.has(parsed.emoji_type) ? parsed.emoji_type : FALLBACK.emojiType;
    return { emojiType, opening: cleanOpening(parsed.opening) ?? FALLBACK.opening };
  } catch {
    return FALLBACK;
  }
}

export const fallbackReaction = FALLBACK;
