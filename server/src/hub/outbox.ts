/**
 * Writes to the company hub: a row first, then a request, until the hub has answered.
 *
 * WHY A ROW. A write a person or a run made — a message to a company room, a change to a task —
 * must not be lost because the hub was being upgraded at that moment, or because this process died
 * a second after it. So it is a `hub_outbox` row before it is a request, and the row is offered
 * again at boot, every five minutes, and the moment the hub comes back (`link.ts`). The row's id is
 * the `Idempotency-Key`, so a write the hub took and whose answer was lost is answered again rather
 * than written twice.
 *
 * ONE SENDER AT A TIME PER ROW, BY THE ROW'S LOCK. Each attempt holds `FOR UPDATE SKIP LOCKED` on
 * its row for exactly one request — never across the waits between retries, which would hold a
 * transaction connection for ten seconds against a hub that is down — so the boot sweep, the clock's
 * sweep and a send straight after a write can overlap and still send each row once at a time.
 *
 * WHAT ENDS A ROW. Delivered (2xx), or refused (any 4xx but 401 and 429): the same bytes will get
 * the same refusal. A 401 ends nothing — the row waits for a pass that works, and nothing is sent
 * until then (`paused`). A hub that does not answer leaves the row, and the sweep stops at it: the
 * rows behind it would meet the same hub.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { HUB_FACTS } from "../../../shared/hub/protocol";
import type { Database } from "../db/client";
import { hubOutbox } from "../db/schema";
import { log } from "../log";
import { HUB_RETRY_MS, type HubHttp } from "./http";

/** How often rows the hub has not taken are offered again (`boot/background.ts` runs it). */
export const HUB_OUTBOX_RESEND_MS = 5 * 60_000;

/** How long an answered row is kept, for an operator asking what was sent. */
const ANSWERED_KEPT_MS = 7 * 24 * 60 * 60_000;

export type HubOutboxWrite = {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  origin: "chat" | "room" | "job" | "person";
  runId?: string | null;
};

export type HubSweep = { delivered: number; refused: number; kept: number };

export type HubOutbox = {
  /** Writes the row and offers it at once. Answers its id, which is its `Idempotency-Key`. */
  enqueue(write: HubOutboxWrite): Promise<string>;
  /** Offers every row the hub has not answered, oldest first. One sweep at a time per process. */
  sweep(): Promise<HubSweep>;
};

type Attempt = "delivered" | "refused" | "unreachable" | "pass_refused";

export function createHubOutbox(input: {
  database: Database;
  http: HubHttp;
  /** True while the pass is refused: nothing is sent until a restart brings another. */
  paused?: () => boolean;
  /** Told when the hub refuses the pass, so the link says so once and stops too. */
  onPassRefused?: () => void;
  sleep?: (milliseconds: number) => Promise<void>;
}): HubOutbox {
  const { database, http } = input;
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let running: Promise<HubSweep> | null = null;
  let again = false;

  /** One request for one row, holding its lock for that request only. Null: another sender has it. */
  const attempt = (id: string | null, skip: readonly string[]) =>
    database.transaction(async (tx): Promise<[string, Attempt] | null> => {
      const pending = and(
        isNull(hubOutbox.deliveredAt),
        isNull(hubOutbox.refusedAt),
      );
      const [row] = await tx
        .select()
        .from(hubOutbox)
        .where(
          id
            ? and(eq(hubOutbox.id, id), pending)
            : skip.length
              ? and(
                  pending,
                  sql`${hubOutbox.id} not in (${sql.join(
                    skip.map((value) => sql`${value}`),
                    sql`, `,
                  )})`,
                )
              : pending,
        )
        .orderBy(hubOutbox.createdAt, hubOutbox.id)
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return null;
      const answer = await http.request({
        method: row.method as HubOutboxWrite["method"],
        path: row.path,
        ...(row.body === null || row.body === undefined
          ? {}
          : { body: row.body }),
        idempotencyKey: row.id,
        origin: row.origin,
        ...(row.runId ? { run: row.runId } : {}),
        retry: false,
      });
      const now = new Date();
      const outcome: Attempt = answer.ok
        ? "delivered"
        : answer.code === HUB_FACTS.passRefused
          ? "pass_refused"
          : answer.code === HUB_FACTS.unreachable
            ? "unreachable"
            : "refused";
      await tx
        .update(hubOutbox)
        .set({
          attempts: sql`${hubOutbox.attempts} + 1`,
          lastTriedAt: now,
          lastCode: answer.ok ? null : answer.code,
          status: answer.status,
          ...(outcome === "delivered" ? { deliveredAt: now } : {}),
          ...(outcome === "refused" ? { refusedAt: now } : {}),
        })
        .where(eq(hubOutbox.id, row.id));
      return [row.id, outcome];
    });

  const sweepOnce = async (): Promise<HubSweep> => {
    const tally: HubSweep = { delivered: 0, refused: 0, kept: 0 };
    await database
      .delete(hubOutbox)
      .where(
        and(
          or(isNotNull(hubOutbox.deliveredAt), isNotNull(hubOutbox.refusedAt)),
          lt(hubOutbox.createdAt, new Date(Date.now() - ANSWERED_KEPT_MS)),
        ),
      );
    /** Rows another sender held when this sweep reached them: theirs, not to be waited on. */
    const skipped: string[] = [];
    for (;;) {
      if (input.paused?.()) return tally;
      let result = await attempt(null, skipped);
      if (!result) return tally;
      const [id] = result;
      for (const wait of HUB_RETRY_MS) {
        if (result?.[1] !== "unreachable") break;
        await sleep(wait);
        if (input.paused?.()) break;
        result = await attempt(id, []);
        // Taken by another sender in the wait, or answered by it: either way not this sweep's.
        if (!result) break;
      }
      const outcome = result?.[1];
      if (!outcome) {
        skipped.push(id);
        continue;
      }
      if (outcome === "delivered") tally.delivered += 1;
      else if (outcome === "refused") tally.refused += 1;
      else {
        tally.kept += 1;
        if (outcome === "pass_refused") input.onPassRefused?.();
        // The rows behind it would meet the same hub. They wait for the next sweep.
        log.info("hub_outbox_kept", { code: outcome });
        return tally;
      }
    }
  };

  const sweep = (): Promise<HubSweep> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      const total: HubSweep = { delivered: 0, refused: 0, kept: 0 };
      try {
        do {
          again = false;
          const one = await sweepOnce();
          total.delivered += one.delivered;
          total.refused += one.refused;
          total.kept += one.kept;
        } while (again && total.kept === 0);
      } catch (error) {
        log.warn("hub_outbox_sweep_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        running = null;
      }
      return total;
    })();
    return running;
  };

  return {
    async enqueue(write) {
      const id = randomUUID();
      await database.insert(hubOutbox).values({
        id,
        method: write.method,
        path: write.path,
        body: write.body ?? null,
        origin: write.origin,
        runId: write.runId ?? null,
      });
      void sweep();
      return id;
    },
    sweep,
  };
}
