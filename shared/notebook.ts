/**
 * 수첩 — what a Bot knows about the shop and its owner, as one list the owner can read and fix.
 *
 * Shared because three places must agree on it: the server decides which lines reach the prompt,
 * the surface shows which ones do, and the prompt draws them. A line the screen says is carried
 * and the prompt leaves out is a control that saves and does nothing.
 */

/**
 * The most a Bot may remember about one person, in characters, across every line it carries.
 *
 * Counted on the words the person sees, not on the drawn line: the gauge on 수첩 is this number.
 * 2,200 is Hermes Agent's figure for the same list. Measured on MiMo-V2.6-Pro (2026-09-26), prompt
 * tokens over a Bot with none: 63 ordinary sentences filling the cap (2,192 characters) cost
 * 1,769; the worst shape, 220 lines of ten characters (1,980), cost 2,230 — each line's "- " and
 * newline are the difference. Bounded either way, and frozen per epoch, so no count is needed.
 *
 * WHY THERE IS NO `memory_search` (the memory package, 2026-09-26). Muse keeps a curated sheet in the
 * prompt and searches the rest; a search tool earns its place only when memories exceed what the
 * frozen layer carries. Here they cannot: `remember` refuses a line past this cap
 * (`MemoryFullError`), so every line written through the store fits and `carriedLines` carries all
 * of them — `carried: false` is reachable only by a row written around the store. A search would find
 * nothing the prompt does not already hold, and as a core tool it would ride in front of every turn
 * (CLAUDE.md, the footprint ladder); offered only when the cap is reached, it would change the tool
 * list mid-conversation. Revisit when the cap is raised past what one epoch should carry.
 */
export const MEMORY_CHARACTER_CAP = 2_200;

/** How long one line may be. Long enough for a sentence, short enough to read in a list. */
export const MAX_MEMORY_LENGTH = 400;

/**
 * The shop's named lines on 수첩. The rest of what the shop is — the kind, the places, the
 * location — is 내 가게's, and 수첩 reads it from there rather than keeping a second copy.
 */
export const NOTEBOOK_SLOTS = ["shop_name", "hours", "offer"] as const;
export type NotebookSlot = (typeof NOTEBOOK_SLOTS)[number];

export const isNotebookSlot = (value: unknown): value is NotebookSlot =>
  typeof value === "string" &&
  (NOTEBOOK_SLOTS as readonly string[]).includes(value);

/** The label a slot's line is drawn with in the prompt. The surface has its own words. */
export const SLOT_LABEL_KO: Readonly<Record<NotebookSlot, string>> = {
  shop_name: "가게 이름",
  hours: "영업시간",
  offer: "파는 것",
};

/** Who wrote a line. Decided by the route it came through, never by the body. */
export type MemorySource = "bot" | "owner";

/** One line as the carry rule needs it. */
export type NotebookLine = {
  id: string;
  content: string;
  slot: NotebookSlot | null;
  source: MemorySource;
  /** The owner's own line, or a Bot's line the owner said is right. */
  confirmed: boolean;
  createdAt: Date | string;
};

/** A line as the Bot reads it: a slot's line carries its label. */
export function drawnLine(
  line: Pick<NotebookLine, "content" | "slot">,
): string {
  const text = line.content.trim();
  return line.slot ? `${SLOT_LABEL_KO[line.slot]}: ${text}` : text;
}

const time = (value: Date | string) => new Date(value).getTime();

/**
 * The lines in the order the prompt carries them: the shop's named lines, then the rest the owner
 * wrote or confirmed, then what the Bot learned on its own — each oldest first.
 */
export function carryOrder<T extends NotebookLine>(lines: readonly T[]): T[] {
  const rank = (line: T) => (line.slot ? 0 : line.confirmed ? 1 : 2);
  return [...lines].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      time(a.createdAt) - time(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Which lines reach the prompt, in carry order, and how many characters the whole list holds.
 *
 * REPLACES A COUNT OF FORTY. Reads used to keep the oldest forty rows while writes were bounded
 * by characters, so a Bot holding forty-one short lines saved the forty-first and never read it
 * (harness review 2026-09, item 10). The character cap is what bounds the prompt, so it is the
 * one bound: a line is carried while the list so far fits under it. Writes refuse past the cap,
 * so on a list written through the store every line is carried; the rule still says what happens
 * if one is not, and 수첩 draws that line as not reaching the Bot.
 */
export function carriedLines<T extends NotebookLine>(
  lines: readonly T[],
): { carried: T[]; used: number; cap: number } {
  const carried: T[] = [];
  let used = 0;
  let room = MEMORY_CHARACTER_CAP;
  for (const line of carryOrder(lines)) {
    const length = line.content.trim().length;
    used += length;
    if (length <= room) {
      carried.push(line);
      room -= length;
    } else {
      // Nothing after a line that did not fit is carried either: the order is the priority.
      room = -1;
    }
  }
  return { carried, used, cap: MEMORY_CHARACTER_CAP };
}

/**
 * How sure the Bot can be of a line, from who stands behind it — drawn on 수첩 beside the line.
 *
 * `owner`: the owner wrote it. `owner_confirmed`: the Bot wrote it and the owner said it is right.
 * `evidence`: the Bot wrote it and the hourly curation found the owner's own words saying it
 * (`server/src/agents/memory-curation.ts`) — confirmed by evidence, which is not the owner's word.
 * `inferred`: the Bot wrote it and nothing has checked it yet, or there was nothing to check against.
 */
export type MemoryTrust = "owner" | "owner_confirmed" | "evidence" | "inferred";

/** The support a curated line needs to be confirmed by evidence, and below which it is dropped. */
export const EVIDENCE_KEEP = 0.5;

/** How much of the owner's words a line keeps as its evidence. Enough to recognise the moment. */
export const EVIDENCE_EXCERPT_LENGTH = 120;

/** Where a line came from, as 수첩 draws "어디서 알게 됐나". */
export type MemoryEvidence = {
  trust: MemoryTrust;
  /** The curation's probability that the owner's words say it, when it was checked. */
  confidence: number | null;
  /** The conversation on screen and the owner's message in it, to jump to. */
  channelId: string | null;
  messageId: string | null;
  /** The owner's words there, redacted and short. */
  excerpt: string | null;
};

export function trustOf(line: {
  source: string;
  confirmedAt: Date | string | null;
  curatedAt: Date | string | null;
  confidence: number | null;
}): MemoryTrust {
  if (line.source === "owner") return "owner";
  if (line.confirmedAt) return "owner_confirmed";
  if (
    line.curatedAt &&
    line.confidence !== null &&
    line.confidence >= EVIDENCE_KEEP
  ) {
    return "evidence";
  }
  return "inferred";
}

/**
 * STANDING GUIDANCE'S BOUNDS: a few short lines about how the owner likes to work. Small enough
 * that the frozen layer's cost is a rounding error beside the memories (5 × 100 characters), and
 * few enough that the owner reads every one on 수첩.
 */
export const MAX_GUIDANCE_LINES = 5;
export const MAX_GUIDANCE_LENGTH = 100;
