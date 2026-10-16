import { eq, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { HubVisibility } from "../../shared/hub/protocol";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubTaskMembers } from "./db/schema";

/**
 * WHO MAY SEE A ROW, WRITTEN ONCE. Every query that reads a file, a version or a chunk puts this
 * in its WHERE — search included, because a page filtered after the query ends where the
 * unfiltered one did and its cut says nothing true about what is left
 * (`server/src/search/conversations.ts` learnt that).
 *
 * A fragment the query embeds rather than a SQL function it calls: Postgres does not inline a SQL
 * function whose body holds a sub-select (measured on this migration: `hub_visible_to(…)` stayed
 * an opaque call per row in the plan), and the planner then can neither see the comparison nor
 * run the task lookup once. Written this way the task lookup does not depend on the row, so it is
 * run once per query and hashed.
 */
export function visibleTo(visibility: AnyPgColumn, member: string): SQL {
  return sql`(${visibility} = 'company' or ${visibility} = ${`me:${member}`} or ${visibility} in (select 'task:' || ${hubTaskMembers.taskId} from ${hubTaskMembers} where ${hubTaskMembers.memberId} = ${member}))`;
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type VisibilityChoice =
  | { ok: true; visibility: HubVisibility; taskId: string | null }
  | { ok: false; status: 400 | 403 };

/**
 * What a member may give a file they upload. `company`, their own `me:`, or a task they are on —
 * never somebody else's `me:` (a file put where only another person sees it is a file the uploader
 * cannot take back) and never a task they are not on, for the same reason.
 */
export async function chooseVisibility(
  database: HubDatabase | HubTransaction,
  raw: unknown,
  member: string,
): Promise<VisibilityChoice> {
  if (raw === undefined || raw === "company") {
    return { ok: true, visibility: "company", taskId: null };
  }
  if (typeof raw !== "string") return { ok: false, status: 400 };
  if (raw.startsWith("me:")) {
    return raw === `me:${member}`
      ? { ok: true, visibility: `me:${member}`, taskId: null }
      : { ok: false, status: 403 };
  }
  if (raw.startsWith("task:")) {
    const taskId = raw.slice(5);
    if (!TASK_ID.test(taskId)) return { ok: false, status: 400 };
    const audience = await taskMembers(database, taskId);
    return audience.includes(member)
      ? { ok: true, visibility: `task:${taskId}`, taskId }
      : { ok: false, status: 403 };
  }
  return { ok: false, status: 400 };
}

async function taskMembers(
  database: HubDatabase | HubTransaction,
  taskId: string,
): Promise<string[]> {
  const rows = await database
    .select({ member: hubTaskMembers.memberId })
    .from(hubTaskMembers)
    .where(eq(hubTaskMembers.taskId, taskId));
  return rows.map((row) => row.member);
}

/**
 * Who an event about a row of this visibility goes to: null is everybody. An event names only an
 * id, but "a file you cannot see changed" is still something said, so it goes only to those who
 * can see the row (`hub_events.visible_to`).
 */
export async function audienceOf(
  tx: HubTransaction,
  visibility: string,
): Promise<string[] | null> {
  if (visibility === "company") return null;
  if (visibility.startsWith("me:")) return [visibility.slice(3)];
  if (visibility.startsWith("task:")) {
    return taskMembers(tx, visibility.slice(5));
  }
  // A value the table's check refuses; nobody, rather than everybody, if one ever got in.
  return [];
}
