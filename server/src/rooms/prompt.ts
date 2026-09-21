/**
 * What a Bot is shown when it is asked to take a turn in a room.
 *
 * Ported from Grok Bot 0.24's group-chat prompt (`Ecn` / `Scn` in its host), because the shape is
 * the answer to a problem we met from the other side and patched badly. A room has several Bots and
 * one AG-UI `assistant` role, so a Bot reading the room as its own history claims its colleagues'
 * work as its own. The reference never has that problem: the room is not the Bot's history. The
 * Bot answers from ITS OWN conversation, and the room arrives as one tagged user turn — a header,
 * who is present, and the last stretch of what was said.
 *
 * THE WHOLE WINDOW, NOT "SINCE YOU LAST SPOKE". The reference can show a member only what is new,
 * because its members answer from a unified history that already holds what they themselves said.
 * Ours cannot: a member turn is a fresh loop every time, and the private history it carries is the
 * one-to-one conversation, which has no room messages in it. Shown only what arrived since it last
 * spoke, a member would have no idea what IT had said two lines ago — and "do not repeat points
 * already made" is not something you can ask of a Bot that cannot see its own points. So the window
 * is the last `ROOM_LINES`, its own lines marked `(you)`.
 *
 * WHAT A ROOM TURN CONTAINS: this prompt, behind the tail of the Bot's own conversation with this
 * person. The reference's members answer from their unified history and so do ours, with one bound
 * the reference does not have: `private-history.ts` carries the last dozen things said in private
 * and cuts each one, so a room turn's worst-case cost is a known number rather than the length of
 * somebody's conversation. Everything older than that tail is not in front of the Bot, which is
 * why `roomConduct` ends by telling it to ask rather than assume.
 *
 * SPEAKING IS A TOOL CALL, NOT PROSE. Plain text a Bot writes during a room turn is private
 * scratch space; only `send_message` puts words in the room. That is what makes silence
 * unambiguous — a turn with no call is a Bot with nothing to add — and it is what lets a Bot do
 * real work mid-turn (open a page, read a file) without narrating it at everybody.
 *
 * IT IS WRITTEN IN KOREAN, AND THAT IS NOT A TRANSLATION JOB. Everything else a Bot reads is
 * Korean — the base prompt, the room mode (`shared/prompt/mode/room.ko.ts`), the person's own
 * words — and this block used to be the last eight lines of the request, in English, in capitals.
 * Measured on the assembled prompt: a member's request ended `DO NOT reply in plain text …` after
 * a thousand characters of Korean, with every room line tagged `(user)` and `(you)`. The last
 * instruction is the strongest one a model reads, and in a product whose whole surface is Korean
 * the last instruction was in another language.
 *
 * IT SAYS WHY THIS MEMBER IS SPEAKING. `turn-taking.ts` already decides that — the person named
 * it, the person named nobody, or a colleague called it in — and the reason went to the audit row
 * and nowhere else. A Bot pulled in because 재고봇 asked it something got the same prompt as one
 * answering the person, and had to guess from two dozen lines which sentence was for it. That is
 * where "인사·동의·요약" comes from: a member that does not know what it is answering answers the
 * room in general.
 */

/** One line of a room, as the transcript records it. */
export type RoomLine = {
  /** The Bot that said it, or null when the person did. */
  agentId: string | null;
  /** Whoever said it, for the rendered line. */
  name: string;
  text: string;
};

export type RoomMember = {
  id: string;
  name: string;
  /** The Bot's title or role, shown so colleagues know who they are talking to. Optional. */
  description?: string;
};

/**
 * Why a member is being asked to speak.
 *
 * `addressed`: the person named it. `everybody`: the person named nobody, so everybody opens.
 * `named`: a colleague named it in this turn and it has not answered since — the only reason a
 * Bot speaks after the first round.
 *
 * Declared here rather than in `turn-taking.ts`, which decides it, because the prompt is the other
 * thing that reads it and `turn-taking.ts` already imports from this file. It is re-exported there
 * so the rule and its type still read as one thing.
 */
export type SpeakReason = "addressed" | "everybody" | "named";

/** How many lines of the room a Bot is shown at most. The reference's `CNa`. */
export const ROOM_LINES = 24;

/** The header every room turn carries, so a Bot can see at a glance where it is. */
export const ROOM_TAG = "[방: ";

/**
 * The caps, all from the reference, all deliberately small.
 *
 * A room turn is a conversation between models, and a conversation between models does not stop on
 * its own: every one of these exists to end a turn that would otherwise keep finding something to
 * add. `ROOM_ROUNDS` bounds how many times round the table, `ROOM_MESSAGES_PER_TURN` bounds the
 * whole turn whatever the rounds do, and `ROOM_MESSAGES_PER_MEMBER` stops one Bot holding the floor.
 */
export const ROOM_ROUNDS = 3;
export const ROOM_MESSAGES_PER_TURN = 10;
export const ROOM_MESSAGES_PER_MEMBER = 3;
export const ROOM_MEMBERS = 6;
/** With this many slots left, everybody is asked to wrap up. */
export const WIND_DOWN_SLOTS = 2;

/** One line of a room, and one name in it, cut to what a prompt can carry. */
const ROOM_LINE_CHARS = 8000;
const ROOM_NAME_CHARS = 120;

/**
 * What the whole room block may cost, across every line in it.
 *
 * The per-line cut is not a bound on the prompt: twenty-four lines of eight thousand characters is
 * a hundred and ninety-two thousand, and in Korean that is roughly as many tokens — a request no
 * provider accepts, so a room where a few people pasted a few long things would simply stop
 * answering for everybody. This is the bound that actually holds, and it keeps the NEWEST lines,
 * because a conversation is understood from its end.
 */
const ROOM_BLOCK_CHARS = 24_000;

/** `text` cut to `limit` characters, the last one an ellipsis when anything was dropped. */
export function clamp(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit
    ? text
    : `${points.slice(0, limit - 1).join("")}…`;
}

/** What an unnamed person is called in a room line. `users.name` is nullable. */
const PERSON_FALLBACK = "사장님";

function renderLine(line: RoomLine, memberId: string): string {
  /*
   * Both halves are cut. A person can paste a novel into a room and a Bot can answer with one, and
   * a prompt built from two dozen of those is a request no provider accepts — the turn would fail
   * for everybody because of one line.
   *
   * The tags are Korean now. They used to be `(user)` and `(you)`, and a Bot shown
   * `User (user): 지난주 어땠어?` answers a person called "User" — measured on the assembled
   * prompt, in a room whose every other word is Korean.
   */
  const name = clamp(line.name.trim() || PERSON_FALLBACK, ROOM_NAME_CHARS);
  const text = clamp(line.text, ROOM_LINE_CHARS);
  if (line.agentId === null) return `${name}(사람): ${text}`;
  const you = line.agentId === memberId ? "(나)" : "";
  return `${name}${you}: ${text}`;
}

/**
 * The newest lines that fit in `ROOM_BLOCK_CHARS`, rendered, oldest first.
 *
 * Dropping from the front rather than cutting the middle: a room is read from its end, and half a
 * sentence from an hour ago helps nobody. At least one line always survives, because a single line
 * over budget is already cut to `ROOM_LINE_CHARS` and showing nothing would be worse.
 */
function withinBudget(lines: readonly RoomLine[], memberId: string): string[] {
  const kept: string[] = [];
  let spent = 0;
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at];
    if (!line) continue;
    const rendered = renderLine(line, memberId);
    if (kept.length > 0 && spent + rendered.length > ROOM_BLOCK_CHARS) break;
    spent += rendered.length;
    kept.push(rendered);
  }
  return kept.reverse();
}

/**
 * The order members speak in, rotated so the same Bot does not open every round.
 *
 * The reference's `d6i`. Without it the first member by id answers first, every round, every turn —
 * and in a conversation between models whoever speaks first sets the frame for everybody after.
 */
export function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const at = ((by % items.length) + items.length) % items.length;
  return [...items.slice(at), ...items.slice(0, at)];
}

/**
 * The turn itself: the room, who is in it, what has been said since, and whose turn it is.
 *
 * Deliberately one user message rather than several. The Bot's own history is the rest of the
 * request, and a room turn has to read as one thing that arrived — not as a conversation grafted
 * onto its conversation.
 */
export function roomTurnPrompt(input: {
  room: { name: string; description?: string };
  member: RoomMember;
  peers: readonly RoomMember[];
  lines: readonly RoomLine[];
  /** The last round, or nearly out of room: settle what is open rather than opening more. */
  windingDown?: boolean;
  /** Why this member is speaking. Absent reads as the person having named it. */
  reason?: SpeakReason;
  /** The colleague that called it in, BY NAME. Only meaningful with `reason: "named"`. */
  namedBy?: string;
  /**
   * How many members are answering this same round, this one included.
   *
   * Without it every member of a six-Bot room opens with a greeting and a restatement of the
   * question, because each one believes it is the answer rather than one of six. Measured with
   * fakes: `addressedIds` empty asks all six in round 0, and none of them is told the other five
   * are answering the same sentence.
   */
  answeringNow?: number;
}): string {
  const { room, member, peers, lines, windingDown, namedBy } = input;
  const reason = input.reason ?? "addressed";
  const roomName = room.name.trim() || "이름 없는 방";
  const others = peers.filter((peer) => peer.id !== member.id);
  const withWhom =
    others.length > 0
      ? ` — 함께 있는 참가자: ${others.map((peer) => peer.name).join(", ")}`
      : "";
  const parts: string[] = [`${ROOM_TAG}"${roomName}"${withWhom}]`];

  /*
   * Never set today: `channels.description` is the constant "Private agent channel." and no screen
   * offers a room description. Kept in the signature because a room people name and describe is the
   * obvious next thing, and a prompt that has nowhere to put it is the reason it never gets added.
   */
  const description = room.description?.trim();
  if (description) parts.push(`이 방은: ${description}`);

  const introduced = others.filter((peer) => peer.description?.trim());
  if (introduced.length > 0) {
    parts.push(
      `참가자: ${introduced
        .map((peer) => `${peer.name}(${peer.description?.trim()})`)
        .join(", ")}`,
    );
  }

  const recent = withinBudget(lines.slice(-ROOM_LINES), member.id);
  if (recent.length === 0) {
    parts.push("아직 방에서 오간 말이 없다.");
  } else {
    parts.push("지금까지 방에서 오간 말 (오래된 것부터):");
    parts.push(recent.join("\n"));
  }

  /*
   * THE LAST WORDS IN THE REQUEST, AND BLUNT ON PURPOSE.
   *
   * A Bot arrives here carrying its own system prompt, which ends by telling it to say what it
   * found in plain language — sensible everywhere else in the product and exactly wrong in a room.
   * Measured: with a polite "say something with send_message if you like", both members answered in
   * prose and the room stayed empty. The instruction has to be unmistakable and it has to be last.
   */
  parts.push("", `${clamp(member.name, ROOM_NAME_CHARS)}, 네 차례다.`);

  /*
   * WHAT THIS MEMBER IS ANSWERING, IN ONE LINE. The three reasons are three different turns and
   * used to be one prompt: `named` is a colleague's question that is sitting unanswered in the
   * lines above, `everybody` is one of several parallel answers to the person, and `addressed` is
   * the person asking this Bot in particular.
   */
  if (reason === "named" && namedBy) {
    parts.push(
      `${namedBy}${asSubject(namedBy)} 너를 불렀다. 방의 말 중 너에게 온 것에 먼저 답한다.`,
    );
  } else if (reason === "everybody") {
    const answering = input.answeringNow ?? 0;
    parts.push(
      answering > 1
        ? `사람이 아무도 지목하지 않아서 이번 바퀴에는 ${answering}명이 같은 질문에 함께 답한다. 인사와 질문 되풀이는 빼고, 네 담당인 부분만 말한다. 남이 이미 말한 것은 다시 말하지 않는다.`
        : "사람이 아무도 지목하지 않았다. 네 담당인 부분만 말한다.",
    );
  } else {
    parts.push("사람이 너를 지목했다. 그 질문에 답한다.");
  }

  parts.push(
    "그냥 쓴 글은 방의 누구에게도 보이지 않는다. 한마디라도 하려면 send_message 툴을 불러야 한다.",
    "보탤 것이 없으면 아무것도 부르지 말고 차례를 끝낸다. 그것이 침묵이고, 제대로 된 답이다.",
    /*
     * The turn-taking rule, said to the one party that can work it: after the first round only a
     * colleague somebody NAMED speaks again (`turn-taking.ts`). Said in Korean and with the shape
     * spelled out, because the rule was stated only in English and only here — while the Korean
     * conduct said "call their name if it helps" — and a model writing Korean answers what it was
     * asked in Korean. Measured on nine sentences of the kind these prompts produce: four named
     * nobody, "리뷰봇님은 어떻게 보세요?" among them, and the room ended one round in.
     */
    "동료의 답이 필요하면 보내는 말 안에서 `@이름`으로 부른다. 이번 차례에 다시 말할 수 있는 동료는 누군가가 그렇게 부른 동료뿐이다.",
  );
  if (windingDown) {
    /*
     * IT USED TO ASK FOR SILENCE — "reply only if it's essential, otherwise stay silent" — so the
     * last round of a room was usually empty and the conversation simply stopped mid-air. Asking
     * to CLOSE rather than to be quiet is what makes a turn end instead of run out.
     */
    parts.push(
      "이번이 이 차례의 마지막 바퀴다. 새 주제나 새 질문을 열지 말고, 네가 맡은 것만 한 문장으로 맺는다. 맺을 것이 없으면 침묵.",
    );
  }
  return parts.join("\n");
}

/**
 * "…가" or "…이", for a name this file did not choose.
 *
 * The same reason `shared/prompt/particles.ts` exists: the names are the person's, so a prompt
 * that picks one particle is wrong half the time — and "재고봇이 너를 불렀다" against
 * "매출봇가 너를 불렀다" is the Bot's own first sentence reading as broken Korean. Kept here
 * rather than imported because the server's room prompt is the only caller and the shared file's
 * two helpers are `이다`/`으로`, neither of which is this one.
 */
function asSubject(word: string): string {
  const last = word.trim().at(-1) ?? "";
  const code = last.codePointAt(0) ?? 0;
  const isHangulSyllable = code >= 0xac00 && code <= 0xd7a3;
  // A non-Hangul last character (a Latin name, a digit) takes the with-final-consonant form.
  if (!isHangulSyllable) return "이";
  return (code - 0xac00) % 28 === 0 ? "가" : "이";
}

/*
 * `roomConduct` used to live here and is now `shared/prompt/mode/room.ko.ts`, in Korean.
 *
 * The protocol is unchanged — `send_message` is still the only thing the room can see — but the
 * words moved because they were half of a contradiction: the base prompt told a Bot to answer "in
 * plain language" and this told it plain text is invisible, and the two arrived in the same
 * request from two files that had never read each other. The base no longer says it; the room mode
 * owns it, and both are composed in one place.
 */
