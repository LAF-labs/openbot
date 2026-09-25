import type { Database } from "../db/client";
import { agentMemoryReceipts } from "../db/schema";
import { describeFailure } from "../failure-text";
import { log } from "../log";

/** What one run of the memory's background work did, in counts. Never a line, never a summary. */
export type MemoryReceipt = {
  agentId: string;
  ownerUserId: string;
  job: "curation" | "dream" | "forget";
  checked?: number;
  confirmed?: number;
  dropped?: number;
  superseded?: number;
  scrubbed?: number;
  arm?: string | null;
};

/**
 * One receipt row (`agent_memory_receipts`), and a log line that says the same. A receipt that could
 * not be written is logged and swallowed: the work it records has already happened.
 */
export async function recordMemoryReceipt(
  database: Database,
  receipt: MemoryReceipt,
): Promise<void> {
  const counts = {
    checked: receipt.checked ?? 0,
    confirmed: receipt.confirmed ?? 0,
    dropped: receipt.dropped ?? 0,
    superseded: receipt.superseded ?? 0,
    scrubbed: receipt.scrubbed ?? 0,
  };
  log.info("memory_receipt", {
    bot: receipt.agentId,
    job: receipt.job,
    ...counts,
    arm: receipt.arm ?? null,
  });
  try {
    await database.insert(agentMemoryReceipts).values({
      id: `receipt_${crypto.randomUUID()}`,
      agentId: receipt.agentId,
      ownerUserId: receipt.ownerUserId,
      job: receipt.job,
      ...counts,
      arm: receipt.arm ?? null,
    });
  } catch (error) {
    log.warn("memory_receipt_unsaved", { reason: describeFailure(error) });
  }
}
