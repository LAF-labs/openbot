import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  MAX_GUIDANCE_LENGTH,
  MAX_GUIDANCE_LINES,
} from "../../../shared/notebook";
import type { Database } from "../db/client";
import { agentGuidance } from "../db/schema";

/**
 * STANDING GUIDANCE — how the owner likes to work, one short line each (`agent_guidance`).
 *
 * The nightly dream writes the lines from the day's dialogue (`./dream.ts`); the owner edits or
 * removes any of them on 수첩. An owner's edit is the owner's line from then on and the dream never
 * touches it; a line the owner removed is on record, and the dream is told never to write it again.
 * Nothing here reaches a running conversation: the frozen layer of the next epoch draws what is
 * live then (`shared/prompt/context.ko.ts`, `guidanceText`).
 */
export type GuidanceLine = {
  id: string;
  content: string;
  /** `dream` or `owner`. */
  source: "dream" | "owner";
  /** The owner's local day a dream line was written for. */
  day: string | null;
  createdAt: Date;
};

export type GuidanceStore = {
  list(agentId: string, ownerUserId: string): Promise<GuidanceLine[]>;
  /** New words for a line, which are the owner's from then on. Null when there is no such line. */
  revise(
    agentId: string,
    id: string,
    ownerUserId: string,
    content: string,
  ): Promise<GuidanceLine | null>;
  /** The owner removes a line. On record, so the dream does not bring it back. */
  forget(agentId: string, id: string, ownerUserId: string): Promise<boolean>;
  /** Lines the owner removed, newest first: what the dream must not write again. */
  removed(agentId: string, ownerUserId: string): Promise<string[]>;
  /**
   * The dream's new reading replaces its old one: dream lines not in `lines` are retired, new ones
   * written. Owner lines are never touched, and the whole stays within `MAX_GUIDANCE_LINES`.
   */
  replaceDream(
    agentId: string,
    ownerUserId: string,
    lines: readonly string[],
    day: string,
  ): Promise<{ added: number; removed: number; kept: number }>;
};

const COLUMNS = {
  id: agentGuidance.id,
  content: agentGuidance.content,
  source: agentGuidance.source,
  day: agentGuidance.day,
  createdAt: agentGuidance.createdAt,
};

const lineOf = (row: {
  id: string;
  content: string;
  source: string;
  day: string | null;
  createdAt: Date;
}): GuidanceLine => ({
  ...row,
  source: row.source === "owner" ? "owner" : "dream",
});

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** The live lines of each of these Bots for this person, oldest first. One query, every turn. */
export async function selectGuidance(
  database: Database,
  agentIds: readonly string[],
  ownerUserId: string,
): Promise<Map<string, string[]>> {
  if (agentIds.length === 0) return new Map();
  const rows = await database
    .select({ agentId: agentGuidance.agentId, content: agentGuidance.content })
    .from(agentGuidance)
    .where(
      and(
        inArray(agentGuidance.agentId, [...agentIds]),
        eq(agentGuidance.ownerUserId, ownerUserId),
        isNull(agentGuidance.forgottenAt),
      ),
    )
    .orderBy(asc(agentGuidance.createdAt), asc(agentGuidance.id));
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const lines = out.get(row.agentId) ?? [];
    // Bounded where it is read too: a row written around the store still cannot grow the layer.
    if (lines.length < MAX_GUIDANCE_LINES) {
      lines.push(row.content.slice(0, MAX_GUIDANCE_LENGTH));
    }
    out.set(row.agentId, lines);
  }
  return out;
}

export function createGuidanceStore(database: Database): GuidanceStore {
  const live = (agentId: string, ownerUserId: string) =>
    database
      .select(COLUMNS)
      .from(agentGuidance)
      .where(
        and(
          eq(agentGuidance.agentId, agentId),
          eq(agentGuidance.ownerUserId, ownerUserId),
          isNull(agentGuidance.forgottenAt),
        ),
      )
      .orderBy(asc(agentGuidance.createdAt), asc(agentGuidance.id));

  return {
    async list(agentId, ownerUserId) {
      return (await live(agentId, ownerUserId)).map(lineOf);
    },

    async revise(agentId, id, ownerUserId, content) {
      const text = content.trim();
      if (!text || text.length > MAX_GUIDANCE_LENGTH) return null;
      const newId = `guidance_${crypto.randomUUID()}`;
      return database.transaction(async (tx) => {
        const retired = await tx
          .update(agentGuidance)
          .set({
            forgottenAt: new Date(),
            forgottenBy: "revision",
            replacedBy: newId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentGuidance.id, id),
              eq(agentGuidance.agentId, agentId),
              eq(agentGuidance.ownerUserId, ownerUserId),
              isNull(agentGuidance.forgottenAt),
            ),
          )
          .returning({ id: agentGuidance.id });
        if (retired.length === 0) return null;
        const [row] = await tx
          .insert(agentGuidance)
          .values({
            id: newId,
            agentId,
            ownerUserId,
            content: text,
            source: "owner",
          })
          .returning(COLUMNS);
        return row ? lineOf(row) : null;
      });
    },

    async forget(agentId, id, ownerUserId) {
      const cleared = await database
        .update(agentGuidance)
        .set({
          forgottenAt: new Date(),
          forgottenBy: "owner",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agentGuidance.id, id),
            eq(agentGuidance.agentId, agentId),
            eq(agentGuidance.ownerUserId, ownerUserId),
            isNull(agentGuidance.forgottenAt),
          ),
        )
        .returning({ id: agentGuidance.id });
      return cleared.length > 0;
    },

    async removed(agentId, ownerUserId) {
      const rows = await database
        .select({ content: agentGuidance.content })
        .from(agentGuidance)
        .where(
          and(
            eq(agentGuidance.agentId, agentId),
            eq(agentGuidance.ownerUserId, ownerUserId),
            eq(agentGuidance.forgottenBy, "owner"),
          ),
        )
        .orderBy(desc(agentGuidance.forgottenAt))
        .limit(30);
      return rows.map((row) => row.content);
    },

    async replaceDream(agentId, ownerUserId, lines, day) {
      const current = (await live(agentId, ownerUserId)).map(lineOf);
      const owners = current.filter((line) => line.source === "owner");
      const dreams = current.filter((line) => line.source === "dream");
      const room = Math.max(0, MAX_GUIDANCE_LINES - owners.length);
      const taken = new Set(owners.map((line) => flat(line.content)));
      const wanted: string[] = [];
      for (const line of lines) {
        if (wanted.length >= room) break;
        const text = flat(line);
        if (!text || text.length > MAX_GUIDANCE_LENGTH || taken.has(text)) {
          continue;
        }
        taken.add(text);
        wanted.push(text);
      }
      const wantedSet = new Set(wanted);
      const retire = dreams.filter(
        (line) => !wantedSet.has(flat(line.content)),
      );
      const standing = new Set(dreams.map((line) => flat(line.content)));
      const fresh = wanted.filter((text) => !standing.has(text));
      await database.transaction(async (tx) => {
        if (retire.length > 0) {
          await tx
            .update(agentGuidance)
            .set({
              forgottenAt: new Date(),
              forgottenBy: "dream",
              updatedAt: new Date(),
            })
            .where(
              inArray(
                agentGuidance.id,
                retire.map((line) => line.id),
              ),
            );
        }
        if (fresh.length > 0) {
          // A millisecond apart, so the layer draws them in the order the dream wrote them.
          const base = Date.now();
          await tx.insert(agentGuidance).values(
            fresh.map((content, at) => ({
              id: `guidance_${crypto.randomUUID()}`,
              agentId,
              ownerUserId,
              content,
              source: "dream",
              day,
              createdAt: new Date(base + at),
            })),
          );
        }
      });
      return {
        added: fresh.length,
        removed: retire.length,
        kept: dreams.length - retire.length,
      };
    },
  };
}
