/**
 * Whether this person has been through onboarding, and the record that they have.
 *
 * Onboarding is the one place the product asks anybody to set something up — it ends with their
 * first Bot existing — so "have they done it" has to survive a reload and a new machine, which
 * rules out the browser. It is a column on the person, read once per session and written once ever.
 *
 * A store rather than a query in the route, because `app.ts` takes services and never a connection.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";

export type OnboardingStore = {
  /** False until they finish. Unknown people are treated as not yet onboarded. */
  isOnboarded: (userId: string) => Promise<boolean>;
  /**
   * Record that they finished. Idempotent, and it never moves an existing stamp: going through the
   * flow again — which nothing offers, but a hand-written request could — must not rewrite the day
   * somebody actually joined.
   */
  markOnboarded: (userId: string) => Promise<void>;
};

export function createOnboardingStore(database: Database): OnboardingStore {
  return {
    isOnboarded: async (userId) => {
      const [row] = await database
        .select({ onboardedAt: users.onboardedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row?.onboardedAt != null;
    },
    markOnboarded: async (userId) => {
      await database
        .update(users)
        .set({ onboardedAt: sql`now()` })
        // `and(...)`, not `&&`: JavaScript's operator returns the SECOND condition and silently
        // discards the first, which would have stamped every person in the deployment at once.
        .where(and(eq(users.id, userId), isNull(users.onboardedAt)));
    },
  };
}
