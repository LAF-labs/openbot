/**
 * Which business sites a person has signed into on a Bot's browser.
 *
 * WHAT THIS IS FOR. The 사이트 연결 cards would otherwise have to guess, and the honest guess is
 * "we have no idea": a session lives as a cookie in the Chromium profile and nothing in the product
 * can see it without opening the page. So the two moments that DO know write it down — the person
 * handing the wheel back after logging in, and every later navigation that lands on that host — and
 * the card reads these rows instead of pretending.
 *
 * NOTHING SECRET PASSES THROUGH HERE. There is no field a password could land in, and that is the
 * design rather than an accident: the site id, the Bot, two timestamps and a flag. See
 * `server/tests/site-connections.test.ts`, which serialises the whole store and the audit rows a
 * connect produces and asserts the typed value is in neither.
 *
 * NOTHING HERE MAY THROW INTO ITS CALLER, for the same reason `notifications/outbox.ts` says so:
 * the busiest caller is the success path of a navigation somebody's routine is in the middle of,
 * and a bookkeeping write that fails must cost a card its freshness, never the work.
 *
 * THE MOMENTS THE FLAG CHANGES ARE WRITTEN DOWN AS WELL (2026-09-14). The row is the present and
 * nothing else, so "how long does a 배민 login last" could only be answered with a lower bound
 * (laf-control `core/insights.ts` §4-3). `site.signed_in` is written when a look finds a site
 * signed in that was not — never connected, or behind the wall — and `site.login_lapsed` when the
 * browser the session lives in first meets the wall, with when that session began and when it was
 * last seen alive. A look that changes nothing writes nothing: the thousandth morning a routine finds
 * 배민 still signed in is not news, and a trail of them would bury the two that are.
 */
import { and, desc, eq } from "drizzle-orm";
import { type AuditStore, createAuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { auditEvents, lafSiteConnections } from "../db/schema";
import { log } from "../log";

export type SiteConnection = {
  siteId: string;
  /**
   * Which Bot last saw the site signed in — NOT whose login it is.
   *
   * There is one browser profile on a deployment and every Bot is signed in through it
   * (`agent-computer/src/profiles.ts`, 2026-09-16), so a session belongs to the account. This is the
   * Bot that last looked, which is worth keeping because it is what the audit rows are keyed on and
   * what answers "who was using 배민 when it lapsed". The surface must not turn it into "이 봇이
   * 로그인한 사이트": the card says the account's Bots share it.
   */
  botId: string;
  connectedAt: string;
  lastSeenAt: string;
  /** The last look found the login wall. The card says 다시 로그인 필요. */
  needsLogin: boolean;
};

export type SiteConnectionStore = {
  list(userId: string): Promise<SiteConnection[]>;
  /**
   * Write down what a look at one of these sites found.
   *
   * `signedIn: true` connects it, or refreshes a connection that already existed — `connected_at`
   * is never rewritten, because "since when" is the fact the card shows and re-stamping it every
   * morning would turn it into "today", forever.
   *
   * `signedIn: false` marks an EXISTING row as needing a login and creates nothing. A login wall on
   * a site nobody ever connected is not news; a login wall on one they did is the whole reason this
   * flag exists, and it is what explains a routine that came back empty.
   *
   * ANY BOT MAY REPORT THE WALL, BECAUSE THE SESSION IS THE ACCOUNT'S (2026-09-16). This used to be
   * scoped to the Bot that signed in, and it had to be: profiles were per Bot, so a second Bot
   * visiting the site on its never-signed-in profile saw the wall every time and said nothing about
   * the session in the first Bot's browser. Measured 2026-09-10 (audit A9, F4): Bot A signs in, Bot
   * B's routine runs, the card says 다시 로그인 필요; A visits, it says connected; B runs again —
   * several flips a day, and a person re-logging into a session that never expired.
   *
   * One profile ends both halves of that. There is no never-signed-in profile for B to look at any
   * more — B meets the wall only when the account's session really has run out — and keeping the
   * scope would now be the opposite bug: the card would go on claiming a live 배민 login because the
   * Bot that first signed in has not looked since Tuesday. So the lapse is matched on the person and
   * the site, and the Bot that saw it is recorded rather than required.
   */
  record(input: {
    userId: string;
    siteId: string;
    botId: string;
    signedIn: boolean;
  }): Promise<SiteConnection | null>;
  /**
   * Drop the row, because the person turned this site off.
   *
   * WHAT IT DOES NOT DO, AND WHY THE SURFACE HAS TO SAY SO. The session is a cookie in the Bot's
   * Chromium profile and nothing here can reach into it: forgetting the row stops the card claiming
   * a connection and stops a routine being told there is one, and the browser stays signed in until
   * somebody logs out on the site itself. A row silently removed under the word "연결 끊기" would be
   * the screen promising something it cannot do, which is why the confirmation says both halves.
   */
  forget(input: { userId: string; siteId: string }): Promise<boolean>;
};

type Row = typeof lafSiteConnections.$inferSelect;

const asConnection = (row: Row): SiteConnection => ({
  siteId: row.siteId,
  botId: row.botId,
  connectedAt: row.connectedAt.toISOString(),
  lastSeenAt: row.lastSeenAt.toISOString(),
  needsLogin: row.needsLogin,
});

export function createSiteConnectionStore(
  database: Database,
  options: {
    /**
     * Where the two transition rows go. The deployment's own trail unless a test hands in another;
     * `main.ts` builds its boot store the same way, over the same database.
     */
    auditStore?: AuditStore;
  } = {},
): SiteConnectionStore {
  const auditStore = options.auditStore ?? createAuditStore(database);

  /**
   * One transition row, written after the change it describes has committed.
   *
   * Swallowed and logged on failure, like the repeat row in the gateway: this is an observation
   * about bookkeeping, and a trail that could not be reached must not turn a routine's successful
   * navigation, or a person's finished login, into a failure.
   */
  const note = async (
    eventType: "site.signed_in" | "site.login_lapsed",
    userId: string,
    siteId: string,
    /** Built inside the guard, so a lookup it needs cannot throw past it either. */
    fields: () => Promise<Record<string, unknown>>,
  ) => {
    try {
      await recordAuditEvent(auditStore, {
        eventType,
        targetType: "site",
        targetId: siteId,
        actorUserId: userId,
        payload: { site: siteId, ...(await fields()) },
      });
    } catch (error) {
      log.error("site_transition_row_lost", {
        row: eventType,
        site: siteId,
        reason: error,
      });
    }
  };

  /**
   * When the session that just ran out began, as well as this store can say.
   *
   * `connected_at` is the first sign-in ever and never moves, so a site that has lapsed and been
   * signed into again would report its first March login as the start of September's session. The
   * start of THIS session is the last `site.signed_in` written for the site; a session older than
   * those rows has only `connected_at` to go on, and gets it.
   *
   * WHICHEVER BOT WROTE IT (2026-09-16). The lookup was scoped to the Bot, which was right when each
   * one had a profile: the session began when THAT browser signed in. There is one browser now, so a
   * lapse Bot B reported would have found none of Bot A's sign-in rows and called the session as old
   * as `connected_at` — months, on a login three days old. The question the row answers is "how long
   * did this account's 배민 session last", and that has one answer per site.
   *
   * AND NEVER LATER THAN IT WAS LAST SEEN. The row is written a moment after the look it records,
   * stamped by the database, while the connection's clocks are the look's own — so a session seen
   * exactly once came back "signed in since" 27 ms after it was "last seen" (measured through the
   * running stack, 2026-09-14). A session cannot have begun after it was seen alive.
   */
  const sessionStart = async (
    userId: string,
    siteId: string,
    connectedAt: Date,
    lastSeenAt: Date,
  ): Promise<Date> => {
    const [latest] = await database
      .select({ at: auditEvents.createdAt })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "site.signed_in"),
          eq(auditEvents.targetType, "site"),
          eq(auditEvents.targetId, siteId),
          eq(auditEvents.actorUserId, userId),
        ),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(1);
    const began = latest && latest.at > connectedAt ? latest.at : connectedAt;
    return began > lastSeenAt ? lastSeenAt : began;
  };

  return {
    async list(userId) {
      const rows = await database
        .select()
        .from(lafSiteConnections)
        .where(eq(lafSiteConnections.userId, userId));
      return rows.map(asConnection);
    },

    async record({ userId, siteId, botId, signedIn }) {
      const now = new Date();
      if (!signedIn) {
        /*
         * Read and changed under one lock, so two looks at the same wall in the same instant write
         * one lapse between them rather than one each. Nothing else is read inside: a transaction
         * that reached for a second pooled connection is how `db/client.ts` says a pool deadlocks.
         */
        const { before, after } = await database.transaction(
          async (transaction) => {
            // The person and the site, not the Bot: one browser, one session. See `record` above.
            const own = and(
              eq(lafSiteConnections.userId, userId),
              eq(lafSiteConnections.siteId, siteId),
            );
            const [held] = await transaction
              .select()
              .from(lafSiteConnections)
              .where(own)
              .for("update");
            if (!held || held.needsLogin) return { before: held, after: held };
            const [marked] = await transaction
              .update(lafSiteConnections)
              // The Bot that met the wall becomes the one the row names, so `botId` stays "who last
              // looked" on the lapse path as well as the sign-in path rather than meaning two
              // different things depending on which way the flag moved.
              .set({ needsLogin: true, botId })
              .where(own)
              .returning();
            return { before: held, after: marked };
          },
        );
        if (before && !before.needsLogin && after) {
          await note("site.login_lapsed", userId, siteId, async () => ({
            bot: botId,
            signedInSince: (
              await sessionStart(
                userId,
                siteId,
                before.connectedAt,
                before.lastSeenAt,
              )
            ).toISOString(),
            // Not moved by the wall: the last look that found the session alive.
            lastSeenAt: before.lastSeenAt.toISOString(),
          }));
        }
        return after ? asConnection(after) : null;
      }

      const { before, saved } = await database.transaction(
        async (transaction) => {
          const [held] = await transaction
            .select({ needsLogin: lafSiteConnections.needsLogin })
            .from(lafSiteConnections)
            .where(
              and(
                eq(lafSiteConnections.userId, userId),
                eq(lafSiteConnections.siteId, siteId),
              ),
            )
            .for("update");
          const [written] = await transaction
            .insert(lafSiteConnections)
            .values({
              userId,
              siteId,
              botId,
              connectedAt: now,
              lastSeenAt: now,
              needsLogin: false,
            })
            .onConflictDoUpdate({
              target: [lafSiteConnections.userId, lafSiteConnections.siteId],
              // `connectedAt` is deliberately absent. See `record` above.
              set: { botId, lastSeenAt: now, needsLogin: false },
            })
            .returning();
          return { before: held, saved: written };
        },
      );
      // Signed in where it was not: a first connection, or a login after the wall.
      if (saved && (!before || before.needsLogin)) {
        await note("site.signed_in", userId, siteId, async () => ({
          bot: botId,
        }));
      }
      return saved ? asConnection(saved) : null;
    },

    async forget({ userId, siteId }) {
      // Scoped to the person AND the site. A delete by site alone would take everybody's row on a
      // machine that ever grows a second account, for a gesture that belongs to one of them.
      const removed = await database
        .delete(lafSiteConnections)
        .where(
          and(
            eq(lafSiteConnections.userId, userId),
            eq(lafSiteConnections.siteId, siteId),
          ),
        )
        .returning();
      return removed.length > 0;
    },
  };
}
