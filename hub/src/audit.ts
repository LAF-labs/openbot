import type { Context } from "hono";
import { HUB_HEADERS } from "../../shared/hub/protocol";
import type { MemberVariables } from "./auth";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubAudit } from "./db/schema";

/**
 * One row of the trail. Identifiers and outcomes only: what was done to which id, by whom, from
 * which VM, in which run. Never a value — no pass, no hash, no content.
 */
export type AuditEntry = {
  action: string;
  member?: string | null;
  vmOrigin?: string | null;
  target?: string | null;
  runId?: string | null;
  outcome?: string | null;
  payload?: Record<string, unknown> | null;
};

export async function recordAudit(
  tx: HubDatabase | HubTransaction,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(hubAudit).values({
    action: entry.action,
    member: entry.member ?? null,
    vmOrigin: entry.vmOrigin ?? null,
    target: entry.target ?? null,
    runId: entry.runId ?? null,
    outcome: entry.outcome ?? null,
    payload: entry.payload ?? null,
  });
}

/** A VM's run id, as the trail keeps it: an identifier of bounded shape, or nothing. */
const RUN_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Who asked, from which VM and in which run: the part of a trail row every member route shares. */
export function trailOf(context: Context<{ Variables: MemberVariables }>) {
  const member = context.get("member");
  const run = context.req.header(HUB_HEADERS.run);
  return {
    member: member.id,
    vmOrigin: member.vmOrigin,
    runId: run && RUN_SHAPE.test(run) ? run : null,
  };
}
