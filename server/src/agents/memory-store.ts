import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  carriedLines,
  drawnLine,
  isNotebookSlot,
  MAX_MEMORY_LENGTH,
  MEMORY_CHARACTER_CAP,
  type MemoryEvidence,
  type MemorySource,
  type NotebookLine,
  type NotebookSlot,
  trustOf,
} from "../../../shared/notebook";
import type { Database } from "../db/client";
import { agentMemories, agentProfiles, channelThreads } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import { createGuidanceStore, type GuidanceStore } from "./guidance-store";

export { MAX_MEMORY_LENGTH, MEMORY_CHARACTER_CAP };

/** One line of 수첩, as the person reading the list sees it. */
export type AgentMemory = {
  id: string;
  content: string;
  createdAt: Date;
  /** Who wrote the words. */
  source: MemorySource;
  /** The owner's own line, or a Bot's line the owner said is right. */
  confirmed: boolean;
  /** One of the shop's named lines, or null. */
  slot: NotebookSlot | null;
  /** Whether the line reaches the prompt (`carriedLines`). */
  carried: boolean;
  /** Where it came from and who stands behind it: 수첩's "어디서 알게 됐나". */
  evidence: MemoryEvidence;
};

/**
 * What one Bot carries into a conversation about one person, drawn: the lines in carry order, the
 * ones the owner wrote or confirmed, and the corrections made on 수첩 (old line → the line now).
 */
export type CarriedMemories = {
  memories: string[];
  confirmed: string[];
  superseded: Record<string, string>;
  /**
   * Lines the hourly curation took out lately, drawn. A running epoch keeps carrying them until it
   * ends — curation is off the critical path and never breaks a conversation's cache on its own —
   * so the epoch logic reads these as "gone quietly", not as a forgetting (`context/conversations.ts`).
   */
  retired: string[];
};

/** A row as the notebook reads it. `forgottenAt` and `replacedBy` only matter for corrections. */
export type MemoryRow = {
  id: string;
  agentId: string;
  content: string;
  createdAt: Date;
  source: string;
  confirmedAt: Date | null;
  slot: string | null;
  forgottenAt: Date | null;
  replacedBy: string | null;
  forgottenBy: string | null;
  evidenceThreadId: string | null;
  evidenceMessageId: string | null;
  evidenceExcerpt: string | null;
  curatedAt: Date | null;
  confidence: number | null;
};

/** Where a Bot's line was learned, as the server found it when `remember` landed. */
export type MemoryEvidenceInput = {
  threadId: string;
  messageId: string;
  excerpt: string | null;
};

/** How long a curation's retirement is remembered for the epoch logic. Past it, a day has turned. */
const RETIRED_WINDOW_MS = 7 * 24 * 60 * 60_000;

const lineOf = (row: MemoryRow): NotebookLine & { createdAt: Date } => ({
  id: row.id,
  content: row.content,
  createdAt: row.createdAt,
  slot: isNotebookSlot(row.slot) ? row.slot : null,
  source:
    row.source === "owner" ? "owner" : row.source === "night" ? "night" : "bot",
  confirmed: row.source === "owner" || row.confirmedAt !== null,
});

/** Who stands behind a row, and where it was learned. The channel is the caller's to resolve. */
const evidenceOf = (
  row: MemoryRow,
  channelOf: ReadonlyMap<string, string> = new Map(),
): MemoryEvidence => ({
  trust: trustOf(row),
  // A `real` column reads back as 0.9800000190734863; two places are all a judge's number means.
  confidence:
    row.confidence === null ? null : Math.round(row.confidence * 100) / 100,
  channelId: row.evidenceThreadId
    ? (channelOf.get(row.evidenceThreadId) ?? null)
    : null,
  messageId: row.evidenceMessageId,
  excerpt: row.evidenceExcerpt,
});

/** The live lines with whether each is carried: the carried ones in carry order, then the rest. */
function notebookOf(
  rows: readonly MemoryRow[],
  channelOf?: ReadonlyMap<string, string>,
): AgentMemory[] {
  const live = rows.filter((row) => row.forgottenAt === null);
  const byId = new Map(live.map((row) => [row.id, row]));
  const lines = live.map(lineOf);
  const { carried } = carriedLines(lines);
  const reaching = new Set(carried.map((line) => line.id));
  const rest = lines.filter((line) => !reaching.has(line.id));
  return [...carried, ...rest].flatMap((line) => {
    const row = byId.get(line.id);
    return row
      ? [
          {
            ...line,
            carried: reaching.has(line.id),
            evidence: evidenceOf(row, channelOf),
          },
        ]
      : [];
  });
}

/**
 * Forgotten by the owner's own hand or edit — the rows that say what the owner meant. A row from
 * before `forgotten_by` has none, and every forgetting then was the owner's.
 */
const byOwner = (row: MemoryRow) =>
  row.forgottenBy === null ||
  row.forgottenBy === "owner" ||
  row.forgottenBy === "revision";

/**
 * What the prompt carries, drawn, from one Bot's rows for one person — live and corrected.
 *
 * A correction is followed to the line that stands now, so two edits before the next message read
 * as one: "10시" → "9시" → "8시" tells a conversation that last heard "10시" that it is "8시".
 * A chain that ends in a forgotten line is a forgetting, and says nothing here.
 */
export function carriedMemoriesOf(rows: readonly MemoryRow[]): CarriedMemories {
  const lines = notebookOf(rows).filter((line) => line.carried);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const superseded: Record<string, string> = {};
  for (const row of rows) {
    /*
     * An owner's correction only. A newer line of the Bot's that the curation found replacing an
     * older one is not the owner correcting anything, and the reminder would say it was.
     */
    if (row.forgottenAt === null || !row.replacedBy || !byOwner(row)) continue;
    let next = byId.get(row.replacedBy);
    const seen = new Set([row.id]);
    while (next && next.forgottenAt !== null && next.replacedBy) {
      if (seen.has(next.id)) break;
      seen.add(next.id);
      next = byId.get(next.replacedBy);
    }
    if (next && next.forgottenAt === null) {
      superseded[drawnLine(lineOf(row))] = drawnLine(lineOf(next));
    }
  }
  return {
    memories: lines.map(drawnLine),
    confirmed: lines.filter((line) => line.confirmed).map(drawnLine),
    superseded,
    retired: rows
      .filter(
        (row) => row.forgottenAt !== null && row.forgottenBy === "curation",
      )
      .map((row) => drawnLine(lineOf(row))),
  };
}

const ROW_COLUMNS = {
  id: agentMemories.id,
  agentId: agentMemories.agentId,
  content: agentMemories.content,
  createdAt: agentMemories.createdAt,
  source: agentMemories.source,
  confirmedAt: agentMemories.confirmedAt,
  slot: agentMemories.slot,
  forgottenAt: agentMemories.forgottenAt,
  replacedBy: agentMemories.replacedBy,
  forgottenBy: agentMemories.forgottenBy,
  evidenceThreadId: agentMemories.evidenceThreadId,
  evidenceMessageId: agentMemories.evidenceMessageId,
  evidenceExcerpt: agentMemories.evidenceExcerpt,
  curatedAt: agentMemories.curatedAt,
  confidence: agentMemories.confidence,
};

/**
 * Every row the notebook reads for these Bots and this person: the live ones, the ones an edit
 * replaced, and the ones the curation retired this week. One query for every Bot, because this
 * runs on every turn.
 */
export async function selectNotebookRows(
  database: Database,
  agentIds: readonly string[],
  ownerUserId: string,
  now: Date = new Date(),
): Promise<MemoryRow[]> {
  if (agentIds.length === 0) return [];
  return database
    .select(ROW_COLUMNS)
    .from(agentMemories)
    .where(
      and(
        inArray(agentMemories.agentId, [...agentIds]),
        eq(agentMemories.ownerUserId, ownerUserId),
        or(
          isNull(agentMemories.forgottenAt),
          isNotNull(agentMemories.replacedBy),
          and(
            eq(agentMemories.forgottenBy, "curation"),
            gt(
              agentMemories.forgottenAt,
              new Date(now.getTime() - RETIRED_WINDOW_MS),
            ),
          ),
        ),
      ),
    );
}

/**
 * The lines the owner forgot on 수첩 — not the ones an edit replaced, not the curation's — drawn,
 * newest first. What a day's summary must never carry again and what `remember` must not write
 * back (`context/day-close.ts`, `agents/memory-curation.ts`).
 */
export async function ownerForgottenLines(
  database: Database,
  agentId: string,
  ownerUserId: string,
  limit = 50,
): Promise<string[]> {
  return (await ownerForgottenRows(database, agentId, ownerUserId, limit)).map(
    (row) => row.line,
  );
}

/**
 * {@link ownerForgottenLines} for a Bot, whoever its owner is: what a day's close is told. A
 * package's Bot, which belongs to nobody in particular, has none.
 */
export function forgottenForBot(database: Database) {
  return async (botId: string): Promise<string[]> => {
    const [profile] = await database
      .select({ ownerUserId: agentProfiles.ownerUserId })
      .from(agentProfiles)
      .where(eq(agentProfiles.agentId, botId));
    return profile?.ownerUserId
      ? ownerForgottenLines(database, botId, profile.ownerUserId)
      : [];
  };
}

/** {@link ownerForgottenLines} with when each was forgotten. */
export async function ownerForgottenRows(
  database: Database,
  agentId: string,
  ownerUserId: string,
  limit = 50,
): Promise<Array<{ line: string; at: Date }>> {
  const rows = await database
    .select({
      content: agentMemories.content,
      slot: agentMemories.slot,
      forgottenAt: agentMemories.forgottenAt,
    })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.ownerUserId, ownerUserId),
        eq(agentMemories.forgottenBy, "owner"),
      ),
    )
    .orderBy(sql`${agentMemories.forgottenAt} desc`)
    .limit(limit);
  return rows.map((row) => ({
    line: drawnLine({
      content: row.content,
      slot: isNotebookSlot(row.slot) ? row.slot : null,
    }),
    at: row.forgottenAt ?? new Date(0),
  }));
}

/** The owner had this very line forgotten; `remember` does not write it back. */
export class MemoryForgottenError extends Error {
  constructor() {
    super("The owner had this memory forgotten.");
    this.name = "MemoryForgottenError";
  }
}

/** The memory is at its cap and one more fact would not fit. Carries the numbers, not a sentence. */
export class MemoryFullError extends Error {
  constructor(
    readonly used: number,
    readonly cap: number,
  ) {
    super(`This Bot's memory holds ${used} of ${cap} characters.`);
    this.name = "MemoryFullError";
  }
}

/*
 * The four filters live in `shared/memory-guards.ts` since the company hub refuses team-memory
 * proposals with them too. Re-exported here unchanged, so every caller on this side reads them
 * from where it always has.
 */
export {
  looksLikeAnInstruction,
  looksLikeAStandingOrder,
  looksLikeASecret,
  looksLikePromptStructure,
} from "../../../shared/memory-guards";

export type AgentMemoryStore = {
  /** Every line this Bot still holds about this person, in carry order, with what is carried. */
  list(agentId: string, ownerUserId: string): Promise<AgentMemory[]>;
  /**
   * Append one line. Returns null when the text is empty or too long to be one.
   *
   * Throws {@link MemoryFullError} when the line would take the memory past
   * {@link MEMORY_CHARACTER_CAP}: unlike an empty or an overlong fact, a full memory is not a
   * property of the text, and the caller has to say something different about it.
   *
   * `source` is the route's to decide: `/memories` is the Bot's tool, `/notebook` is the owner.
   * `evidence` is the server's, found in the conversation the tool ran in — never the tool's.
   *
   * Throws {@link MemoryForgottenError} when a Bot writes back, word for word, a line the owner
   * had forgotten: the owner's own message saying it may still be in today's history.
   */
  remember(
    agentId: string,
    ownerUserId: string,
    content: string,
    options?: {
      source?: MemorySource;
      slot?: NotebookSlot | null;
      evidence?: MemoryEvidenceInput | null;
    },
  ): Promise<AgentMemory | null>;
  /**
   * Replace one line with new words — soft, like forgetting: the old row is forgotten and points
   * at the new one, which is the owner's. Null when there is no such live line or the words are
   * empty or too long. Throws {@link MemoryFullError} when the new words would not fit where the
   * old ones stood.
   */
  revise(
    agentId: string,
    id: string,
    ownerUserId: string,
    content: string,
  ): Promise<AgentMemory | null>;
  /** Say a Bot's line is right. Whether a live line was found. */
  confirm(agentId: string, id: string, ownerUserId: string): Promise<boolean>;
  /** The id of the live line in a shop slot, if there is one. */
  slotLine(
    agentId: string,
    ownerUserId: string,
    slot: NotebookSlot,
  ): Promise<string | null>;
  /**
   * Stop carrying one fact.
   *
   * Returns the line as the Bot read it when a row was actually cleared, and null otherwise, so a
   * caller can tell "forgotten" from "no such row" — reporting success for an id that matched
   * nothing is how a Forget button convinces somebody a thing is gone when it is still being read
   * every turn. The line is what the caller then takes out of the day summaries.
   *
   * The deletion is on record: the row keeps its words, `forgotten_at` and `forgotten_by = owner`.
   */
  forget(
    id: string,
    ownerUserId: string,
  ): Promise<{ agentId: string; line: string } | null>;
  /**
   * How the owner likes to work (`./guidance-store.ts`). Optional so a stand-in store in a test
   * need not carry one; the real store always does.
   */
  guidance?: GuidanceStore;
};

/** The characters one Bot's live lines take for one person. */
async function usedCharacters(
  database: Database,
  agentId: string,
  ownerUserId: string,
): Promise<number> {
  const [usage] = await database
    .select({
      used: sql<number>`coalesce(sum(length(${agentMemories.content})), 0)`,
    })
    .from(agentMemories)
    .where(
      and(
        eq(agentMemories.agentId, agentId),
        eq(agentMemories.ownerUserId, ownerUserId),
        isNull(agentMemories.forgottenAt),
      ),
    );
  return Number(usage?.used ?? 0);
}

const asMemory = (row: MemoryRow): AgentMemory => ({
  ...lineOf(row),
  carried: true,
  evidence: evidenceOf(row),
});

/** The conversations the evidence names, as the screen opens them. */
async function channelsOf(
  database: Database,
  ownerUserId: string,
  rows: readonly MemoryRow[],
): Promise<Map<string, string>> {
  const threads = [
    ...new Set(
      rows.flatMap((row) =>
        row.evidenceThreadId ? [row.evidenceThreadId] : [],
      ),
    ),
  ];
  if (threads.length === 0) return new Map();
  const found = await database
    .select({
      threadId: channelThreads.threadId,
      channelId: channelThreads.channelId,
    })
    .from(channelThreads)
    .where(
      and(
        eq(channelThreads.userId, ownerUserId),
        inArray(channelThreads.threadId, threads),
      ),
    );
  return new Map(found.map((row) => [row.threadId, row.channelId]));
}

/** What the memory store is told of the rest of the server, where it has to be. */
export type MemoryHooks = {
  /**
   * Where a Bot's `remember` is being learned: the conversation it runs in and the owner message it
   * answers (`context/conversations.ts`, `questionOf`). Absent or null: no evidence is recorded.
   */
  evidenceFor?: (agentId: string) => MemoryEvidenceInput | null;
  /** After the owner forgot a line: out of the day summaries, and a receipt. */
  afterForget?: (input: {
    agentId: string;
    ownerUserId: string;
    line: string;
  }) => Promise<void>;
};

/** How long 잊기 waits for the summaries to be scrubbed before it answers. */
const AFTER_FORGET_WAIT_MS = 20_000;

export function createAgentMemoryStore(
  database: Database,
  hooks: MemoryHooks = {},
): AgentMemoryStore {
  const guidance = createGuidanceStore(database);
  const liveRow = async (agentId: string, id: string, ownerUserId: string) => {
    const [row] = await database
      .select(ROW_COLUMNS)
      .from(agentMemories)
      .where(
        and(
          eq(agentMemories.id, id),
          eq(agentMemories.agentId, agentId),
          eq(agentMemories.ownerUserId, ownerUserId),
          isNull(agentMemories.forgottenAt),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  return {
    async list(agentId, ownerUserId) {
      const rows = await selectNotebookRows(database, [agentId], ownerUserId);
      return notebookOf(
        rows,
        await channelsOf(
          database,
          ownerUserId,
          rows.filter((row) => row.forgottenAt === null),
        ),
      );
    },

    async remember(agentId, ownerUserId, content, options = {}) {
      const text = content.trim();
      const source = options.source ?? "bot";
      // The Bot's line carries where it was learned, found here and never taken from the tool.
      const evidence =
        options.evidence !== undefined
          ? options.evidence
          : source !== "owner"
            ? (hooks.evidenceFor?.(agentId) ?? null)
            : null;
      if (!text || text.length > MAX_MEMORY_LENGTH) return null;

      /*
       * A LINE ALREADY THERE IS NOT WRITTEN TWICE. Measured on MiMo (2026-09-26): told by a reminder
       * that the owner had corrected the hours on 수첩, the Bot `remember`ed the same sentence again,
       * and the list held it twice — twice the characters against the cap, and a second copy the
       * owner would have to find and forget when the hours change next. Compared as the Bot reads
       * it, so "영업시간: …" matches the shop's hours line.
       */
      const flat = (value: string) => value.replace(/\s+/g, " ").trim();
      const standing = (
        await selectNotebookRows(database, [agentId], ownerUserId)
      ).find(
        (row) =>
          row.forgottenAt === null &&
          flat(drawnLine(lineOf(row))) === flat(text),
      );
      if (standing) return asMemory(standing);

      /*
       * NOR WHAT THE OWNER HAD FORGOTTEN. Their own message saying it can still be in today's
       * history until the day's close, and a Bot reading it would write it straight back — the
       * forgetting undone by the next turn. Word for word here; a paraphrase is the hourly
       * curation's to catch (`agents/memory-curation.ts`).
       */
      // The close's night line is held to this too (`standing-facts.ts`): the owner's word on 수첩 wins.
      if (source !== "owner") {
        const forgotten = await ownerForgottenLines(
          database,
          agentId,
          ownerUserId,
          200,
        );
        if (forgotten.some((line) => flat(line) === flat(text))) {
          throw new MemoryForgottenError();
        }
      }

      /*
       * Counted on the way in rather than trimmed on the way out, so the Bot learns the memory is
       * full at the moment it tries to add to it, and the person's list never silently loses its
       * oldest line. Read-then-insert without a lock: one server process per VM, and a Bot writes
       * one fact per tool call, so two writes for one person do not race here.
       */
      const used = await usedCharacters(database, agentId, ownerUserId);
      if (used + text.length > MEMORY_CHARACTER_CAP) {
        throw new MemoryFullError(used, MEMORY_CHARACTER_CAP);
      }

      const [row] = await database
        .insert(agentMemories)
        .values({
          id: `memory_${crypto.randomUUID()}`,
          agentId,
          ownerUserId,
          content: text,
          source,
          slot: options.slot ?? null,
          ...(evidence
            ? {
                evidenceThreadId: evidence.threadId,
                evidenceMessageId: evidence.messageId,
                evidenceExcerpt: evidence.excerpt,
              }
            : {}),
        })
        .returning(ROW_COLUMNS);
      return row ? asMemory(row) : null;
    },

    async revise(agentId, id, ownerUserId, content) {
      const text = content.trim();
      if (!text || text.length > MAX_MEMORY_LENGTH) return null;
      const old = await liveRow(agentId, id, ownerUserId);
      if (!old) return null;
      const used = await usedCharacters(database, old.agentId, ownerUserId);
      if (used - old.content.length + text.length > MEMORY_CHARACTER_CAP) {
        throw new MemoryFullError(used, MEMORY_CHARACTER_CAP);
      }
      const newId = `memory_${crypto.randomUUID()}`;
      const row = await database.transaction(async (tx) => {
        const [written] = await tx
          .insert(agentMemories)
          .values({
            id: newId,
            agentId: old.agentId,
            ownerUserId,
            content: text,
            // The words are the owner's now, whoever wrote the line they replace.
            source: "owner",
            slot: old.slot,
            supersedes: old.id,
          })
          .returning(ROW_COLUMNS);
        await tx
          .update(agentMemories)
          .set({
            forgottenAt: new Date(),
            forgottenBy: "revision",
            replacedBy: newId,
            updatedAt: new Date(),
          })
          .where(eq(agentMemories.id, old.id));
        return written;
      });
      return row ? asMemory(row) : null;
    },

    async confirm(agentId, id, ownerUserId) {
      const confirmed = await database
        .update(agentMemories)
        .set({ confirmedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(agentMemories.id, id),
            eq(agentMemories.agentId, agentId),
            eq(agentMemories.ownerUserId, ownerUserId),
            isNull(agentMemories.forgottenAt),
          ),
        )
        .returning({ id: agentMemories.id });
      return confirmed.length > 0;
    },

    async slotLine(agentId, ownerUserId, slot) {
      const [row] = await database
        .select({ id: agentMemories.id })
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.agentId, agentId),
            eq(agentMemories.ownerUserId, ownerUserId),
            eq(agentMemories.slot, slot),
            isNull(agentMemories.forgottenAt),
          ),
        )
        .limit(1);
      return row?.id ?? null;
    },

    async forget(id, ownerUserId) {
      const [cleared] = await database
        .update(agentMemories)
        .set({
          forgottenAt: new Date(),
          forgottenBy: "owner",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentMemories.id, id),
            eq(agentMemories.ownerUserId, ownerUserId),
            // Already forgotten is not an error, but it is not a second forgetting either.
            isNull(agentMemories.forgottenAt),
          ),
        )
        .returning({
          agentId: agentMemories.agentId,
          content: agentMemories.content,
          slot: agentMemories.slot,
        });
      if (!cleared) return null;
      const forgotten = {
        agentId: cleared.agentId,
        line: drawnLine({
          content: cleared.content,
          slot: isNotebookSlot(cleared.slot) ? cleared.slot : null,
        }),
      };
      /*
       * AND OUT OF THE DAY SUMMARIES, before the answer. Waited for, a bounded while: the owner
       * pressed 잊기 and is told it is done, and the conversation's next message must not carry the
       * fact in its frozen summary. The rule's scrub lands at once; a slow model's lands behind.
       */
      if (hooks.afterForget) {
        const work = hooks
          .afterForget({ ...forgotten, ownerUserId })
          .catch((error: unknown) => {
            log.warn("memory_forget_scrub_failed", {
              reason: describeFailure(error),
            });
          });
        await Promise.race([
          work,
          new Promise<void>((resolve) =>
            setTimeout(resolve, AFTER_FORGET_WAIT_MS).unref?.(),
          ),
        ]);
      }
      return forgotten;
    },

    guidance,
  };
}
