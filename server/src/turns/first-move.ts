/**
 * A turn's first step, taken before the Bot's model is asked.
 *
 * WHY. Asked "오늘 날씨 어때?", a Bot's model is asked twice: once to decide to call the weather
 * tool, once to write the answer from what came back. Measured on the local stack (2026-10-02,
 * muse-spark, `docs/laf/eval-pack.md` "The weather"): the first of those took 5.1 s and 8.9 s to
 * its first chunk — the second time with 99% of its prompt read from cache, so it is the model
 * reasoning and the endpoint's queue, not the prompt — while 기상청 itself took 1.2 s and the round
 * that writes the answer two. The first round decides something a much smaller question can decide.
 *
 * So, with the switch on (`FIRST_MOVE`, on unless it says `off`): a decisions model — TypeSafe's
 * Jev, 0.24 s warm — is asked yes-or-no questions about the person's message, and when a kind's
 * are all a clear yes the server makes the call itself, files it in the thread exactly as a call
 * the Bot made, and the Bot's model starts with the result in hand.
 *
 * THE RULE THAT ADMITS A KIND (the owner, 2026-10-05): THE CALL TAKES NO ARGUMENT THE PERSON'S
 * MESSAGE WOULD HAVE TO SUPPLY. The decisions model answers yes or no and nothing it says becomes
 * an argument; every argument below is a constant of this file. Three kinds pass it:
 *
 *   weather   the forecast for the person's saved place. A message that names another place is left
 *             to the Bot's model, which reads a place out of a sentence well and a deterministic
 *             rule badly ("우산" is 광주 북구 우산동).
 *   calendar  today's events on the person's own Google Calendar. Tomorrow, this week, a named date
 *             or one particular meeting is the Bot's model's: each needs something read out of the
 *             message.
 *   mail      the unread mail in the person's own Gmail inbox. A sender, a subject, a period is the
 *             Bot's model's, for the same reason.
 *
 * The last two pay more than the weather does. A connected service's tools are not in the schema:
 * they stand behind `tool_search` / `tool_call` (`shared/tools/bridge.ts`), so "오늘 일정 뭐 있어?"
 * is three rounds of the Bot's model — find the tool, call it, write — and a move takes two away.
 *
 * WHAT LEAVES THE MACHINE, AND WHEN. Nothing unless the switch is on and Jev may be asked at all
 * (`JEV_ENABLED`, an OpenRouter endpoint). Then only a message that is short, is the person's one
 * message of the turn, and has a word of a kind in it — the weather's, a schedule's or the mail's,
 * the lists below, checked here first — from a person who could be answered (a saved place, a
 * connected calendar, a connected mailbox), and that message goes redacted
 * (`context/judge-redaction.ts`). The owner's yes to building this is recorded with the plan
 * (`~/laf/docs/jev-adoption-review-2026-10-02.md` §3, §6), and the yes to turning it on for
 * customers came on 2026-10-05, with a condition: a move that turns out to be made seldom comes out
 * again. So every decision asked for leaves a row, moved or not, and the rate can be read from the
 * trail without a word of anybody's message.
 *
 * ONE REQUEST A MESSAGE, whatever the number of kinds. The kinds whose words are in the message
 * ride in the one request, each with its own questions; a message with no word of any kind is never
 * sent. When two kinds clear their bars the message asked for two things, and no move is made: the
 * Bot's model is the one that reads a sentence with two requests in it.
 *
 * IT CAN ONLY ADD A READ. The one call it makes is read-only and goes through the turn's own
 * executor — the Bot's grant, the boundary, the audit row, and for mail the withholding of one-time
 * codes (`plugins/mail-secrets.ts`), as for any call. Anything short of a clear yes, a slow answer
 * or no answer makes no move, and the turn is exactly the turn it was.
 */
import {
  FIRST_MOVE_KINDS,
  type FirstMoveEnding,
  type FirstMoveKind,
  isFirstMoveEnding,
} from "../../../shared/first-move";
import {
  DEFERRED_TOOL_PREFIX,
  WEATHER_TOOL_NAME,
} from "../../../shared/tools/bridge";
import type { Whereabouts } from "../../../shared/whereabouts";
import { type AuditStore, auditRowLost, recordAuditEvent } from "../audit";
import type { Decision, DecisionQuestion } from "../computer/decision-call";
import { redactText } from "../context/judge-redaction";
import { log } from "../log";

/** The moves there are. A closed list: each is a tool, its arguments and the questions that earn it. */
export const FIRST_MOVES = FIRST_MOVE_KINDS;
export type { FirstMoveKind };

/** A call the server makes for the Bot before its model is asked. */
export type FirstMove = {
  kind: FirstMoveKind;
  tool: string;
  args: Record<string, unknown>;
  /** The kinds the decisions model was asked about in the one request this came of. */
  asked: readonly FirstMoveKind[];
  /** What the decisions model said, for the trail: probabilities, never words. */
  decided: Record<string, number>;
};

/**
 * Longer than this is not the kind of message a first move is for: a sentence that long is asking
 * for more than a lookup, and it is also more of somebody's words than this needs to send anywhere.
 */
export const FIRST_MOVE_MAX_CHARS = 60;

/** The connected services a move reads, by the key their catalogue entries are stored under. */
export const CALENDAR_SERVER = "google-calendar";
export const MAIL_SERVER = "gmail";

/**
 * The two connected tools a move calls, by the name a Bot is offered them under
 * (`toolNameFor`, `plugins/store.ts`: `mcp__<server>__<tool>`). Spelled from the shared prefix as
 * the weather's is; `first-move.test.ts` holds them to the catalogue, so a tool renamed there fails
 * here rather than turning a move into a call nothing answers.
 *
 * NOT ON THE CORE LIST (`CORE_TOOL_NAMES`). They stay behind the bridge, where a Bot finds them when
 * it needs them: a move adds nothing to the head of the prompt.
 */
export const CALENDAR_TOOL_NAME = `${DEFERRED_TOOL_PREFIX}${CALENDAR_SERVER}__list_events`;
export const MAIL_TOOL_NAME = `${DEFERRED_TOOL_PREFIX}${MAIL_SERVER}__search_messages`;

/**
 * What a kind has to find before anybody is asked: somewhere to answer for.
 *
 * The Bot holding the tool is the grant, and is not the connection: a grant outlives a person's
 * disconnecting, and a connection the vendor withdrew is still a row. A move made without one is a
 * refusal filed in the conversation under a question the Bot would have answered by offering to
 * connect — so the connection is read first, as the saved place is for the weather.
 */
type Needs = { place: true } | { connection: string };

type KindSpec = {
  /** The words that make a message worth asking about this kind. */
  words: RegExp;
  /** The words that settle, with nobody asked, that the message is not this kind's read. */
  never?: RegExp;
  tool: string;
  /** The call's arguments. A constant: nothing read from the message or from an answer. */
  args: Readonly<Record<string, unknown>>;
  needs: Needs;
  /** The questions, by a name no other kind uses: they ride in one request together. */
  questions: Record<string, DecisionQuestion>;
  /** How sure the decisions model has to be, per question. */
  bars: Record<string, number>;
};

/**
 * NARROWED 2026-10-05, in one pass, as the calendar's and the mail's were. The weather's list had
 * stood since 2026-10-02 with every word enough alone, and of 347 ordinary messages that want none
 * of this it sent 18: "삼겹살 몇도에서 구워야 맛있어", "따뜻한 말 한마디만 해줘", "바람막이
 * 추천해줘", "에어컨 전기세 아끼는 법". Those are the words below — a temperature, the wind, being
 * hot or cold, clothes, laundry, a boiler — which are the weather only when said of a day or of
 * out of doors. So each needs one of {@link WEATHER_WHEN} beside it: "오늘 춥나?", "밖에 바람 많이
 * 불어?", "내일 반팔 입어도 돼?". The figures, and the wanted messages this leaves, are in
 * `docs/laf/eval-pack.md` "The first move".
 */
const WEATHER_WEAK =
  "온도|몇\\s*도|바람|장화|덥|더워|더울|더운|춥|추워|추울|추운|쌀쌀|따뜻|선선|맑|흐리|흐림|화창|반팔|긴팔|패딩|외투|겉옷|뭐\\s*입|빨래|널어|세차|보일러|에어컨|날이";
const WEATHER_WHEN =
  "오늘|내일|모레|글피|지금|이따|주말|이번\\s*주|아침|점심|저녁|밤|낮|오전|오후|새벽|밖|바깥|나가|나갈|외출|요즘";

/**
 * The words that make a message worth asking about, per kind.
 *
 * Checked before anything is sent: a message with none of these is never shown to the decisions
 * model, which is both the cheaper answer and the one that keeps "every short message" from being
 * true. Wide on purpose and wrong often, which is what the second look is for.
 *
 * WEATHER — "우산 챙겨야 해?", "빨래 널어도 돼?" and "내일 뭐 입지" ask for the forecast without the
 * word 날씨. MEASURED on the labelled set (`evals/first-move-messages.json`, 76 messages that want
 * the forecast for the person's own place): the first list, written from the head, let 51 of them
 * through. This one is that list widened by what it had missed and no further — 비 and 눈 as words
 * of their own, the wind, the humidity, a typo of 날씨. What still does not pass is a plan with no
 * weather word in it at all ("토요일에 공원 피크닉 괜찮을까?"); catching those would mean sending
 * every short message, and the Bot's model answers them as it does today.
 */
const WEATHER_WORDS = new RegExp(
  [
    // The weather by its own words: enough alone.
    "날씨|날시|기온|습도|일교차|체감|불쾌지수|영하|폭염|한파|강수|소나기|장마|우박|안개|우산|우비",
    // 비 and 눈 as words of their own: 비용, 준비, 눈치 and 눈물 are not the weather — and 눈 only
    // where it falls, since "눈이 자꾸 떨리는데" is an eye.
    "(?:^|[\\s,.?!])비(?:\\s|[가는도야]|와|오|온|올|옴|왔|맞|바람|소식)",
    "(?:^|[\\s,.?!])눈(?:이|은|도)?\\s*(?:와|오|온|올|옴|왔|내리|내려|쌓)",
    "비와|비오|눈와|눈오",
    // Words that are the weather only on a day or out of doors: see WEATHER_WHEN.
    // Anywhere in the message: it is sixty characters at most, and people ask in two breaths.
    `(?:${WEATHER_WHEN})[\\s\\S]*?(?:${WEATHER_WEAK})|(?:${WEATHER_WEAK})[\\s\\S]*?(?:${WEATHER_WHEN})`,
    "\\b(?:weather|rain(?:ing|y)?|umbrella|snow(?:ing|y)?|forecast)\\b",
  ].join("|"),
  "i",
);

/**
 * What a weather word is said for when it is not the forecast: a story, a film, a dream, something
 * to buy or to fix. Decided here and never sent, as a write is for the calendar and the mail.
 *
 * The last four — 바꿔, 변경, 설정, 저장 — were added after the first three runs with this list:
 * "내 날씨 지역을 집 주소로 바꿔줘" is a change to a setting, was answered 0.70 on `forecast` once
 * in three, exactly the bar, and moved. A change is not a look, here as for the other two kinds;
 * but it was written after seeing that run, and the doc says so.
 */
const WEATHER_NEVER =
  /줄거리|소설|동화|영화|노래|가사|꿈|추천|브랜드|전기세|요금|고장|수리|써\s*줘|써줘|만들어|바꿔|변경|설정|저장/;

/**
 * CALENDAR — a schedule by its own name, or a day's word beside what a day holds.
 *
 * NARROWED 2026-10-05, after a review of the first lists. They were wide the way the weather's is
 * — 약속, 회의, 시험, 바빠, 뭐 있, "free", each enough alone — and asked the decisions model about
 * 199 of the 283 messages in the calendar's set, 78 of which wanted it: "회의록 요약해줘", "시험
 * 공부 도와줘", "냉장고에 뭐 있지", "일정한 속도로 걸어". Each is a message that leaves the
 * deployment, a fifth of a second before the Bot's model starts and a row in the trail, for nothing
 * — and the owner's condition for this feature is that it cost nothing where it does nothing.
 *
 * So a word qualifies in one of two ways. A SCHEDULE NOUN alone: 일정 (not 일정한, 일정 기간),
 * 스케줄, 캘린더, "schedule", "calendar", "agenda" as whole words. Or a WORD FOR TODAY and, close
 * after it, something a day holds — 약속, 회의, 미팅, 예약, 수업, 시험, being busy or free, "뭐
 * 있" — which is how people ask without the noun ("오늘 뭐 있지", "이따 회의 있나?"). And nothing
 * that marks a change to the calendar ({@link CALENDAR_WRITES}): that is decided here, by rule, and
 * never sent.
 *
 * Measured in `docs/laf/eval-pack.md` "The first move": what each list sends of the messages that
 * do not want it, and of ordinary chat, before and after — and the wanted messages it now leaves.
 */
const TODAY_WORDS = "오늘|지금|이따|오전|오후|아침|점심|저녁|밤에|낮에";
const CALENDAR_WORDS = new RegExp(
  [
    // 일정한 속도, 일정 기간, 일정량 are "constant" and "a certain", not a schedule.
    "일정(?![한하량액]|\\s*(?:기간|부분|금액|수준|비율|간격|속도))|일쩡|스케줄|스케쥴|캘린더",
    // 회의록 and 회의실 are a document and a room; 시험지, 시험관, 시험 삼아 are not an exam today.
    `(?:${TODAY_WORDS})[^.?!]{0,14}?(?:뭐\\s*[있잇]|머\\s*[있잇]|약속|미팅|회의(?![록실])|예약|수업|시험(?![지관]|\\s*삼아)|바빠|바쁘|시간\\s*(?:되|돼)|비어|외근|출장|학원\\s*몇|meeting)`,
    "\\b(?:calendar|schedule|agenda)\\b",
    "\\b(?:what|anything|events?|meetings?|free|have)\\b[^.?!]{0,24}\\b(?:today|tonight|this (?:morning|afternoon|evening))\\b",
    "\\btoday'?s (?:events?|meetings?|appointments?)\\b",
    "\\bmy day\\b",
  ].join("|"),
  "i",
);

/**
 * A change to the calendar, by its verb. A message with one is not a read of today, and is left to
 * the Bot's model without anybody being asked: 잡아줘, 넣어줘, 취소해줘, 미뤄줘, 바꿔줘, 만들어줘.
 */
const CALENDAR_WRITES =
  /잡아|넣어|추가|등록|취소|미뤄|미루|옮겨|바꿔|변경|삭제|지워|만들|짜\s*줘|짜줘|써\s*줘|써줘|작성|보내|추천|\b(?:add|create|book|cancel|move|reschedule|delete|set up|write|schedule an?)\b/i;

/**
 * MAIL — the mailbox by its name, as a word: 메일 (이메일, 지메일), 편지함, 수신함, "mail",
 * "email", "gmail", "inbox", and 멜 only where it stands alone ("멜 온 거 있어?", not 카멜레온,
 * 멜버른, 스멜). Narrowed with the calendar's, for the same reason. What it leaves is a message that
 * names no service ("뭐 온 거 없어?"), "새 매일 왔어?" — 매일 is "every day" everywhere else — and
 * 멜 glued to a verb ("새멜왔나").
 */
const MAIL_WORDS = new RegExp(
  [
    "메일|편지함|수신함",
    "(?:^|\\s)(?:새\\s?|안\\s?읽은\\s?)?멜(?=$|[\\s?!.,~]|[은는이가도을를]|확인)",
    "\\b(?:e-?mails?|gmail|inbox|mail)\\b",
  ].join("|"),
  "i",
);

/**
 * Something done with mail rather than a look at it, by its verb or its object: 보내줘, 써줘, 답장,
 * 초안, 주소, 삭제, 차단. Decided here and never sent — "메일 주소 알려줘" and "메일로 보내줘" are
 * most of what the word 메일 is said for.
 *
 * ONE PASS OVER ORDINARY CHAT, and no more (`evals/first-move-ordinary.json`, 347 messages that
 * want none of this, written by somebody who had not seen these lists): it sent five for the mail
 * and two for the calendar, and 써, 아이디, 계정, 머지 here and 추천 in the calendar's came of
 * reading them. The number in the doc after that pass is the number on the messages it was fitted
 * to; the lists were not gone over again.
 */
const MAIL_WRITES =
  /보내|보낼|써|쓸|작성|답장|회신|전달|초안|주소|아이디|계정|머지|삭제|지워|차단|서명|구독|만들|읽음\s*처리|오면|\b(?:send|write|reply|draft|forward|address|delete|unsubscribe|compose)\b/i;

/**
 * A MESSAGE THAT LEANS ON THE ONE BEFORE IT IS NOT ASKED ABOUT, for any kind.
 *
 * The decisions model is shown one message and nothing of the conversation. "그럼 일정은?" after a
 * turn about tomorrow reads, alone, as today's schedule — every question answers yes, and the move
 * is today's list under a question about tomorrow. What the message refers to is in the thread the
 * Bot's model has and this does not, so a message that opens on a connective, or points back with
 * an anaphor, is left to it before anything is sent, and leaves no row.
 *
 * A short list, on purpose: each word here costs the moves of people who simply talk this way ("또
 * 메일 왔어?"). `first-move.test.ts` walks it.
 */
export const FOLLOW_UP_OPENERS = [
  "그럼",
  "그러면",
  "그리고",
  "그런데",
  "근데",
  "그래서",
  "그건",
  "그거",
  "그게",
  "또",
  "then",
  "and",
  "also",
  "so",
  "what about",
  "how about",
] as const;
export const FOLLOW_UP_ANAPHORS = [
  "그날",
  "그때",
  "거기",
  "아까",
  "그 일정",
  "그 메일",
  "that day",
  "that one",
] as const;
const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FOLLOW_UP = new RegExp(
  [
    // An opener is the message's first word; `또` must not be 또래, nor "so" be "sofa".
    `^\\s*(?:${FOLLOW_UP_OPENERS.map(escaped).join("|")})(?=$|[\\s,.?!~])`,
    FOLLOW_UP_ANAPHORS.map(escaped).join("|"),
    // "일정은?", "메일은요?" — a topic and nothing else is a question about something already said.
    "^\\s*[가-힣A-Za-z]{1,8}[은는](?:요)?\\s*[?？]*\\s*$",
  ].join("|"),
  "i",
);

/** Whether a message leans on the conversation before it. See {@link FOLLOW_UP_OPENERS}. */
export function isFollowUp(text: string): boolean {
  return FOLLOW_UP.test(text);
}

/** The opening every kind's first question shares: what `message` is. */
const MESSAGE_IS =
  "`message` is one chat message a person sent to their assistant, usually in Korean.";

/**
 * The kinds: for each, the words, the call, and the questions that earn it. In English, like every
 * judge's: the model they are measured on reads them best.
 *
 * THE BARS ARE MEASURED, NOT CHOSEN: `bun run eval:first-move` over messages labelled by somebody
 * other than the author of these questions (`evals/first-move-*.json`, `docs/laf/eval-pack.md` "The
 * first move"). Each is set for precision — a wrong move is a lookup nobody asked for, drawn in the
 * conversation as a step — and what it costs in recall is a turn that takes the rounds it takes
 * today.
 */
export const FIRST_MOVE_SPECS: Readonly<Record<FirstMoveKind, KindSpec>> = {
  weather: {
    words: WEATHER_WORDS,
    never: WEATHER_NEVER,
    tool: WEATHER_TOOL_NAME,
    args: Object.freeze({}),
    needs: { place: true },
    questions: {
      forecast: {
        type: "noul",
        instructions: `${MESSAGE_IS} This is true when the person wants to know what the weather is now or will be over the coming few days — temperature, rain or snow, the sky, whether to take an umbrella, what to wear for the weather, whether the weather allows something they plan — or asks for something whose first step is to look at that forecast. It is false when weather words appear without the forecast being wanted: talk about weather that has already happened, a request to build, write or analyse something about weather, a temperature that is not the weather's (an oven, a fever, a room, a drink), an order or a product (an umbrella, a heater, a coat), a mood or a figure of speech. It is false for what a forecast of the next few days cannot answer: last year or last month, next month or a season, the climate, fine dust or yellow dust alone, a typhoon's path, tides, sunrise or sunset times.`,
      },
      ownPlace: {
        type: "noul",
        instructions:
          "This is true when `message` names no specific place, or refers only to where the person is: here, my neighbourhood, near home, the shop, the office, outside. It is false when `message` names any specific place: a city, a district, a neighbourhood, a landmark, a mountain, a region or a country.",
      },
    },
    bars: { forecast: 0.7, ownPlace: 0.7 },
  },
  calendar: {
    words: CALENDAR_WORDS,
    never: CALENDAR_WRITES,
    tool: CALENDAR_TOOL_NAME,
    /*
     * `day: "today"` and nothing else: the tool's own word for the person's whole local day,
     * midnight to midnight in their zone, what has already happened included
     * (`google-calendar-rest.ts`, `listingWindow`). It was `days: 1` for an afternoon, which is
     * this minute to the same minute tomorrow: asked at nine in the evening it left out the day
     * and brought tomorrow morning. The result's first line says the stretch it covers.
     */
    args: Object.freeze({ day: "today" }),
    needs: { connection: CALENDAR_SERVER },
    questions: {
      schedule: {
        type: "noul",
        instructions: `${MESSAGE_IS} This is true when the person wants to be told what is on their own calendar — their schedule, appointments, meetings, classes or reservations they already have — so that the first step is to look at their calendar. It is false when the person wants the calendar changed: something added, booked, moved, cancelled or deleted. It is false when the schedule asked about is not their own calendar's: a train, bus or flight timetable, a sports, broadcast, school or public schedule, opening hours. It is false when the person asks for ideas or for a plan to be made (what to do, what to eat, an itinerary, a timetable to be drawn up), asks how a calendar or an app works, or only mentions a schedule while asking for something else.`,
      },
      today: {
        type: "noul",
        instructions:
          "This is true when `message` is about today only: it says today, now, this morning, this afternoon, this evening, tonight or later today, or it names no day at all. It is false when `message` mentions any other day or span of days — tomorrow, the day after, yesterday, a weekday, a date, this week, the weekend, next week, a month — even together with today. It is false when `message` asks about one particular event, person or thing by name (when the meeting with somebody is, what time the dentist is) rather than for the day's schedule.",
      },
    },
    /*
     * `today` is the higher bar because it is the question that is wrong: at 0.7 "낼 뭐 있지" —
     * tomorrow, in a contraction — moved once in three runs (0.71), and at 0.8 no message its
     * labeller was sure of did. `schedule` said yes 324 times at 0.7 and was right 324 times, and
     * no wrong move appeared down to 0.5 with `today` at 0.8; it stands a step above that.
     */
    bars: { schedule: 0.6, today: 0.8 },
  },
  mail: {
    words: MAIL_WORDS,
    never: MAIL_WRITES,
    tool: MAIL_TOOL_NAME,
    /*
     * ONE FIXED QUERY, in the grammar the tool's own description names ("query는 지메일 검색창과
     * 같은 문법이다"): unread, in the inbox. `is:unread` alone also returns unread mail a filter
     * archived on arrival — mail the person arranged never to be shown — and `in:inbox` alone is
     * every mail whether read or not. Together they are the number Gmail draws beside 받은편지함,
     * which is what "새 메일 왔어?" asks about. `max` is left to the tool's default.
     */
    args: Object.freeze({ query: "is:unread in:inbox" }),
    needs: { connection: MAIL_SERVER },
    questions: {
      mail: {
        type: "noul",
        instructions: `${MESSAGE_IS} This is true when the person wants to be told what e-mail has arrived in their own mailbox, so that the first step is to look at their inbox. It is false when the person wants something done with mail: written, sent, replied to, forwarded, drafted, deleted, archived, marked as read, sorted or unsubscribed from. It is false when it is not e-mail: a text message, KakaoTalk or another messenger, a parcel or the post, a notification. It is false when the person asks how e-mail works, about an address, an account or a setting, or only mentions mail while asking for something else.`,
      },
      unfiltered: {
        type: "noul",
        instructions:
          "This is true when `message` asks only for new, unread or just-arrived e-mail in general, or to check the inbox, with no other condition. It is false when `message` says who the mail is from, what it is about, a subject, an attachment, a kind of mail (an invoice, a statement, a newsletter, a reply), a date or a period, or means one particular mail. It is false when `message` asks for mail that was already read, sent, starred, marked important or caught as spam.",
      },
    },
    /*
     * No bar from 0.5 to 0.9 on either question made a wrong move on a message its labeller was
     * sure of; each stands a step above the lowest that was measured. What the bar on `mail` costs
     * is English — "Any new emails?" is answered 0.52 — which the Bot's model answers as today.
     */
    bars: { mail: 0.6, unfiltered: 0.6 },
  },
};

/** Whether a message has any of the weather's words. Exported for the eval, which measures its recall. */
export function mentionsWeather(text: string): boolean {
  return WEATHER_WORDS.test(text);
}

/**
 * The kinds, of those given, whose words are in a message — in the list's own order, so the
 * request the decisions model is sent is the same for the same message.
 */
export function kindsMentioned(
  text: string,
  among: readonly FirstMoveKind[] = FIRST_MOVES,
): FirstMoveKind[] {
  return FIRST_MOVES.filter((kind) => {
    if (!among.includes(kind)) return false;
    const spec = FIRST_MOVE_SPECS[kind];
    return spec.words.test(text) && !spec.never?.test(text);
  });
}

/**
 * The kinds a message would be asked about, by everything decided before anybody is: its length,
 * whether it leans on the conversation before it, and the words in it. Empty is never sent. One
 * function, so the eval sends exactly what the product would.
 */
export function kindsToAsk(
  text: string,
  among: readonly FirstMoveKind[] = FIRST_MOVES,
): FirstMoveKind[] {
  const said = text.trim();
  if (said.length === 0 || said.length > FIRST_MOVE_MAX_CHARS) return [];
  return isFollowUp(said) ? [] : kindsMentioned(said, among);
}

/** The questions of several kinds as the one request carries them. */
export function questionsFor(
  kinds: readonly FirstMoveKind[],
): Record<string, DecisionQuestion> {
  return Object.assign(
    {},
    ...kinds.map((kind) => FIRST_MOVE_SPECS[kind].questions),
  );
}

const noulOf = (answer: unknown): number =>
  answer && typeof answer === "object" && "noul" in answer
    ? Number((answer as { noul: unknown }).noul)
    : 0;

/**
 * What an answer comes to: the probability per question asked, and the kinds every one of whose
 * questions reached its bar. Exported so the eval scores answers by the rule the product moves by.
 */
export function settleDecision(
  kinds: readonly FirstMoveKind[],
  answers: Record<string, unknown>,
  bars: Partial<Record<FirstMoveKind, Record<string, number>>> = {},
): { decided: Record<string, number>; cleared: FirstMoveKind[] } {
  const decided: Record<string, number> = {};
  const cleared: FirstMoveKind[] = [];
  for (const kind of kinds) {
    const spec = FIRST_MOVE_SPECS[kind];
    const held = bars[kind] ?? spec.bars;
    let clear = true;
    for (const name of Object.keys(spec.questions)) {
      const p = noulOf(answers[name]);
      decided[name] = p;
      // Written so that anything not a number — a missing answer, NaN — is short of the bar.
      if (!(p >= (held[name] ?? 1))) clear = false;
    }
    if (clear) cleared.push(kind);
  }
  return { decided, cleared };
}

/** How long the decision may take. Past it there is no move: the wait would be the saving. */
export const FIRST_MOVE_TIMEOUT_MS = 1_200;

/**
 * Why no move was made, or that one was — closed words, for a counter. The first member is the
 * four that mean the decisions model was asked (`shared/first-move.ts`); the rest, nobody was.
 */
export type FirstMoveVerdict =
  | FirstMoveEnding
  | "not_one_message"
  | "too_long"
  | "follow_up"
  | "no_word"
  | "no_tool"
  | "no_place"
  | "no_connection"
  | "budget_spent"
  | "no_credential";

export type FirstMoveInput = {
  /** What the person sent this turn: their messages and any skill instruction put before them. */
  asked: readonly { role: string; content?: unknown }[];
  /** The names of the tools this turn offers the Bot. */
  toolNames: ReadonlySet<string>;
  /** Whether the person has a saved place — coordinates or words. */
  hasPlace: () => Promise<boolean>;
  /** Whether the person has this service connected, and the connection still works. */
  hasConnection: (serverId: string) => Promise<boolean>;
};

export type FirstMoveDeps = {
  /** The moves this deployment has switched on. Empty is off. */
  moves: readonly FirstMoveKind[];
  /** Jev, bounded and unretried. Null where Jev may not be asked: then nothing here ever moves. */
  ask:
    | ((ask: {
        state: object;
        questions: Record<string, DecisionQuestion>;
        timeoutMs: number;
      }) => Promise<Decision>)
    | null;
  /** A free trial's spent day: nothing is judged, as for every other judge. */
  budgetSpent?: () => Promise<boolean>;
};

/**
 * The state the decisions model is shown: the message, redacted and bounded, and nothing else.
 * Exported so a test can serialise it and look for what must not be in it.
 */
export function firstMoveStateOf(text: string): { message: string } {
  return { message: redactText(text).slice(0, FIRST_MOVE_MAX_CHARS * 2) };
}

type NotReady = "no_tool" | "no_place" | "no_connection";

/**
 * Whether this turn opens with a move, and which.
 *
 * The cheap refusals first, in the order that sends the least: the switch, the shape of what was
 * asked, its length, whether it leans on the message before it, the words in it, whether the Bot
 * holds a tool for them, whether there is a place or a connection to answer from — and only then
 * the question to somebody else, once, about the kinds that are left.
 */
export function createFirstMove(deps: FirstMoveDeps) {
  const on = deps.moves.length > 0 && deps.ask !== null;

  return async function firstMoveFor(input: FirstMoveInput): Promise<{
    move: FirstMove | null;
    verdict: FirstMoveVerdict | "off";
    /** The kinds the decisions model was asked about. Empty when nobody was asked. */
    asked: readonly FirstMoveKind[];
    /** What the decisions model said when it was asked and no move came of it. */
    decided?: Record<string, number>;
  }> {
    const none = <V extends FirstMoveVerdict | "off">(verdict: V) => ({
      move: null,
      verdict,
      asked: [] as FirstMoveKind[],
    });
    if (!on || !deps.ask) return none("off");
    const started = performance.now();
    const say = <V extends FirstMoveVerdict>(
      verdict: V,
      kinds: readonly FirstMoveKind[],
    ): V => {
      // That a move was considered and how it ended — never the message, never a word of it.
      log.info("first_move", {
        verdict,
        kinds: [...kinds],
        ms: Math.round(performance.now() - started),
      });
      return verdict;
    };

    const [only] = input.asked;
    if (
      input.asked.length !== 1 ||
      only?.role !== "user" ||
      typeof only.content !== "string"
    ) {
      // A skill's instruction before the message, or a file with it: not a plain short question.
      return none("not_one_message");
    }
    const text = only.content.trim();
    if (text.length === 0 || text.length > FIRST_MOVE_MAX_CHARS) {
      return none("too_long");
    }
    // What it refers to is in the thread, which the decisions model is not shown.
    if (isFollowUp(text)) return none("follow_up");
    const mentioned = kindsMentioned(text, deps.moves);
    if (mentioned.length === 0) return none("no_word");

    const ready: FirstMoveKind[] = [];
    let short: NotReady | null = null;
    for (const kind of mentioned) {
      const spec = FIRST_MOVE_SPECS[kind];
      const lacks: NotReady | null = !input.toolNames.has(spec.tool)
        ? "no_tool"
        : "place" in spec.needs
          ? // The Bot asks where, as it does today; a call with no place would only be refused.
            (await input.hasPlace().catch(() => false))
            ? null
            : "no_place"
          : (await input
                .hasConnection(spec.needs.connection)
                .catch(() => false))
            ? null
            : "no_connection";
      if (lacks === null) ready.push(kind);
      else short ??= lacks;
    }
    if (ready.length === 0) {
      return none(say(short ?? "no_tool", mentioned));
    }
    if (await deps.budgetSpent?.().catch(() => false)) {
      return none(say("budget_spent", ready));
    }

    const decision = await deps
      .ask({
        state: firstMoveStateOf(text),
        questions: questionsFor(ready),
        timeoutMs: FIRST_MOVE_TIMEOUT_MS,
      })
      .catch(() => null);
    if (decision && !decision.ok && decision.because === "no credential") {
      // Nothing was sent: there was no key to send it with. Not a decision asked for, so it is
      // kept out of the count of them.
      return none(say("no_credential", ready));
    }
    if (!decision?.ok) {
      return { move: null, verdict: say("no_answer", ready), asked: ready };
    }
    const { decided, cleared } = settleDecision(ready, decision.answers);
    const [kind] = cleared;
    if (kind === undefined) {
      return {
        move: null,
        verdict: say("below_bar", ready),
        asked: ready,
        decided,
      };
    }
    if (cleared.length > 1) {
      // Two things asked for in one message. Which first, and what then, is the Bot's model's.
      return {
        move: null,
        verdict: say("ambiguous", ready),
        asked: ready,
        decided,
      };
    }
    say("moved", ready);
    const spec = FIRST_MOVE_SPECS[kind];
    return {
      move: {
        kind,
        tool: spec.tool,
        // A copy of the constant: nothing the decisions model said is in it, or can be.
        args: { ...spec.args },
        asked: ready,
        decided,
      },
      verdict: "moved",
      asked: ready,
    };
  };
}

export type FirstMoveFor = ReturnType<typeof createFirstMove>;

/**
 * The first move as the turn engine asks for it (`engine.ts`, `firstMove`): the decision, fed the
 * facts it needs about this turn and this person, and a row in the trail for what came of asking.
 * The turn is handed what was decided as well as the move, so its own row says the same
 * (`telemetry/run-meter.ts`): which kinds were asked about and how that ended, never the message.
 *
 * Beside the decision rather than in `main.ts`, which only hands these things to each other.
 */
export function firstMoveForTurns(deps: {
  decide: FirstMoveFor;
  whereaboutsOf: (
    userId: string,
  ) => Promise<Pick<Whereabouts, "place" | "coordinates">>;
  /**
   * The services this person has connected, with whether each still works
   * (`plugins/connections.ts`, `connectionsFor` — what the settings page is drawn from).
   */
  connectionsOf: (
    userId: string,
  ) => Promise<readonly { serverId: string; health: { status: string } }[]>;
  auditStore: AuditStore;
}) {
  return async (input: {
    owner: { id: string };
    botId: string;
    asked: readonly { role: string; content?: unknown }[];
    tools: readonly { name: string }[];
  }): ReturnType<FirstMoveFor> => {
    // Read once a turn at most, and only when a kind that needs it got as far as asking.
    let connections: ReturnType<typeof deps.connectionsOf> | null = null;
    const { move, verdict, asked, decided } = await deps.decide({
      asked: input.asked,
      toolNames: new Set(input.tools.map((tool) => tool.name)),
      hasPlace: async () => {
        const at = await deps.whereaboutsOf(input.owner.id);
        return Boolean(at.place?.trim()) || at.coordinates !== null;
      },
      hasConnection: async (serverId) => {
        connections ??= deps.connectionsOf(input.owner.id);
        return (await connections).some(
          (held) => held.serverId === serverId && held.health.status === "ok",
        );
      },
    });
    if (move) {
      // Not awaited: the trail must not be what the person waits on.
      void recordAuditEvent(deps.auditStore, {
        eventType: "turn.first_move",
        targetType: "agent",
        targetId: input.botId,
        actorUserId: input.owner.id,
        payload: {
          bot: input.botId,
          move: move.kind,
          tool: move.tool,
          asked: [...move.asked],
          decided: move.decided,
        },
      }).catch(auditRowLost("turn.first_move"));
    } else if (isFirstMoveEnding(verdict)) {
      // The decisions model was asked and the Bot's model went first anyway. Counted beside the
      // moves, so the trail says how often asking paid: not awaited, and never a word.
      void recordAuditEvent(deps.auditStore, {
        eventType: "turn.first_move_left",
        targetType: "agent",
        targetId: input.botId,
        actorUserId: input.owner.id,
        payload: {
          bot: input.botId,
          asked: [...asked],
          verdict,
          ...(decided ? { decided } : {}),
        },
      }).catch(auditRowLost("turn.first_move_left"));
    }
    return { move, verdict, asked };
  };
}

/** How long the warm-up may take. Nobody waits on it; past this it is simply not warm. */
export const FIRST_MOVE_WARM_UP_TIMEOUT_MS = 5_000;

/**
 * One decision asked at boot, of a sentence nobody sent.
 *
 * WHY. The first decision a fresh process asks takes longer than every later one — the SDK loaded,
 * the name resolved, the connection opened: 1.2–4.4 s when the feature was reviewed, against a
 * bound of {@link FIRST_MOVE_TIMEOUT_MS}. So the first question after every restart made no move,
 * which is the turn it was, and also the saving not had. Asked once here, that cost is paid before
 * anybody is waiting.
 *
 * Asked wherever any move is on, with the questions of every kind that is: whether a person has a
 * calendar or a mailbox connected is not known at boot and need not be, since what is being warmed
 * is the road to the decisions model.
 *
 * The sentence is this file's own, so nothing of a person's leaves for it; the answer is not read.
 * A spent trial day is not judged, here as everywhere. It says how it went and never throws.
 */
export async function warmFirstMove(deps: FirstMoveDeps): Promise<void> {
  if (deps.moves.length === 0 || !deps.ask) return;
  if (await deps.budgetSpent?.().catch(() => false)) return;
  const started = performance.now();
  const decided = await deps
    .ask({
      state: firstMoveStateOf("오늘 날씨 어때?"),
      questions: questionsFor(
        FIRST_MOVES.filter((kind) => deps.moves.includes(kind)),
      ),
      timeoutMs: FIRST_MOVE_WARM_UP_TIMEOUT_MS,
    })
    .catch(() => null);
  log.info("first_move_warmed", {
    answered: decided?.ok === true,
    ms: Math.round(performance.now() - started),
  });
}
