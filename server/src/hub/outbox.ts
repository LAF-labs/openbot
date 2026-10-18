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
 *
 * UPLOADS GO IN A LANE OF THEIR OWN. One upload's attempt is as long as its file (`http.ts`, up to
 * half an hour on a slow line); a room post written meanwhile must not stand behind it, or be read
 * as kept because the hub is away while the hub is up. Each lane is one sweep at a time, oldest
 * first, and a hub found away stops only the lane that found it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { HUB_FACTS } from "../../../shared/hub/protocol";
import type { Database } from "../db/client";
import { hubOutbox } from "../db/schema";
import { log } from "../log";
import { HUB_RETRY_MS, type HubAnswer, type HubHttp } from "./http";
import {
  HUB_UPLOAD_SOURCE_AWAY,
  type HubUploadReference,
  uploadReferenceOf,
} from "./upload";

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

export type HubOutboxLane = "writes" | "uploads";

export type HubOutbox = {
  /** Writes the row and offers it at once. Answers its id, which is its `Idempotency-Key`. */
  enqueue(write: HubOutboxWrite): Promise<string>;
  /**
   * Offers every row of a lane the hub has not answered, oldest first; both lanes when none is
   * named. One sweep at a time per lane per process.
   */
  sweep(lane?: HubOutboxLane): Promise<HubSweep>;
};

/**
 * `waiting`: an upload whose file could not be read again because the computer did not answer.
 * `busy`: an upload the hub asked for again (`ASKED_AGAIN`), tried again after the same waits as a
 * hub that did not answer. Either way the row stays, but the hub is not away, so the rows behind it
 * are still offered.
 */
type Attempt =
  | "delivered"
  | "refused"
  | "unreachable"
  | "pass_refused"
  | "waiting"
  | "busy";

/**
 * What a hub that is there says to an upload it will take later: too many at once
 * (`hub/src/files/routes.ts`), or its upload listener failing on this one (`hub/src/uploads.ts`).
 * Every other code it names ends the row — a hub with no file space (`laf:hub_files_unset`) says so
 * to every upload, and a full one until somebody makes room.
 */
const ASKED_AGAIN: ReadonlySet<string> = new Set([
  HUB_FACTS.busy,
  "laf:hub_failed",
]);

/** An upload's row (`upload.ts`, `uploadReferenceOf`): its lane, in SQL and in a write. */
const UPLOAD_ROW = sql`coalesce(jsonb_typeof(${hubOutbox.body} -> 'upload') = 'object', false)`;
const inUploadLane = (body: unknown) => {
  const upload =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { upload?: unknown }).upload
      : undefined;
  return (
    Boolean(upload) && typeof upload === "object" && !Array.isArray(upload)
  );
};

export function createHubOutbox(input: {
  database: Database;
  http: HubHttp;
  /** True while the pass is refused: nothing is sent until a restart brings another. */
  paused?: () => boolean;
  /** Told when the hub refuses the pass, so the link says so once and stops too. */
  onPassRefused?: () => void;
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * A row that holds an upload's reference, sent (`upload.ts`, `sendReference`): the file read
   * again and checked against what was judged. Absent, such a row waits like one whose file is
   * out of reach.
   */
  sendUpload?: (
    reference: HubUploadReference,
    request: { idempotencyKey: string; origin: string; run?: string },
  ) => Promise<HubAnswer<unknown>>;
}): HubOutbox {
  const { database, http } = input;
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const running: Record<HubOutboxLane, Promise<HubSweep> | null> = {
    writes: null,
    uploads: null,
  };
  const again: Record<HubOutboxLane, boolean> = {
    writes: false,
    uploads: false,
  };

  /** One request for one row, holding its lock for that request only. Null: another sender has it. */
  const attempt = (
    lane: HubOutboxLane,
    id: string | null,
    skip: readonly string[],
  ) =>
    database.transaction(async (tx): Promise<[string, Attempt] | null> => {
      const pending = and(
        isNull(hubOutbox.deliveredAt),
        isNull(hubOutbox.refusedAt),
        lane === "uploads" ? UPLOAD_ROW : sql`not ${UPLOAD_ROW}`,
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
      // An upload's row holds where its file is, never the bytes: read again for each attempt.
      const upload = uploadReferenceOf(row.body);
      const answer: HubAnswer<unknown> = upload
        ? input.sendUpload
          ? await input.sendUpload(upload, {
              idempotencyKey: row.id,
              origin: row.origin,
              ...(row.runId ? { run: row.runId } : {}),
            })
          : { ok: false, status: null, code: HUB_UPLOAD_SOURCE_AWAY }
        : await http.request({
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
            : upload && answer.code === HUB_UPLOAD_SOURCE_AWAY
              ? "waiting"
              : upload && ASKED_AGAIN.has(answer.code)
                ? "busy"
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

  /**
   * One pass over a lane. `skipped`: rows another sender held when this sweep reached them — theirs,
   * not to be waited on — and rows kept for a reason that is not the hub away, offered again by the
   * next sweep and not by this one. `stopped`: it met a hub that is away, or a pass it refused.
   */
  const sweepOnce = async (
    lane: HubOutboxLane,
    skipped: string[],
  ): Promise<HubSweep & { stopped: boolean }> => {
    const tally = { delivered: 0, refused: 0, kept: 0, stopped: false };
    await database
      .delete(hubOutbox)
      .where(
        and(
          or(isNotNull(hubOutbox.deliveredAt), isNotNull(hubOutbox.refusedAt)),
          lt(hubOutbox.createdAt, new Date(Date.now() - ANSWERED_KEPT_MS)),
        ),
      );
    for (;;) {
      if (input.paused?.()) return tally;
      let result = await attempt(lane, null, skipped);
      if (!result) return tally;
      const [id] = result;
      for (const wait of HUB_RETRY_MS) {
        if (result?.[1] !== "unreachable" && result?.[1] !== "busy") break;
        await sleep(wait);
        if (input.paused?.()) break;
        result = await attempt(lane, id, []);
        // Taken by another sender in the wait, or answered by it: either way not this sweep's.
        if (!result) break;
      }
      const outcome = result?.[1];
      if (!outcome) {
        skipped.push(id);
        continue;
      }
      // Its own file out of reach, or a hub that is there and wants it later: it waits for the next
      // sweep, the rest go on.
      if (outcome === "waiting" || outcome === "busy") {
        tally.kept += 1;
        skipped.push(id);
        continue;
      }
      if (outcome === "delivered") tally.delivered += 1;
      else if (outcome === "refused") tally.refused += 1;
      else {
        tally.kept += 1;
        tally.stopped = true;
        if (outcome === "pass_refused") input.onPassRefused?.();
        // The rows behind it would meet the same hub. They wait for the next sweep.
        log.info("hub_outbox_kept", { code: outcome });
        return tally;
      }
    }
  };

  const sweepLane = (lane: HubOutboxLane): Promise<HubSweep> => {
    const current = running[lane];
    if (current) {
      again[lane] = true;
      return current;
    }
    const started = (async () => {
      const total: HubSweep = { delivered: 0, refused: 0, kept: 0 };
      try {
        let stopped = false;
        const skipped: string[] = [];
        do {
          again[lane] = false;
          const one = await sweepOnce(lane, skipped);
          total.delivered += one.delivered;
          total.refused += one.refused;
          total.kept += one.kept;
          stopped = one.stopped;
          // Asked again while it ran: a row written after its last look is offered now, not in five
          // minutes — unless the hub was found away, which the next sweep would only find again.
        } while (again[lane] && !stopped);
      } catch (error) {
        log.warn("hub_outbox_sweep_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        running[lane] = null;
      }
      return total;
    })();
    running[lane] = started;
    return started;
  };

  const sweep = async (lane?: HubOutboxLane): Promise<HubSweep> => {
    if (lane) return sweepLane(lane);
    const [writes, uploads] = await Promise.all([
      sweepLane("writes"),
      sweepLane("uploads"),
    ]);
    return {
      delivered: writes.delivered + uploads.delivered,
      refused: writes.refused + uploads.refused,
      kept: writes.kept + uploads.kept,
    };
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
      void sweepLane(inUploadLane(write.body) ? "uploads" : "writes");
      return id;
    },
    sweep,
  };
}
