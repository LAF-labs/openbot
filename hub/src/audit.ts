import type { HubTransaction } from "./db/client";
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
  tx: HubTransaction,
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
