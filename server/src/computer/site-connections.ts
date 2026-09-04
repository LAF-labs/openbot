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
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { lafSiteConnections } from "../db/schema";

export type SiteConnection = {
  siteId: string;
  /** Whose browser the session was last seen in. A browser profile is per Bot. */
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
   */
  record(input: {
    userId: string;
    siteId: string;
    botId: string;
    signedIn: boolean;
  }): Promise<SiteConnection | null>;
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
): SiteConnectionStore {
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
        const [updated] = await database
          .update(lafSiteConnections)
          .set({ needsLogin: true })
          .where(
            and(
              eq(lafSiteConnections.userId, userId),
              eq(lafSiteConnections.siteId, siteId),
            ),
          )
          .returning();
        return updated ? asConnection(updated) : null;
      }

      const [saved] = await database
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
      return saved ? asConnection(saved) : null;
    },
  };
}
