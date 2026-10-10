import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { soloConversationOf } from "../src/channels/solo-channel";
import { createDatabase } from "../src/db/client";
import {
  agents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * Migration 0064's backfill, run over rows: which conversation of a person and a Bot stays `main`
 * and which become projects (docs/laf/redesign-2026-10.md §3, piece 4-1).
 *
 * THE ANSWER IT WRITES DOWN MUST BE THE ANSWER THE RULE GAVE. Until 0064 "the conversation" was
 * the oldest channel holding only that Bot, oldest by `created_at` and then by `id`
 * (`soloConversationOf`). An account from before 2026-09-24 has several such channels for one
 * Bot, and if the backfill ordered one tie differently, that account's routines would deliver into
 * another thread on the day it upgraded. So the fixture is shaped like that account — three Bots,
 * thirteen channels, two of them made in the same instant — and what the resolver answers after
 * the statement is compared with what the old rule answered before it.
 *
 * The statement is read out of the migration file and run INSIDE ONE TRANSACTION THAT IS ROLLED
 * BACK, rows and all: it writes every channel in the database, and the rest of the suite's
 * channels are not this file's to touch (the same arrangement as
 * `notes-preset-migration.integration.test.ts`).
 */

/** Opened in the database `DATABASE_URL` names and in no other: the statement writes every channel. */
let database: ReturnType<typeof createDatabase> | undefined;
function opened() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "this file runs a migration's statement: name the database in DATABASE_URL",
    );
  }
  database ??= createDatabase(url, TEST_POOL);
  return database;
}
afterAll(async () => {
  await database?.$client.end();
});

function backfill(): string {
  const [, statement, ...more] = readFileSync(
    join(import.meta.dir, "../drizzle/0064_conversation_kind.sql"),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.startsWith("--"))
        .join("\n")
        .trim()
        .replace(/;$/, ""),
    );
  if (!statement || more.length > 0) {
    throw new Error("0064 is expected to be the column and then one backfill");
  }
  return statement;
}

const run = randomUUID().slice(0, 8);
const id = (name: string) => `m64-${name}-${run}`;
const PERSON = id("person");
const OTHER = id("other");
const BOTS = [id("bot-a"), id("bot-b"), id("bot-c")] as const;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 9, minute));

type Seeded = { channel: string; user: string; bots: string[]; at: Date };

/**
 * Three Bots and thirteen channels of one person's, as the account measured in 2026-09 had: nine
 * with the first Bot, three with the second, one with the third. Two of the first Bot's were made
 * in the same instant, and the one whose id sorts first is the older by the rule.
 */
const LEGACY: Seeded[] = [
  // The tie: same instant, ids chosen so the rule's second key decides.
  { channel: id("a-2-tie-b"), user: PERSON, bots: [BOTS[0]], at: at(0) },
  { channel: id("a-1-tie-a"), user: PERSON, bots: [BOTS[0]], at: at(0) },
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({
    channel: id(`a-later-${n}`),
    user: PERSON,
    bots: [BOTS[0]],
    at: at(n),
  })),
  { channel: id("b-first"), user: PERSON, bots: [BOTS[1]], at: at(20) },
  { channel: id("b-second"), user: PERSON, bots: [BOTS[1]], at: at(21) },
  { channel: id("b-third"), user: PERSON, bots: [BOTS[1]], at: at(22) },
  { channel: id("c-only"), user: PERSON, bots: [BOTS[2]], at: at(30) },
];
const OTHERS: Seeded[] = [
  // Somebody else's conversation with the first Bot, older than all of the person's: its own main.
  { channel: id("other-a"), user: OTHER, bots: [BOTS[0]], at: at(-10) },
  // A channel holding two Bots, and one holding none: neither was ever anybody's main.
  { channel: id("pair"), user: PERSON, bots: [BOTS[0], BOTS[1]], at: at(-20) },
  { channel: id("empty"), user: PERSON, bots: [], at: at(-30) },
];

class Undo extends Error {}

/** Seed, run `work`, and take everything back — the statement's writes to other rows included. */
async function inRolledBack(
  work: (
    transaction: Parameters<
      Parameters<ReturnType<typeof opened>["transaction"]>[0]
    >[0],
  ) => Promise<void>,
): Promise<void> {
  try {
    await opened().transaction(async (transaction) => {
      await transaction.insert(users).values(
        [PERSON, OTHER].map((user) => ({
          id: user,
          email: `${user}@laf.test`,
          name: user,
          emailVerified: true,
        })),
      );
      await transaction.insert(agents).values(
        BOTS.map((bot) => ({
          id: bot,
          name: bot,
          type: "remote_ag_ui" as const,
          configuration: {},
        })),
      );
      const all = [...LEGACY, ...OTHERS];
      await transaction.insert(channels).values(
        all.map((one) => ({
          id: one.channel,
          name: one.channel,
          description: "",
          createdAt: one.at,
        })),
      );
      await transaction
        .insert(channelMemberships)
        .values(
          all.map((one) => ({ channelId: one.channel, userId: one.user })),
        );
      await transaction.insert(channelThreads).values(
        all.map((one) => ({
          userId: one.user,
          channelId: one.channel,
          threadId: randomUUID(),
        })),
      );
      await transaction
        .insert(channelAgents)
        .values(
          all.flatMap((one) =>
            one.bots.map((bot) => ({ channelId: one.channel, agentId: bot })),
          ),
        );
      await work(transaction);
      throw new Undo();
    });
  } catch (error) {
    if (error instanceof Undo || error instanceof TransactionRollbackError) {
      return;
    }
    throw error;
  }
}

describe("migration 0064: what each conversation is", () => {
  test("for a person and a Bot the conversation the rule answered stays main, tie and all; every other is a project", async () => {
    await inRolledBack(async (transaction) => {
      /*
       * What the rule answered before the column meant anything: every seeded row is `main` by
       * the default, so the resolver's `where` passes them all and its order — the old rule's
       * own — picks.
       */
      const before = new Map<string, string | undefined>();
      for (const bot of BOTS) {
        before.set(
          bot,
          (await soloConversationOf(transaction, PERSON, bot))?.channelId,
        );
      }
      expect([...before.values()]).toEqual([
        id("a-1-tie-a"),
        id("b-first"),
        id("c-only"),
      ]);

      await transaction.execute(sql.raw(backfill()));

      const kinds = new Map(
        (
          await transaction
            .select({ id: channels.id, kind: channels.kind })
            .from(channels)
            .where(
              inArray(
                channels.id,
                [...LEGACY, ...OTHERS].map((one) => one.channel),
              ),
            )
        ).map((row) => [row.id, row.kind]),
      );
      const mains = [...kinds]
        .filter(([, kind]) => kind === "main")
        .map(([channel]) => channel);
      expect(mains.sort()).toEqual(
        [id("a-1-tie-a"), id("b-first"), id("c-only"), id("other-a")].sort(),
      );
      // Thirteen channels, three Bots: ten projects, their rows otherwise as they were.
      expect(
        LEGACY.filter((one) => kinds.get(one.channel) === "project"),
      ).toHaveLength(10);
      // A channel with two Bots, or none, was never a main conversation and does not read as one.
      expect([kinds.get(id("pair")), kinds.get(id("empty"))]).toEqual([
        "project",
        "project",
      ]);

      // And the resolver, now reading the column, answers exactly what the rule did.
      for (const bot of BOTS) {
        expect(
          (await soloConversationOf(transaction, PERSON, bot))?.channelId,
        ).toBe(before.get(bot) as string);
      }
      expect(
        (await soloConversationOf(transaction, OTHER, BOTS[0]))?.channelId,
      ).toBe(id("other-a"));
    });
  });

  test("run a second time it changes nothing", async () => {
    await inRolledBack(async (transaction) => {
      await transaction.execute(sql.raw(backfill()));
      const read = () =>
        transaction
          .select({ id: channels.id, kind: channels.kind })
          .from(channels)
          .orderBy(channels.id);
      const once = await read();
      await transaction.execute(sql.raw(backfill()));
      expect(await read()).toEqual(once);
    });
  });

  test("a project older than the main is not taken for it: the resolver reads what a conversation says it is", async () => {
    await inRolledBack(async (transaction) => {
      await transaction.execute(sql.raw(backfill()));
      // As 4-2 will be able to leave things: the Bot's oldest channel is a project.
      await transaction
        .update(channels)
        .set({ kind: "project" })
        .where(inArray(channels.id, [id("b-first")]));
      await transaction
        .update(channels)
        .set({ kind: "main" })
        .where(inArray(channels.id, [id("b-third")]));
      expect(
        (await soloConversationOf(transaction, PERSON, BOTS[1]))?.channelId,
      ).toBe(id("b-third"));
      // And a Bot whose every channel is a project has no main conversation.
      await transaction
        .update(channels)
        .set({ kind: "project" })
        .where(inArray(channels.id, [id("c-only")]));
      expect(await soloConversationOf(transaction, PERSON, BOTS[2])).toBeNull();
    });
  });
});
