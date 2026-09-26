/**
 * Everything a Bot leaves behind, removed with it — what "Delete this Bot" tells the person happens.
 *
 * MEASURED 2026-09-26 (red-team run): the dialog said "대화와 루틴, 기억한 내용까지 함께 사라져요" and
 * `DELETE /api/agents/:id` set `agent_profiles.deleted_at` and nothing else. After the 204 its
 * memories were live, its conversation still listed and opened, an attached receipt still downloaded
 * byte for byte, and its routines stayed enabled — the ticker went on claiming them every run and
 * each one ended `laf:turn_failed` with a `run.failed` notice to the person who had deleted the Bot.
 * A control that saves and does nothing is worse than no control (CLAUDE.md), and this one said it
 * had deleted.
 *
 * THE ROW GOES TOO, NOT A TOMBSTONE. What decides it is the foreign keys. Everything a Bot owns
 * either cascades from `agents` or is found here by its id, and nothing that must outlive the Bot
 * holds a key to it: the audit trail names a Bot by text on purpose (append-only, no key), the run
 * ledger and a roster preview `set null`, and the notification queue and the site connections carry
 * the id as text so a deleted Bot never turns their writes into exceptions. So the row can go, and
 * once it has, the keys become the guard a tombstone could not be: a `remember`, an attachment or a
 * conversation layer written by a run that was still in flight fails on the missing parent instead of
 * quietly re-creating what was just removed for a Bot that no longer exists. A tombstone also keeps
 * what the person wrote on it — its name, its standing job, the "묻지 마" sentence.
 *
 * THE COUNTS, ONE ROW. Account deletion (`account/deletion.ts`) deletes what a cascade would have
 * taken anyway, explicitly and first, so the trail can say how many; this does the same, and the
 * caller writes them into one `agent.deleted` row inside the same transaction. Counts only, never
 * content — the same rule as the audit fingerprint.
 *
 * WHAT DELIBERATELY STAYS: the audit trail, whatever it says about this Bot; the person's browser
 * logins, which are the account's and every other Bot's (`computer/release.ts`); the person's own
 * skills (a grant to this Bot goes, the skill does not); and what they wrote to the operator
 * (`support.*` rows), which is the person's, not the Bot's, and leaves with the account.
 */
import { and, eq, inArray, ne, notLike, or, sql } from "drizzle-orm";
import { spillPath, TOOL_RESULT_CUT } from "../../../shared/spillover";
import type { Database } from "../db/client";
import {
  agentGuidance,
  agentMemories,
  agentMemoryReceipts,
  agentPreferences,
  agentProfiles,
  agents,
  channelAgents,
  channels,
  channelThreads,
  componentExclusions,
  computerStandingApprovals,
  credentials,
  lafAnswerRatings,
  lafAttachments,
  lafConversationContexts,
  lafNotifications,
  lafRoutineNotepads,
  lafRoutineRuns,
  lafRoutines,
  lafThreadMessages,
  lafThreadRuns,
  pluginGrants,
} from "../db/schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** How many rows each part removed, keyed the way the trail keeps them. */
export type BotDeletionCounts = Record<string, number>;

export type BotRemoval = {
  counts: BotDeletionCounts;
  /**
   * What it left on the deployment's computer — its attachments' text copies (`uploads/…`) and its
   * conversations' long tool results (`.results/…`) — to be removed once this transaction has
   * committed: a file cannot be un-deleted by a rollback.
   */
  files: string[];
};

/**
 * Delete one Bot and everything it owns, on the caller's transaction.
 *
 * The caller has already locked the Bot's rows and decided it may; this only removes, narrowed at
 * every statement by this Bot's id or by ids read from rows that name it — never a predicate over a
 * table.
 */
export async function removeBotRows(
  transaction: Transaction,
  botId: string,
): Promise<BotRemoval> {
  const counts: BotDeletionCounts = {};
  const record = (name: string, rows: { length: number }) => {
    counts[name] = rows.length;
  };

  /*
   * Its conversations: the channels it is the ONLY Bot in. A channel that also holds another Bot is
   * that Bot's conversation too, and removing it would delete a conversation out from under the one
   * that stays — the careful rule account deletion writes for people. Rooms were removed on
   * 2026-09-24 and the route refuses a second Bot, so on a real deployment this is every channel it
   * has.
   */
  const linked = await transaction
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(eq(channelAgents.agentId, botId));
  const linkedIds = linked.map((row) => row.channelId);
  const shared = linkedIds.length
    ? await transaction
        .selectDistinct({ channelId: channelAgents.channelId })
        .from(channelAgents)
        .where(
          and(
            inArray(channelAgents.channelId, linkedIds),
            ne(channelAgents.agentId, botId),
          ),
        )
    : [];
  const sharedIds = new Set(shared.map((row) => row.channelId));
  const channelIds = linkedIds.filter((id) => !sharedIds.has(id));

  // Read before the channels go: `laf_thread_messages` has no key back to anything.
  const threads = channelIds.length
    ? await transaction
        .select({ threadId: channelThreads.threadId })
        .from(channelThreads)
        .where(inArray(channelThreads.channelId, channelIds))
    : [];
  const threadIds = threads.map((row) => row.threadId);

  /*
   * The long tool results those conversations filed whole on the computer (`.results/<call>.txt`,
   * `computer/spillover.ts`) — page text the Bot read, which is conversation too. A result is filed
   * exactly when it is longer than the cut, and the stored copy (whole, or the head plus the line
   * naming the file) is longer than the cut either way. Bytes rather than characters, because a
   * byte count is never below the UTF-16 length the cut was measured in: a result that was filed is
   * never missed, and one that was not costs a removal that answers "already gone".
   */
  const spilled = threadIds.length
    ? await transaction
        .select({
          toolCallId: sql<
            string | null
          >`${lafThreadMessages.message} ->> 'toolCallId'`,
        })
        .from(lafThreadMessages)
        .where(
          and(
            inArray(lafThreadMessages.threadId, threadIds),
            sql`${lafThreadMessages.message} ->> 'role' = 'tool'`,
            sql`octet_length(${lafThreadMessages.message} ->> 'content') > ${TOOL_RESULT_CUT}`,
          ),
        )
    : [];

  record(
    "threadMessages",
    threadIds.length
      ? await transaction
          .delete(lafThreadMessages)
          .where(inArray(lafThreadMessages.threadId, threadIds))
          .returning({ seq: lafThreadMessages.seq })
      : [],
  );
  record(
    "conversationContexts",
    await transaction
      .delete(lafConversationContexts)
      .where(
        threadIds.length
          ? or(
              eq(lafConversationContexts.agentId, botId),
              inArray(lafConversationContexts.threadId, threadIds),
            )
          : eq(lafConversationContexts.agentId, botId),
      )
      .returning({ threadId: lafConversationContexts.threadId }),
  );
  record(
    "answerRatings",
    await transaction
      .delete(lafAnswerRatings)
      .where(
        channelIds.length
          ? or(
              eq(lafAnswerRatings.agentId, botId),
              inArray(lafAnswerRatings.channelId, channelIds),
            )
          : eq(lafAnswerRatings.agentId, botId),
      )
      .returning({ id: lafAnswerRatings.id }),
  );
  /*
   * The bytes are the row (`laf_attachments.data`); what the Bot could read of a sheet or a PDF was
   * also filed on the computer as text, and its path comes back for the caller to remove after the
   * commit.
   */
  const attachments = await transaction
    .delete(lafAttachments)
    .where(
      channelIds.length
        ? or(
            eq(lafAttachments.agentId, botId),
            inArray(lafAttachments.channelId, channelIds),
          )
        : eq(lafAttachments.agentId, botId),
    )
    .returning({
      id: lafAttachments.id,
      workspacePath: lafAttachments.workspacePath,
    });
  record("attachments", attachments);
  const files = [
    ...attachments.flatMap((row) =>
      row.workspacePath ? [row.workspacePath] : [],
    ),
    ...new Set(
      spilled.flatMap((row) =>
        row.toolCallId ? [spillPath(row.toolCallId)] : [],
      ),
    ),
  ];

  /*
   * The run ledger's rows for it. The same call account deletion makes for a person's runs: a row
   * carries a routine's name and the id of a conversation that no longer exists, and the history of
   * record — `routine.ran`, `model.usage` — is the audit trail, which stays.
   */
  record(
    "runs",
    await transaction
      .delete(lafThreadRuns)
      .where(
        threadIds.length
          ? or(
              eq(lafThreadRuns.agentId, botId),
              inArray(lafThreadRuns.threadId, threadIds),
            )
          : eq(lafThreadRuns.agentId, botId),
      )
      .returning({ runId: lafThreadRuns.runId }),
  );
  /*
   * What the person was going to be told about it — a question it asked, a run that finished or
   * failed. Not the operator's rows (`support.*`: the person's own words to the people who run the
   * product) and not the fleet's, whose Bot is nobody.
   */
  record(
    "notifications",
    await transaction
      .delete(lafNotifications)
      .where(
        and(
          channelIds.length
            ? or(
                eq(lafNotifications.botId, botId),
                inArray(lafNotifications.channelId, channelIds),
              )
            : eq(lafNotifications.botId, botId),
          notLike(lafNotifications.kind, "support.%"),
          notLike(lafNotifications.kind, "fleet.%"),
        ),
      )
      .returning({ id: lafNotifications.id }),
  );
  // Memberships, the Bot's link and the person's thread row go with each channel.
  record(
    "conversations",
    channelIds.length
      ? await transaction
          .delete(channels)
          .where(inArray(channels.id, channelIds))
          .returning({ id: channels.id })
      : [],
  );

  const routines = await transaction
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(eq(lafRoutines.agentId, botId));
  const routineIds = routines.map((row) => row.id);
  record(
    "routineRuns",
    routineIds.length
      ? await transaction
          .delete(lafRoutineRuns)
          .where(inArray(lafRoutineRuns.routineId, routineIds))
          .returning({ id: lafRoutineRuns.id })
      : [],
  );
  record(
    "routineNotepads",
    routineIds.length
      ? await transaction
          .delete(lafRoutineNotepads)
          .where(inArray(lafRoutineNotepads.routineId, routineIds))
          .returning({ routineId: lafRoutineNotepads.routineId })
      : [],
  );
  record(
    "routines",
    routineIds.length
      ? await transaction
          .delete(lafRoutines)
          .where(inArray(lafRoutines.id, routineIds))
          .returning({ id: lafRoutines.id })
      : [],
  );

  // 수첩: what it learned, what the owner wrote there, how it read the owner's habits, and the
  // receipts of the background work on all three.
  record(
    "memories",
    await transaction
      .delete(agentMemories)
      .where(eq(agentMemories.agentId, botId))
      .returning({ id: agentMemories.id }),
  );
  record(
    "guidance",
    await transaction
      .delete(agentGuidance)
      .where(eq(agentGuidance.agentId, botId))
      .returning({ id: agentGuidance.id }),
  );
  record(
    "memoryReceipts",
    await transaction
      .delete(agentMemoryReceipts)
      .where(eq(agentMemoryReceipts.agentId, botId))
      .returning({ id: agentMemoryReceipts.id }),
  );

  record(
    "standingApprovals",
    await transaction
      .delete(computerStandingApprovals)
      .where(eq(computerStandingApprovals.botId, botId))
      .returning({ id: computerStandingApprovals.id }),
  );
  record(
    "grants",
    await transaction
      .delete(pluginGrants)
      .where(eq(pluginGrants.agentId, botId))
      .returning({ ref: pluginGrants.ref }),
  );
  record(
    "componentExclusions",
    await transaction
      .delete(componentExclusions)
      .where(eq(componentExclusions.agentId, botId))
      .returning({ componentName: componentExclusions.componentName }),
  );
  record(
    "botPreferences",
    await transaction
      .delete(agentPreferences)
      .where(eq(agentPreferences.agentId, botId))
      .returning({ userId: agentPreferences.userId }),
  );
  /*
   * The key to a customer's own agent, when it had one (`auth-header.ts`): kept in the vault under
   * the Bot's id, with nothing to cascade from. Not named `credentials` — `redactAuditPayload` would
   * write `[REDACTED]` over a count under that key.
   */
  record(
    "agentKeys",
    await transaction
      .delete(credentials)
      .where(and(eq(credentials.kind, "agent"), eq(credentials.keyId, botId)))
      .returning({ id: credentials.id }),
  );

  record(
    "profile",
    await transaction
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, botId))
      .returning({ agentId: agentProfiles.agentId }),
  );
  record(
    "bot",
    await transaction
      .delete(agents)
      .where(eq(agents.id, botId))
      .returning({ id: agents.id }),
  );

  return { counts, files };
}
