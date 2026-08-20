/**
 * The watcher: polls `laf.watch` sources on a clock, and wakes nothing unless
 * something changed.
 *
 * The cost rule of an always-on product is that no model runs on a schedule.
 * Everything in this file is plain code — fetch, normalize, diff, three rows of
 * SQL — and the one place a model appears (`wake`) is behind `changes.length > 0`
 * and an administrator having said, on the source, which Bot should hear about it.
 *
 * A source that stops answering is itself a signal. Failures are folded into the
 * same diff as `watch.source: fail`, so silence becomes one event when it starts
 * and one when it ends, never a page of repeats.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafThreadRuns, lafWatchEvents, lafWatchSources } from "../db/schema";
import { callTool } from "../plugins/mcp";
import {
  describeChanges,
  diffSignals,
  normalizeSignals,
  type SignalChange,
  type WatchSignal,
} from "./differ";

const FETCH_TIMEOUT_MS = 15_000;
const WAKE_TIMEOUT_MS = 120_000;
/** The name the contract fixes; the one tool every Tier-A server must expose. */
const WATCH_TOOL = "laf.watch";
/** The key failures are reported under, in the same namespace as real signals. */
const SOURCE_META_KEY = "watch.source";

export type WatchSourceRow = typeof lafWatchSources.$inferSelect;

export type NewWatchSource = {
  name: string;
  kind: "http" | "mcp";
  url: string;
  intervalSeconds?: number;
  wakeAgentId?: string | null;
};

export type PollOutcome = {
  signals: WatchSignal[];
  changes: SignalChange[];
  error: string | null;
};

export type WatchService = {
  listSources(): Promise<WatchSourceRow[]>;
  createSource(input: NewWatchSource): Promise<WatchSourceRow>;
  deleteSource(id: string): Promise<boolean>;
  pollNow(id: string): Promise<PollOutcome | null>;
  start(tickMs: number): void;
  stop(): void;
};

export function createWatchService(
  database: Database,
  options: { port: number },
): WatchService {
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;

  async function fetchSignals(source: WatchSourceRow): Promise<unknown> {
    if (source.kind === "mcp") {
      const result = await callTool({ url: source.url }, WATCH_TOOL, {});
      if (result.isError) {
        throw new Error(
          `laf.watch answered an error: ${result.text.slice(0, 200)}`,
        );
      }
      return JSON.parse(result.text);
    }
    // Plain HTTP is the development door; the contract's door is MCP. Sources are
    // administrator-created, which is why this may reach private hosts on purpose.
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`answered ${response.status}`);
    }
    return await response.json();
  }

  async function persistOutcome(
    source: WatchSourceRow,
    next: WatchSignal[],
    changes: SignalChange[],
    errorMessage: string | null,
  ): Promise<string[]> {
    const eventIds: string[] = [];
    for (const change of changes) {
      const id = randomUUID();
      eventIds.push(id);
      await database.insert(lafWatchEvents).values({
        id,
        sourceId: source.id,
        key: change.key,
        prevStatus: change.prevStatus,
        nextStatus: change.nextStatus,
        detail: change.detail ?? null,
      });
    }
    await database
      .update(lafWatchSources)
      .set({
        lastSignals: sql`${JSON.stringify(next)}::text::jsonb`,
        lastPolledAt: new Date(),
        lastError: errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(lafWatchSources.id, source.id));
    return eventIds;
  }

  /**
   * The one model call in the file. Reuses the runtime's own HTTP door on
   * localhost rather than reaching into the runner, so a wake is externally
   * indistinguishable from a person sending the report — same policy, same
   * persistence, same audit posture. Failure marks nothing delivered and the
   * events stay visible for the digest.
   */
  async function wake(
    source: WatchSourceRow,
    changes: SignalChange[],
    eventIds: string[],
  ): Promise<void> {
    if (!source.wakeAgentId || changes.length === 0) {
      return;
    }
    /*
     * The dedupe key is the first event's id: a wake exists to deliver those
     * events, and a second run keyed to the same events is the double-send
     * this exists to prevent — a re-poll racing a slow wake, a restart
     * replaying a tick. Checked at the sender because the sender is where
     * machines enter the run queue; the unique column is the backstop.
     */
    const dedupeKey = `wake-${eventIds[0] ?? randomUUID()}`;
    const [duplicate] = await database
      .select({ runId: lafThreadRuns.runId })
      .from(lafThreadRuns)
      .where(eq(lafThreadRuns.dedupeKey, dedupeKey))
      .limit(1);
    if (duplicate) {
      console.info(
        `[watch] wake for source '${source.name}' skipped: already ran as ${duplicate.runId}`,
      );
      return;
    }
    const report = [
      `[laf.watch] Source "${source.name}" changed:`,
      describeChanges(changes),
      "Write a short operational note for the owner: what changed, and what to check first.",
    ].join("\n");
    const response = await fetch(
      `http://127.0.0.1:${options.port}/api/copilotkit/agent/${encodeURIComponent(source.wakeAgentId)}/run`,
      {
        method: "POST",
        signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          threadId: `watch-${source.id}`,
          runId: `watch-${randomUUID()}`,
          state: {},
          messages: [
            {
              id: `watch-report-${eventIds[0] ?? randomUUID()}`,
              role: "user",
              content: report,
            },
          ],
          tools: [],
          context: [],
          forwardedProps: { lafOrigin: "wake", lafDedupeKey: dedupeKey },
        }),
      },
    );
    // The stream must be drained or the run above never finishes.
    await response.text();
    if (!response.ok) {
      throw new Error(`wake run answered ${response.status}`);
    }
    if (eventIds.length > 0) {
      await database
        .update(lafWatchEvents)
        .set({ deliveredAt: new Date() })
        .where(inArray(lafWatchEvents.id, eventIds));
    }
  }

  async function poll(source: WatchSourceRow): Promise<PollOutcome> {
    const prev = normalizeSignals(source.lastSignals);
    let next: WatchSignal[];
    let errorMessage: string | null = null;
    try {
      next = normalizeSignals(await fetchSignals(source));
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      next = normalizeSignals({
        signals: [
          { key: SOURCE_META_KEY, status: "fail", detail: errorMessage },
        ],
      });
    }
    const changes = diffSignals(prev, next);
    const eventIds = await persistOutcome(source, next, changes, errorMessage);
    try {
      await wake(source, changes, eventIds);
    } catch (error) {
      console.error(
        `[watch] wake for source '${source.name}' failed:`,
        error instanceof Error ? error.message : error,
      );
    }
    return { signals: next, changes, error: errorMessage };
  }

  async function tick(): Promise<void> {
    if (ticking) {
      return;
    }
    ticking = true;
    try {
      const sources = await database.select().from(lafWatchSources);
      const now = Date.now();
      for (const source of sources) {
        if (!source.enabled) {
          continue;
        }
        const last = source.lastPolledAt?.getTime() ?? 0;
        if (now - last < source.intervalSeconds * 1000) {
          continue;
        }
        await poll(source);
      }
    } catch (error) {
      console.error("[watch] tick failed:", error);
    } finally {
      ticking = false;
    }
  }

  return {
    async listSources() {
      return database.select().from(lafWatchSources);
    },
    async createSource(input) {
      const row = {
        id: randomUUID(),
        name: input.name,
        kind: input.kind,
        url: input.url,
        intervalSeconds: input.intervalSeconds ?? 60,
        wakeAgentId: input.wakeAgentId ?? null,
      };
      const [created] = await database
        .insert(lafWatchSources)
        .values(row)
        .returning();
      if (!created) {
        throw new Error("insert returned no row");
      }
      return created;
    },
    async deleteSource(id) {
      const deleted = await database
        .delete(lafWatchSources)
        .where(eq(lafWatchSources.id, id))
        .returning({ id: lafWatchSources.id });
      return deleted.length > 0;
    },
    async pollNow(id) {
      const [source] = await database
        .select()
        .from(lafWatchSources)
        .where(eq(lafWatchSources.id, id));
      if (!source) {
        return null;
      }
      return poll(source);
    },
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
