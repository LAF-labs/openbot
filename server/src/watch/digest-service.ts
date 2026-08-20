/**
 * When the morning card goes out, and where.
 *
 * Delivery is a separate concern from composition (digest.ts) on purpose: the
 * service emits one card and whoever is configured listens — a webhook today,
 * the AlimTalk gateway once that channel clears review. A deployment with no
 * channel still composes and logs the card, because the digest is also the
 * record that the watching happened.
 */
import { randomUUID } from "node:crypto";
import { desc, eq, gte } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  lafDigestLog,
  lafThreadRuns,
  lafWatchEvents,
  lafWatchSources,
} from "../db/schema";
import { normalizeSignals } from "./differ";
import {
  buildDigest,
  type Digest,
  type DigestEvent,
  digestDue,
} from "./digest";

const WINDOW_HOURS = 24;
const SEND_TIMEOUT_MS = 15_000;

export type DigestServiceOptions = {
  /** Hour of day (0-23) in `timezone` after which the daily card is due. */
  hour: number;
  timezone: string;
  /** POSTed `{headline, body, quiet, forDate}` as JSON. Absent logs to stdout only. */
  webhookUrl?: string;
};

export type DigestService = {
  /** Compose the card for the last 24h without sending or logging it. */
  preview(): Promise<Digest>;
  /** Compose, deliver and log — the hand-crank behind the admin route. */
  sendNow(forDate?: string): Promise<{ digest: Digest; ok: boolean }>;
  start(tickMs: number): void;
  stop(): void;
};

export function createDigestService(
  database: Database,
  options: DigestServiceOptions,
): DigestService {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  async function compose(): Promise<Digest> {
    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
    const sources = await database.select().from(lafWatchSources);
    const sourceNameById = new Map(
      sources.map((source) => [source.id, source.name]),
    );
    const events = await database
      .select()
      .from(lafWatchEvents)
      .where(gte(lafWatchEvents.observedAt, since));
    const runs = await database
      .select()
      .from(lafThreadRuns)
      .where(gte(lafThreadRuns.startedAt, since));
    const dateLabel = new Intl.DateTimeFormat("ko-KR", {
      timeZone: options.timezone,
      month: "numeric",
      day: "numeric",
    }).format(new Date());
    return buildDigest({
      dateLabel,
      sources: sources.map((source) => ({
        name: source.name,
        signals: normalizeSignals(source.lastSignals),
        lastError: source.lastError,
      })),
      events: events.map(
        (event): DigestEvent => ({
          sourceName: sourceNameById.get(event.sourceId) ?? event.sourceId,
          key: event.key,
          prevStatus: event.prevStatus,
          nextStatus: event.nextStatus,
          detail: event.detail,
          observedAt: event.observedAt,
        }),
      ),
      runs,
    });
  }

  async function deliver(
    digest: Digest,
  ): Promise<{ channel: string; error: string | null }> {
    if (!options.webhookUrl) {
      console.info(`[digest] ${digest.headline}`);
      return { channel: "stdout", error: null };
    }
    try {
      const response = await fetch(options.webhookUrl, {
        method: "POST",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          headline: digest.headline,
          body: digest.body,
          quiet: digest.quiet,
        }),
      });
      if (!response.ok) {
        return { channel: "webhook", error: `answered ${response.status}` };
      }
      return { channel: "webhook", error: null };
    } catch (error) {
      return {
        channel: "webhook",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function sendNow(forDate?: string) {
    const digest = await compose();
    const outcome = await deliver(digest);
    await database.insert(lafDigestLog).values({
      id: randomUUID(),
      forDate: forDate ?? "manual",
      channel: outcome.channel,
      ok: outcome.error === null,
      error: outcome.error,
      headline: digest.headline,
      body: digest.body,
    });
    return { digest, ok: outcome.error === null };
  }

  async function lastSentForDate(): Promise<string | null> {
    const [row] = await database
      .select({ forDate: lafDigestLog.forDate })
      .from(lafDigestLog)
      .where(eq(lafDigestLog.ok, true))
      .orderBy(desc(lafDigestLog.sentAt))
      .limit(1);
    return row?.forDate ?? null;
  }

  async function tick(): Promise<void> {
    if (ticking) {
      return;
    }
    ticking = true;
    try {
      const due = digestDue(
        new Date(),
        options.timezone,
        options.hour,
        await lastSentForDate(),
      );
      if (due) {
        await sendNow(due);
      }
    } catch (error) {
      console.error("[digest] tick failed:", error);
    } finally {
      ticking = false;
    }
  }

  return {
    preview: compose,
    sendNow,
    start(tickMs) {
      if (timer || tickMs <= 0) {
        return;
      }
      timer = setInterval(() => void tick(), tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
