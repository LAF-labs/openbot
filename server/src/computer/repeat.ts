import { randomUUID } from "node:crypto";
import { and, eq, lte, notExists, sql, count as sqlCount } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  computerRepeatCalls,
  computerRepeatReports,
} from "../db/schema/computer";

/**
 * How many times a Bot has just made this exact call.
 *
 * A model that cannot get something to work retries. It clicks the same button, reloads the same
 * page, writes the same file, and every one of those attempts is a real action on somebody's live
 * website and a real charge against somebody's model credit. The trail records all thirty of them,
 * one row at a time, with nothing to say that they are the same row thirty times over, so nobody
 * notices until the other side's rate limiter does.
 *
 * This counts, and it does nothing else with the answer. The count goes to the policy, which is the
 * one thing in this codebase allowed to refuse an action. A detector that blocked on its own would
 * be a second boundary with rules of its own, invisible on the Boundaries page, unanswerable to
 * `dry-run`, and impossible to switch off for the one Bot whose job really is to poll something.
 * One boundary, given better information.
 *
 * Two detectors live here. The in-memory one is right on one machine and is what the unit tests
 * drive; the database-backed one is what a deployment runs, because several servers behind a load
 * balancer each see a fraction of a Bot's calls and a rule written against the count then never
 * fires. Both are held to one contract, in approval-registry-contract's sibling test, so the one
 * nobody ships cannot be the only one that works.
 */

/**
 * How long a call stays counted.
 *
 * Time rather than "this turn", because the gateway has no idea where a turn begins or ends. It is
 * handed one action at a time by whichever route is serving the model, and nothing in that path
 * carries a turn boundary; inventing one would mean threading a conversation id through every acting
 * call to get a worse answer than a clock gives.
 *
 * Three minutes. A retry loop is a model round trip each time round — call the tool, read the
 * failure, decide to try again — which is seconds, not minutes, so ten identical attempts fit inside
 * this comfortably. Much longer and honest repetition starts to accumulate: a Bot told to watch a
 * dashboard reloads the same page all morning and is not stuck. Much shorter and a model that thinks
 * for twenty seconds between attempts never trips anything.
 */
export const DEFAULT_REPEAT_WINDOW_MS = 3 * 60_000;

/**
 * The counts worth writing a row about.
 *
 * Three is "this is now a pattern rather than a retry", ten is "nobody is going to fix this by
 * trying again", twenty-five is "somebody should look". Each fires once, so the trail gains three
 * rows for a Bot stuck all afternoon rather than a row per attempt, which would bury the actions it
 * was taking under the observation that it kept taking them.
 */
export const DEFAULT_REPEAT_THRESHOLDS: readonly number[] = [3, 10, 25];

/**
 * How many distinct calls are remembered per Bot.
 *
 * A Bot doing genuinely varied work never repeats anything, so every call it makes is a new key, and
 * without a cap the map grows for exactly the Bots this feature has nothing to say about.
 *
 * Full means full. A call the Bot has not made before is not counted, and nothing still inside the
 * window is dropped to make room for it, because dropping something is a guess at which key will not
 * come round again and the obvious guess is the one that fails hardest. Least recently seen is
 * exactly the key a Bot going round a long loop is about to make next, so a loop of more than this
 * many distinct calls would lose each key one step before it returned, and a Bot in a tight circle
 * would be reported as making every one of its calls for the first time.
 *
 * The cost is the Bot whose first sixty-four distinct calls are honest work and which only then gets
 * stuck: its loop is invisible until one of those sixty-four falls out of the window, which is at
 * most one window away. A blind spot that clears itself is worth more than an eviction rule that can
 * be wrong for as long as the loop lasts, and it buys the other half of the bargain, that a call
 * already being counted can never be pushed out by a Bot doing other things in between.
 */
export const DEFAULT_REPEAT_KEYS_PER_BOT = 64;

/**
 * How many Bots are remembered at once.
 *
 * The id counted against is the one in the request path. It is checked against a session and against
 * nothing else, because a Bot's computer answers to whatever it is addressed as and no acting route
 * resolves the id to a row in `bots` first. So the number of ids this map can be asked to hold is
 * not the number of Bots somebody wrote down, it is however many a signed-in caller cares to type,
 * and an uncapped map of maps would grow for the life of the process on nothing more than a loop of
 * requests naming a fresh id each time.
 *
 * Reclaimed the way the per-Bot cap is: a Bot that has gone quiet for a whole window gives its place
 * up, and while every place is held by a Bot that is still working, one more Bot is not counted.
 * Two hundred and fifty-six, which is far more Bots than a deployment has acting inside any three
 * minutes, and small enough that the worst case is a few megabytes rather than the whole heap.
 */
export const DEFAULT_REPEAT_BOTS = 256;

/**
 * One governed call, in the terms the detector cares about.
 *
 * The same fields the gateway already assembles for the policy and the audit row. Nothing is added
 * to a call site to support this.
 */
export type RepeatedCall = {
  tool: string;
  ref?: string | undefined;
  key?: string | undefined;
  filePath?: string | undefined;
  targetUrl?: string | undefined;
};

export type RepeatObservation = {
  /**
   * Including the call being observed, so the first one counts as one.
   *
   * One is also the answer for a call the detector had no room to remember, and for one carrying
   * nothing to identify it. It is the only number that cannot make anything happen: a rule about
   * repetition reads it as a first attempt and stands aside. A count nobody can substantiate must
   * never be the reason a Bot is refused.
   */
  count: number;
  /**
   * The call's identity, in a form a person can read.
   *
   * Null when nothing distinguished it. See `fingerprintOf`: a bare tool name is not a call worth
   * counting, and the honest count for one of those is a single occurrence.
   */
  fingerprint: string | null;
  /**
   * The threshold this call has just reached, or null on the overwhelming majority of calls.
   *
   * Reported once per run of repetition rather than on every call past it. A run ends when the
   * window empties completely, and a key that fills it again afterwards reports again, because that
   * is a Bot that got stuck twice. A count that merely dips and climbs is the same run still going
   * and says nothing further: one incident, one row per threshold, or a row per wobble would be a
   * row per attempt under another name.
   */
  threshold: number | null;
};

export type RepeatDetector = {
  /**
   * Records the call and answers with what it now knows. Never throws.
   *
   * One round trip for the store that has to be shared, on a path that is already making a remote
   * call to a browser; the in-memory detector resolves without one. It is awaited before the policy
   * is asked, so a rule written against the count decides the very attempt that crossed the line.
   */
  observe: (botId: string, call: RepeatedCall) => Promise<RepeatObservation>;
};

export type RepeatDetectorOptions = {
  windowMs?: number;
  thresholds?: readonly number[];
  maxKeysPerBot?: number;
  maxBots?: number;
  /** Injected so a test can move time without waiting for it. */
  now?: () => number;
};

/** One key's history, held only while it is still inside the window. */
type Occurrences = {
  /** When each counted call happened, oldest first. */
  at: number[];
  /** Which thresholds this run of repetition has already reported. */
  reported: Set<number>;
};

/**
 * One Bot's history, and when it was last heard from.
 *
 * The time is kept here as well as inside the keys because a Bot that has stopped acting has to give
 * its place up without anybody walking its whole map to work out that it has.
 */
type BotHistory = {
  calls: Map<string, Occurrences>;
  lastSeen: number;
};

export function createRepeatDetector(
  options: RepeatDetectorOptions = {},
): RepeatDetector {
  const windowMs = options.windowMs ?? DEFAULT_REPEAT_WINDOW_MS;
  const maxKeysPerBot = options.maxKeysPerBot ?? DEFAULT_REPEAT_KEYS_PER_BOT;
  const maxBots = options.maxBots ?? DEFAULT_REPEAT_BOTS;
  // Ascending, so the loop below ends on the highest threshold a call crossed rather than on
  // whichever one the caller happened to list last.
  const thresholds = [
    ...(options.thresholds ?? DEFAULT_REPEAT_THRESHOLDS),
  ].sort((a, b) => a - b);
  const clock = options.now ?? Date.now;

  /**
   * Per Bot, then per call.
   *
   * Nested rather than keyed on a combined string so that one Bot's varied work cannot push another
   * Bot's history out: the cap is per Bot, and a shared map would make it a race between them.
   *
   * Both levels are capped, and neither ever drops something that is still inside the window. What
   * is in here is therefore the recent past and nothing else, which is the only claim about memory
   * this module can honestly make: an id it has never usefully counted cannot be made to sit here
   * for the life of the process.
   */
  const perBot = new Map<string, BotHistory>();

  return {
    async observe(botId, call) {
      const fingerprint = fingerprintOf(call);
      if (!fingerprint) {
        return { count: 1, fingerprint: null, threshold: null };
      }

      const now = clock();
      const cutoff = now - windowMs;

      let history = perBot.get(botId);
      if (!history) {
        if (perBot.size >= maxBots) forgetQuietBots(perBot, cutoff);
        if (perBot.size >= maxBots) return untracked(fingerprint);
        history = { calls: new Map<string, Occurrences>(), lastSeen: now };
        perBot.set(botId, history);
      }
      // Whether or not the call itself is counted. A Bot making calls is a Bot at work, and one that
      // has filled its keys with a long loop must not lose the loop by looking idle.
      history.lastSeen = now;
      const calls = history.calls;

      let entry = calls.get(fingerprint);
      if (!entry) {
        if (calls.size >= maxKeysPerBot) forgetExpiredCalls(calls, cutoff);
        if (calls.size >= maxKeysPerBot) return untracked(fingerprint);
        entry = { at: [], reported: new Set<number>() };
        calls.set(fingerprint, entry);
      }

      trimToWindow(entry.at, cutoff);
      if (entry.at.length === 0) {
        // Nothing survived the window, so whatever run of repetition this key was in has ended and
        // its thresholds are free to report again. Without this a Bot that got stuck, recovered and
        // got stuck again an hour later would leave one row for two incidents.
        entry.reported.clear();
      }
      entry.at.push(now);

      const count = entry.at.length;
      let threshold: number | null = null;
      for (const candidate of thresholds) {
        if (count >= candidate && !entry.reported.has(candidate)) {
          entry.reported.add(candidate);
          threshold = candidate;
        }
      }

      return { count, fingerprint, threshold };
    },
  };
}

/**
 * What makes two calls the same call.
 *
 * The tool name is not enough, and a detector keyed on it alone would be worse than none: five
 * clicks may be five different buttons, so a Bot working steadily down a form would look exactly
 * like one stuck on its first field, and the first person to see a rule fire on that would turn the
 * feature off. So the key is the tool plus the argument saying WHICH thing it acted on — the ref,
 * the key pressed, the file path, the address being opened — and a call carrying none of those is
 * not counted at all.
 *
 * Deliberately absent: the text being typed. A Bot that fills the same field thirty times is worth
 * catching, but what it filled it with is a password as often as it is anything else, and from here
 * the fingerprint travels into an audit row. The cost is that thirty different values into one field
 * read as thirty repeats, which is the direction to be wrong in.
 *
 * A ref only means anything against the snapshot it came from. A page that re-renders and hands back
 * a different ref for the same button reads as a different call, so a Bot looping around a reload is
 * undercounted. Keying on the element's label instead would follow the button across snapshots and
 * merge two buttons that share a label, and a count that is sometimes low is easier to live with
 * than one that is sometimes about the wrong thing.
 *
 * Readable, because it goes on the audit row as-is. An investigator reading "the same action 25
 * times" needs to be told which action without going and decoding a hash.
 */
export function fingerprintOf(call: RepeatedCall): string | null {
  const parts: string[] = [];
  const add = (label: string, value: string | undefined) => {
    const normalized = normalize(value);
    if (normalized) parts.push(`${label}=${normalized}`);
  };

  add("ref", call.ref);
  add("key", call.key);
  add("file", call.filePath);
  add("url", call.targetUrl);

  if (parts.length === 0) return null;
  return [normalize(call.tool) || call.tool, ...parts].join(" ");
}

/**
 * Whitespace collapsed and trimmed.
 *
 * A model reproducing an argument from its own earlier output does not always reproduce the spacing,
 * and a Bot writing to `reports/q3.md` and to `reports/q3.md ` is doing one thing twice. Treating
 * those as two calls would let a stuck Bot slip the count without changing anything about what it
 * was actually doing.
 */
function normalize(value: string | undefined): string {
  return (value ?? "").replaceAll(/\s+/g, " ").trim();
}

/**
 * What a call is worth when there was no room to remember it.
 *
 * The fingerprint is still returned, because it is a fact about the call and costs nothing to say.
 * The count is one and the threshold is null, so nothing downstream acts on a number this module
 * could not stand behind.
 */
function untracked(fingerprint: string): RepeatObservation {
  return { count: 1, fingerprint, threshold: null };
}

/**
 * Timestamps outside the window, dropped in place.
 *
 * Oldest first, so the scan stops at the first survivor and costs what it actually removes rather
 * than the length of the list. Rebuilding the list instead would make a Bot hammering one call pay
 * for its own history on every attempt, which is the Bot this module exists to describe.
 */
function trimToWindow(at: number[], cutoff: number) {
  const surviving = at.findIndex((time) => time > cutoff);
  if (surviving === -1) {
    at.length = 0;
    return;
  }
  if (surviving > 0) at.splice(0, surviving);
}

/**
 * Keys whose last call has aged out, which are the only ones safe to forget.
 *
 * They carry no count any more: the next call on one of them would start from one whether it was
 * held or not, so dropping it loses nothing and frees the place for a call that might.
 */
function forgetExpiredCalls(calls: Map<string, Occurrences>, cutoff: number) {
  for (const [key, entry] of calls) {
    if ((entry.at.at(-1) ?? 0) <= cutoff) calls.delete(key);
  }
}

/** The same rule one level up: a Bot that has not acted for a whole window has nothing left to say. */
function forgetQuietBots(perBot: Map<string, BotHistory>, cutoff: number) {
  for (const [botId, history] of perBot) {
    if (history.lastSeen <= cutoff) perBot.delete(botId);
  }
}

/**
 * The same detector, counting where every process can see the count.
 *
 * The nested Map is right on one machine and wrong on two. Four servers behind a load balancer each
 * see a quarter of a Bot's clicks, so a rule written as `repeat.count >= 25` never fires and the
 * audit trail records a Bot that behaved itself. The rule did not decide anything and nothing said
 * so — a boundary that goes quiet is worse than one that was never offered.
 *
 * Counting is an insert and a count, not a read-modify-write, so two processes observing at the same
 * moment cannot lose one of the calls. Reporting a threshold is an insert against a primary key, so
 * exactly one process wins the race and one row is filed per incident — an improvement on the Map,
 * which reported once per process and filed four rows for one stuck Bot.
 *
 * The caps the Map carried are gone. They bounded memory; rows that delete themselves at the edge of
 * the window bound nothing that needs bounding, and dropping them removes the one behaviour that made
 * the detector stop counting a busy Bot exactly when it was most worth counting.
 */
export function createDatabaseRepeatDetector(
  database: Database,
  options: RepeatDetectorOptions = {},
): RepeatDetector {
  const windowMs = options.windowMs ?? DEFAULT_REPEAT_WINDOW_MS;
  const thresholds = [
    ...(options.thresholds ?? DEFAULT_REPEAT_THRESHOLDS),
  ].sort((a, b) => a - b);
  const clock = options.now ?? Date.now;

  return {
    async observe(botId, call) {
      const fingerprint = fingerprintOf(call);
      if (!fingerprint) {
        return { count: 1, fingerprint: null, threshold: null };
      }

      const now = clock();
      const cutoff = new Date(now - windowMs);

      // Swept on write rather than on a timer, as the Map was: nothing here matters until somebody
      // counts, and the thing that counts sweeps first.
      await database
        .delete(computerRepeatCalls)
        .where(lte(computerRepeatCalls.at, cutoff));
      // A run of repetition ends when its window empties, and its thresholds are then free to report
      // again. The Map did this by clearing a Set; here the markers go when the calls they belong to
      // are gone, so a Bot that got stuck, recovered and got stuck again files two incidents.
      await database.delete(computerRepeatReports).where(
        notExists(
          database
            .select({ one: sql`1` })
            .from(computerRepeatCalls)
            .where(
              and(
                eq(computerRepeatCalls.botId, computerRepeatReports.botId),
                eq(
                  computerRepeatCalls.fingerprint,
                  computerRepeatReports.fingerprint,
                ),
              ),
            ),
        ),
      );

      await database.insert(computerRepeatCalls).values({
        id: randomUUID(),
        botId,
        fingerprint,
        at: new Date(now),
      });

      const [counted] = await database
        .select({ count: sqlCount() })
        .from(computerRepeatCalls)
        .where(
          and(
            eq(computerRepeatCalls.botId, botId),
            eq(computerRepeatCalls.fingerprint, fingerprint),
          ),
        );
      const count = Number(counted?.count ?? 1);

      // Ascending, so a call that crossed two at once reports the higher, as the Map did.
      let threshold: number | null = null;
      for (const candidate of thresholds) {
        if (count < candidate) continue;
        const [claimed] = await database
          .insert(computerRepeatReports)
          .values({ botId, fingerprint, threshold: candidate })
          .onConflictDoNothing()
          .returning();
        if (claimed) threshold = candidate;
      }

      return { count, fingerprint, threshold };
    },
  };
}
