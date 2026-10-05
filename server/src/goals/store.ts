import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  GOALS_ACTIVE_MAX,
  type GoalEntryKind,
  type GoalEntrySource,
  type GoalEntryView,
  type GoalMeasure,
  type GoalStatus,
  type GoalView,
  goalWords,
  type Momentum,
} from "../../../shared/goals";
import type { Category } from "../../../shared/persona";
import type { Database } from "../db/client";
import { lafGoalEntries, lafGoals, lafRoutines } from "../db/schema";

/**
 * 목표's record (muse-shape plan §3.4, phase 9): the goals a person set, and what was logged on them.
 *
 * TWO DOORS, TWO SCOPES. The person's page reads and changes their own goals by `user_id` — the
 * status (완료, 그만두기, 다시 진행) and deletion are theirs alone. The Bot's tools (`tools.ts`) are
 * scoped to the person AND the Bot, and can make a goal only after the person's yes, change what
 * the person asked to change, and log progress — never the status.
 */

export class GoalNotFound extends Error {
  readonly code = "laf:goal_not_found";
  constructor() {
    super("laf:goal_not_found");
  }
}

export class GoalsFull extends Error {
  readonly code = "laf:goals_full";
  constructor() {
    super("laf:goals_full");
  }
}

type GoalRow = typeof lafGoals.$inferSelect;

/** How many entries the page's timeline reads. The timeline, not the archive. */
const ENTRIES_SHOWN = 100;

export type GoalPatch = Partial<{
  title: string;
  target: string;
  dueOn: string | null;
  measure: GoalMeasure | null;
}>;

export type GoalStore = ReturnType<typeof createGoalStore>;

export function createGoalStore(input: {
  database: Database;
  now?: () => Date;
}) {
  const { database } = input;
  const now = input.now ?? (() => new Date());

  /** Each goal with its entry count, last entry, last value and linked routines. */
  const viewsOf = async (rows: GoalRow[]): Promise<GoalView[]> => {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [tallies, routines, lastValues] = await Promise.all([
      database
        .select({
          goalId: lafGoalEntries.goalId,
          entries: count(),
          lastAt: max(lafGoalEntries.at),
        })
        .from(lafGoalEntries)
        .where(inArray(lafGoalEntries.goalId, ids))
        .groupBy(lafGoalEntries.goalId),
      database
        .select({
          goalId: lafRoutines.goalId,
          id: lafRoutines.id,
          name: lafRoutines.name,
        })
        .from(lafRoutines)
        .where(inArray(lafRoutines.goalId, ids))
        .orderBy(asc(lafRoutines.createdAt)),
      database
        .selectDistinctOn([lafGoalEntries.goalId], {
          goalId: lafGoalEntries.goalId,
          value: lafGoalEntries.value,
        })
        .from(lafGoalEntries)
        .where(
          and(
            inArray(lafGoalEntries.goalId, ids),
            sql`${lafGoalEntries.value} is not null`,
          ),
        )
        .orderBy(lafGoalEntries.goalId, desc(lafGoalEntries.at)),
    ]);
    const tally = new Map(tallies.map((one) => [one.goalId, one]));
    const values = new Map(lastValues.map((one) => [one.goalId, one.value]));
    return rows.map((row) => {
      const counted = tally.get(row.id);
      const lastAt = counted?.lastAt ?? null;
      return {
        id: row.id,
        agentId: row.agentId,
        category: row.category as Category,
        title: row.title,
        target: row.target,
        measure: row.measure ?? null,
        dueOn: row.dueOn ?? null,
        status: row.status as GoalStatus,
        momentum: (row.momentum as Momentum | null) ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastEntryAt: lastAt ? new Date(lastAt).toISOString() : null,
        entryCount: Number(counted?.entries ?? 0),
        latestValue: values.get(row.id) ?? null,
        routines: routines
          .filter((routine) => routine.goalId === row.id)
          .map(({ id, name }) => ({ id, name })),
      };
    });
  };

  const entryView = (
    row: typeof lafGoalEntries.$inferSelect,
  ): GoalEntryView => ({
    id: row.id,
    at: row.at.toISOString(),
    kind: row.kind as GoalEntryKind,
    text: row.text,
    value: row.value ?? null,
    momentum: (row.momentum as Momentum | null) ?? null,
    source: row.source as GoalEntrySource,
    runId: row.runId ?? null,
  });

  const ownRow = async (userId: string, id: string) => {
    const [row] = await database
      .select()
      .from(lafGoals)
      .where(and(eq(lafGoals.id, id), eq(lafGoals.userId, userId)))
      .limit(1);
    return row ?? null;
  };

  const botRow = async (userId: string, agentId: string, id: string) => {
    const row = await ownRow(userId, id);
    return row && row.agentId === agentId ? row : null;
  };

  const oneView = async (row: GoalRow) => {
    const [view] = await viewsOf([row]);
    if (!view) throw new GoalNotFound();
    return view;
  };

  return {
    /** Every goal of this person's, active first, then the most recently changed. */
    async list(userId: string): Promise<GoalView[]> {
      const rows = await database
        .select()
        .from(lafGoals)
        .where(eq(lafGoals.userId, userId))
        .orderBy(
          sql`case when ${lafGoals.status} = 'active' then 0 else 1 end`,
          desc(lafGoals.updatedAt),
        );
      return viewsOf(rows);
    },

    /** One goal and its timeline, newest first, if it is this person's. */
    async get(
      userId: string,
      id: string,
    ): Promise<{ goal: GoalView; entries: GoalEntryView[] } | null> {
      const row = await ownRow(userId, id);
      if (!row) return null;
      const entries = await database
        .select()
        .from(lafGoalEntries)
        .where(eq(lafGoalEntries.goalId, id))
        .orderBy(desc(lafGoalEntries.at))
        .limit(ENTRIES_SHOWN);
      return { goal: await oneView(row), entries: entries.map(entryView) };
    },

    /** 완료, 그만두기, 다시 진행 — the person's press, never a tool's. */
    async setStatus(
      userId: string,
      id: string,
      status: GoalStatus,
    ): Promise<GoalView> {
      /*
       * 다시 진행 counts like a new goal (2026-09-27 code sprint): it used to skip the cap `create`
       * holds, so a finished goal pressed back to active could take a person past
       * GOALS_ACTIVE_MAX. The same lock as `create`, so a save and a resume racing cannot both pass.
       */
      const row = await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`laf_goals:${userId}`}))`,
        );
        if (status === "active") {
          const [current] = await transaction
            .select({ status: lafGoals.status })
            .from(lafGoals)
            .where(and(eq(lafGoals.id, id), eq(lafGoals.userId, userId)));
          if (current && current.status !== "active") {
            const [active] = await transaction
              .select({ n: count() })
              .from(lafGoals)
              .where(
                and(eq(lafGoals.userId, userId), eq(lafGoals.status, "active")),
              );
            if (Number(active?.n ?? 0) >= GOALS_ACTIVE_MAX) {
              throw new GoalsFull();
            }
          }
        }
        const [written] = await transaction
          .update(lafGoals)
          .set({ status, updatedAt: now() })
          .where(and(eq(lafGoals.id, id), eq(lafGoals.userId, userId)))
          .returning();
        return written;
      });
      if (!row) throw new GoalNotFound();
      return oneView(row);
    },

    /** Gone, entries with it. The routines linked to it stay, unlinked (`set null`). */
    async remove(userId: string, id: string): Promise<boolean> {
      const gone = await database
        .delete(lafGoals)
        .where(and(eq(lafGoals.id, id), eq(lafGoals.userId, userId)))
        .returning({ id: lafGoals.id });
      return gone.length > 0;
    },

    /** How many are active: the sidebar row's number and the phone tab's. */
    async activeCount(userId: string): Promise<number> {
      const [row] = await database
        .select({ n: count() })
        .from(lafGoals)
        .where(and(eq(lafGoals.userId, userId), eq(lafGoals.status, "active")));
      return Number(row?.n ?? 0);
    },

    /** This Bot's active goals for this person, as `list_goals` reads them. */
    async active(userId: string, agentId: string): Promise<GoalView[]> {
      const rows = await database
        .select()
        .from(lafGoals)
        .where(
          and(
            eq(lafGoals.userId, userId),
            eq(lafGoals.agentId, agentId),
            eq(lafGoals.status, "active"),
          ),
        )
        .orderBy(desc(lafGoals.updatedAt));
      return viewsOf(rows);
    },

    /**
     * An active goal of this Bot's for this person, by id or by the words of its title. Null when
     * none is, or when the words fit more than one.
     */
    async find(
      userId: string,
      agentId: string,
      reference: string,
    ): Promise<GoalRow | null> {
      // Active only: a goal the person finished or stopped takes nothing more from the Bot.
      const byId = await botRow(userId, agentId, reference);
      if (byId) return byId.status === "active" ? byId : null;
      const words = goalWords(reference);
      if (!words) return null;
      const rows = await database
        .select()
        .from(lafGoals)
        .where(
          and(
            eq(lafGoals.userId, userId),
            eq(lafGoals.agentId, agentId),
            eq(lafGoals.status, "active"),
          ),
        );
      const fits = rows.filter((row) => goalWords(row.title) === words);
      return fits.length === 1 ? (fits[0] ?? null) : null;
    },

    /** A new active goal, counted against the limit in the same transaction that writes it. */
    async create(goal: {
      userId: string;
      agentId: string;
      category: Category;
      title: string;
      target: string;
      measure: GoalMeasure | null;
      dueOn: string | null;
    }): Promise<GoalView> {
      const row = await database.transaction(async (transaction) => {
        // One person's goals at a time: two saves racing must not both pass the count.
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`laf_goals:${goal.userId}`}))`,
        );
        const [active] = await transaction
          .select({ n: count() })
          .from(lafGoals)
          .where(
            and(
              eq(lafGoals.userId, goal.userId),
              eq(lafGoals.status, "active"),
            ),
          );
        if (Number(active?.n ?? 0) >= GOALS_ACTIVE_MAX) throw new GoalsFull();
        const at = now();
        const [written] = await transaction
          .insert(lafGoals)
          .values({
            id: `goal_${randomUUID()}`,
            userId: goal.userId,
            agentId: goal.agentId,
            category: goal.category,
            title: goal.title,
            target: goal.target,
            measure: goal.measure,
            dueOn: goal.dueOn,
            status: "active",
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        return written;
      });
      if (!row) throw new GoalNotFound();
      return oneView(row);
    },

    /** What the person asked to change. Never the status. */
    async update(input: {
      userId: string;
      agentId: string;
      id: string;
      patch: GoalPatch;
    }): Promise<GoalView> {
      const [row] = await database
        .update(lafGoals)
        .set({ ...input.patch, updatedAt: now() })
        .where(
          and(
            eq(lafGoals.id, input.id),
            eq(lafGoals.userId, input.userId),
            eq(lafGoals.agentId, input.agentId),
          ),
        )
        .returning();
      if (!row) throw new GoalNotFound();
      return oneView(row);
    },

    /** One line on the timeline; the goal's momentum follows the entry that set one. */
    async log(entry: {
      userId: string;
      agentId: string;
      goalId: string;
      kind: GoalEntryKind;
      text: string;
      value: number | null;
      momentum: Momentum | null;
      source: GoalEntrySource;
      runId: string | null;
    }): Promise<{ entry: GoalEntryView; goal: GoalView }> {
      const at = now();
      const { goal, written } = await database.transaction(
        async (transaction) => {
          const [goal] = await transaction
            .update(lafGoals)
            .set({
              updatedAt: at,
              ...(entry.momentum ? { momentum: entry.momentum } : {}),
            })
            .where(
              and(
                eq(lafGoals.id, entry.goalId),
                eq(lafGoals.userId, entry.userId),
                eq(lafGoals.agentId, entry.agentId),
              ),
            )
            .returning();
          if (!goal) throw new GoalNotFound();
          const [written] = await transaction
            .insert(lafGoalEntries)
            .values({
              id: `goal_entry_${randomUUID()}`,
              goalId: entry.goalId,
              at,
              kind: entry.kind,
              text: entry.text,
              value: entry.value,
              momentum: entry.momentum,
              source: entry.source,
              runId: entry.runId,
            })
            .returning();
          if (!written) throw new GoalNotFound();
          return { goal, written };
        },
      );
      // Read after the commit: the view counts the entry this just wrote.
      return { entry: entryView(written), goal: await oneView(goal) };
    },

    /**
     * Link one of this Bot's routines, by its name, as the goal's check-in. Null when the Bot has no
     * routine by that name; the names it does have, for the model to try again with.
     */
    async linkRoutine(input: {
      agentId: string;
      goalId: string;
      routineName: string;
    }): Promise<{ id: string; name: string } | { names: string[] }> {
      const routines = await database
        .select({ id: lafRoutines.id, name: lafRoutines.name })
        .from(lafRoutines)
        .where(eq(lafRoutines.agentId, input.agentId));
      const wanted = goalWords(input.routineName);
      const fits = routines.filter(
        (routine) => goalWords(routine.name) === wanted,
      );
      const routine = fits.length === 1 ? fits[0] : undefined;
      if (!routine) return { names: routines.map((one) => one.name) };
      await database
        .update(lafRoutines)
        .set({ goalId: input.goalId, updatedAt: now() })
        .where(eq(lafRoutines.id, routine.id));
      return routine;
    },

    /** A routine's linked goal, if it is still active: what its run is told it checks. */
    async forRoutine(goalId: string): Promise<GoalRow | null> {
      const [row] = await database
        .select()
        .from(lafGoals)
        .where(and(eq(lafGoals.id, goalId), eq(lafGoals.status, "active")))
        .limit(1);
      return row ?? null;
    },
  };
}
