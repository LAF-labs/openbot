/**
 * Everything this deployment holds about one person, in a file they can walk away with.
 *
 * ONE JSON DOCUMENT, NOT A ZIP, and that is a dependency decision rather than a design preference.
 * Bun ships no zip writer and this repository depends on no compression library; adding one to
 * package a handful of arrays would be a supply-chain entry for a formatting nicety. The redesign
 * note (§5.9) says "zip" because that is what an export usually is — what it actually has to be is
 * readable without special tools, and a single `export.json` is more readable than a zip, not less.
 * If an export ever has to carry binaries (screenshots, uploaded files) that trade flips, and this
 * comment is where to start.
 *
 * STREAMED, NEVER ASSEMBLED. The document is written section by section into a byte stream, and the
 * one section that can be arbitrarily large — the conversations — is read one thread at a time.
 * Building the whole thing in memory first would make the size of somebody's history the size of
 * this process's heap, which is the failure that arrives quietly on the account that has been used
 * the most.
 *
 * WHAT IS NEVER IN IT: encrypted credential blobs, OAuth access or refresh tokens, the `auth` block
 * on a Bot's configuration (a vault pointer, not a secret, and still no reason to hand out), the
 * `accounts` table (better-auth's password hash and provider tokens live there), sessions, and
 * anybody else's rows. Every query below is narrowed by this person's id or by the ids of the Bots
 * they own; there is no unfiltered read in this file.
 */
import { and, asc, desc, eq, gt, inArray, or, type SQL } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentMemories,
  agentPreferences,
  agentProfiles,
  agents,
  auditEvents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  computerStandingApprovals,
  lafRoutineRuns,
  lafRoutines,
  lafThreadRuns,
  skills,
  userRoles,
  users,
} from "../db/schema";
import { messagesFor } from "../runner/thread-store";

/**
 * How much of each section an export will carry before it stops and says so.
 *
 * A cap rather than no cap, because this endpoint reads a table that only grows and answers a
 * request a browser is waiting on. A cap that is announced rather than silent, because an export
 * that quietly stopped at row 50,000 is worse than no export: it looks complete.
 *
 * Sized against what one VM holds. A person's VM is theirs alone (docs/laf/deployment-model.md),
 * and 50,000 messages is a few years of daily use — a deployment that reaches one of these numbers
 * has an operator who should be told, which is what `truncated` is for.
 */
export const EXPORT_LIMITS = {
  messages: 50_000,
  auditEvents: 50_000,
  runs: 20_000,
  routineRuns: 20_000,
} as const;

/** Audit rows are read in pages rather than in one statement, for the reason above. */
const AUDIT_PAGE = 1_000;

const encoder = new TextEncoder();

/** The Bots one person owns, soft-deleted ones included: a deleted Bot is still their data. */
async function botIdsFor(
  database: Database,
  userId: string,
): Promise<string[]> {
  const rows = await database
    .select({ agentId: agentProfiles.agentId })
    .from(agentProfiles)
    .where(eq(agentProfiles.ownerUserId, userId));
  return rows.map((row) => row.agentId);
}

/** The AG-UI address a Bot answers on, and nothing else out of its configuration. See the header. */
function endpointOf(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== "object") return null;
  const endpoint = (configuration as { endpoint?: unknown }).endpoint;
  return typeof endpoint === "string" ? endpoint : null;
}

export type AccountExport = {
  /** The document, as bytes, in the order the sections are written. */
  stream: (userId: string) => ReadableStream<Uint8Array>;
};

export function createAccountExport(database: Database): AccountExport {
  /*
   * The document, as a sequence of strings.
   *
   * Written by hand rather than by `JSON.stringify` over one object, which is the whole point: an
   * object big enough to need streaming is an object too big to build. Each section serialises its
   * own rows and is forgotten.
   */
  async function* document(userId: string): AsyncGenerator<string> {
    const truncated: string[] = [];

    yield `{\n"format":"laf.account-export/1",\n"exportedAt":${JSON.stringify(new Date().toISOString())},\n"accountId":${JSON.stringify(userId)},\n"limits":${JSON.stringify(EXPORT_LIMITS)}`;

    const [person] = await database
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const roles = await database
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    yield `,\n"profile":${JSON.stringify(
      person
        ? {
            id: person.id,
            email: person.email,
            name: person.name,
            image: person.image,
            emailVerified: person.emailVerified,
            groups: person.groups,
            onboardedAt: person.onboardedAt,
            createdAt: person.createdAt,
            updatedAt: person.updatedAt,
            roles: roles.map((row) => row.role),
          }
        : null,
    )}`;

    const botIds = await botIdsFor(database, userId);
    const botRows = botIds.length
      ? await database
          .select({
            id: agents.id,
            name: agents.name,
            type: agents.type,
            configuration: agents.configuration,
            createdAt: agents.createdAt,
            updatedAt: agents.updatedAt,
            title: agentProfiles.title,
            roleDescription: agentProfiles.roleDescription,
            avatarSeed: agentProfiles.avatarSeed,
            effort: agentProfiles.effort,
            autoReview: agentProfiles.autoReview,
            visibility: agentProfiles.visibility,
            deletedAt: agentProfiles.deletedAt,
          })
          .from(agents)
          .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
          .where(inArray(agents.id, botIds))
          .orderBy(asc(agents.createdAt))
      : [];
    yield `,\n"bots":${JSON.stringify(
      botRows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        endpoint: endpointOf(row.configuration),
        title: row.title,
        roleDescription: row.roleDescription,
        avatarSeed: row.avatarSeed,
        effort: row.effort,
        autoReview: row.autoReview,
        visibility: row.visibility,
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    )}`;

    yield `,\n"botPreferences":${JSON.stringify(
      await database
        .select()
        .from(agentPreferences)
        .where(eq(agentPreferences.userId, userId)),
    )}`;

    /*
     * What a Bot learned about them, forgotten rows included. A memory a person cleared is still a
     * thing this deployment holds and still theirs to take.
     */
    yield `,\n"memories":${JSON.stringify(
      await database
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.ownerUserId, userId))
        .orderBy(asc(agentMemories.createdAt)),
    )}`;

    /*
     * A channel is theirs if they are in it. There is no owner column — membership is the
     * relationship the product actually has (`channels/routes.ts`), and on a one-person VM that is
     * every channel on the deployment.
     */
    const membership = await database
      .select({
        id: channels.id,
        name: channels.name,
        description: channels.description,
        lastMessageAt: channels.lastMessageAt,
        lastReadAt: channelMemberships.lastReadAt,
        createdAt: channels.createdAt,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, userId),
        ),
      )
      .orderBy(asc(channels.createdAt));
    const channelIds = membership.map((row) => row.id);
    const participants = channelIds.length
      ? await database
          .select({
            channelId: channelAgents.channelId,
            agentId: channelAgents.agentId,
          })
          .from(channelAgents)
          .where(inArray(channelAgents.channelId, channelIds))
      : [];
    yield `,\n"channels":${JSON.stringify(
      membership.map((row) => ({
        ...row,
        agentIds: participants
          .filter((entry) => entry.channelId === row.id)
          .map((entry) => entry.agentId),
      })),
    )}`;

    /*
     * The conversations, one thread at a time and through the store's own reader.
     *
     * `laf_thread_messages` is never queried from here. It is one row per message with a `seq` and
     * a heal-on-read parser for the double-encoded rows the 0026 backfill inherited, and a second
     * reader would be a second place for that parser to be missing — an export that rendered an old
     * conversation as empty and told nobody.
     */
    const threads = await database
      .select({
        threadId: channelThreads.threadId,
        channelId: channelThreads.channelId,
        createdAt: channelThreads.createdAt,
      })
      .from(channelThreads)
      .where(eq(channelThreads.userId, userId))
      .orderBy(asc(channelThreads.createdAt));
    yield `,\n"conversations":[`;
    let written = 0;
    let messagesWritten = 0;
    for (const thread of threads) {
      if (messagesWritten >= EXPORT_LIMITS.messages) {
        if (!truncated.includes("conversations")) {
          truncated.push("conversations");
        }
        break;
      }
      const held = await messagesFor(database, thread.threadId);
      const room = held.slice(0, EXPORT_LIMITS.messages - messagesWritten);
      if (room.length < held.length && !truncated.includes("conversations")) {
        truncated.push("conversations");
      }
      messagesWritten += room.length;
      yield `${written > 0 ? "," : ""}\n${JSON.stringify({
        threadId: thread.threadId,
        channelId: thread.channelId,
        createdAt: thread.createdAt,
        messages: room,
      })}`;
      written += 1;
    }
    yield `]`;

    /*
     * A routine is theirs if they wrote it OR if it drives a Bot of theirs — the same ownership rule
     * `routines/service.ts` enforces, and it is here rather than re-derived so an export and an
     * access check cannot disagree about whose routine this is.
     */
    const routineOwnership: SQL | undefined = botIds.length
      ? or(
          eq(lafRoutines.createdById, userId),
          inArray(lafRoutines.agentId, botIds),
        )
      : eq(lafRoutines.createdById, userId);
    const routines = await database
      .select({
        id: lafRoutines.id,
        agentId: lafRoutines.agentId,
        name: lafRoutines.name,
        instruction: lafRoutines.instruction,
        scheduleKind: lafRoutines.scheduleKind,
        intervalMinutes: lafRoutines.intervalMinutes,
        dailyLocal: lafRoutines.dailyLocal,
        dailyTimeZone: lafRoutines.dailyTimeZone,
        dailyDays: lafRoutines.dailyDays,
        enabled: lafRoutines.enabled,
        createdById: lafRoutines.createdById,
        nextRunAt: lafRoutines.nextRunAt,
        lastRunAt: lafRoutines.lastRunAt,
        createdAt: lafRoutines.createdAt,
        updatedAt: lafRoutines.updatedAt,
      })
      .from(lafRoutines)
      .where(routineOwnership)
      .orderBy(asc(lafRoutines.createdAt));
    // `trigger_token_hash` is deliberately absent: it is the hash of a webhook capability, and a
    // hash of a capability belongs on no shelf this export creates.
    yield `,\n"routines":${JSON.stringify(routines)}`;

    const routineIds = routines.map((routine) => routine.id);
    const routineRuns = routineIds.length
      ? await database
          .select()
          .from(lafRoutineRuns)
          .where(inArray(lafRoutineRuns.routineId, routineIds))
          .orderBy(desc(lafRoutineRuns.startedAt))
          .limit(EXPORT_LIMITS.routineRuns + 1)
      : [];
    if (routineRuns.length > EXPORT_LIMITS.routineRuns) {
      truncated.push("routineRuns");
    }
    yield `,\n"routineRuns":${JSON.stringify(routineRuns.slice(0, EXPORT_LIMITS.routineRuns))}`;

    const runs = await database
      .select()
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.userId, userId))
      .orderBy(desc(lafThreadRuns.startedAt))
      .limit(EXPORT_LIMITS.runs + 1);
    if (runs.length > EXPORT_LIMITS.runs) truncated.push("runs");
    yield `,\n"runs":${JSON.stringify(runs.slice(0, EXPORT_LIMITS.runs))}`;

    yield `,\n"skills":${JSON.stringify(
      await database
        .select()
        .from(skills)
        .where(eq(skills.ownerUserId, userId))
        .orderBy(asc(skills.createdAt)),
    )}`;

    yield `,\n"standingApprovals":${JSON.stringify(
      botIds.length
        ? await database
            .select()
            .from(computerStandingApprovals)
            .where(inArray(computerStandingApprovals.botId, botIds))
            .orderBy(asc(computerStandingApprovals.grantedAt))
        : [],
    )}`;

    /*
     * The trail, oldest first, in pages.
     *
     * Keyed on `(created_at, id)` rather than on an offset: the table is append-only and an offset
     * walk over a growing table can repeat or skip rows. Rows where this person is the ACTOR only —
     * a row about them written by an administrator belongs to the deployment's record of what an
     * administrator did, and handing it over would be handing over somebody else's actions.
     */
    yield `,\n"auditEvents":[`;
    let auditWritten = 0;
    let after: { createdAt: Date; id: string } | undefined;
    for (;;) {
      const page = await database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.actorUserId, userId),
            after
              ? or(
                  gt(auditEvents.createdAt, after.createdAt),
                  and(
                    eq(auditEvents.createdAt, after.createdAt),
                    gt(auditEvents.id, after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
        .limit(AUDIT_PAGE);
      if (page.length === 0) break;
      for (const row of page) {
        if (auditWritten >= EXPORT_LIMITS.auditEvents) break;
        yield `${auditWritten > 0 ? "," : ""}\n${JSON.stringify(row)}`;
        auditWritten += 1;
      }
      const last = page.at(-1);
      if (!last) break;
      if (auditWritten >= EXPORT_LIMITS.auditEvents) {
        truncated.push("auditEvents");
        break;
      }
      if (page.length < AUDIT_PAGE) break;
      after = { createdAt: last.createdAt, id: last.id };
    }
    yield `]`;

    /*
     * LAST, because it is the one fact the document cannot know until it is finished. A `truncated`
     * field at the top would have to be guessed at before the rows were counted, and a guess about
     * completeness is the thing this field exists to stop being made.
     */
    yield `,\n"truncated":${JSON.stringify(truncated)}\n}\n`;
  }

  return {
    stream(userId) {
      const sections = document(userId);
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await sections.next();
            if (next.done) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(next.value));
          } catch (error) {
            /*
             * MEASURED, NOT IMAGINED. The first run of this endpoint against a real database hit a
             * missing table halfway through and produced an HTTP 200 with 8KB of valid-looking
             * JSON and no closing brace — because the status line had already gone out and there is
             * no way to take it back. Two things make that survivable and both are deliberate:
             * the document is only closed on the last line, so a truncated export is INVALID JSON
             * and every reader of it fails loudly; and this line, so the operator's log names what
             * broke instead of leaving a bare driver error next to an apparently successful request.
             */
            console.error(
              `account export for ${userId} failed part-way: ${error instanceof Error ? error.message : String(error)}`,
            );
            controller.error(error);
          }
        },
        cancel() {
          // A browser that walked away mid-download: stop reading rather than finish into nothing.
          void sections.return(undefined);
        },
      });
    },
  };
}
