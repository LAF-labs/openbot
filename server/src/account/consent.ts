/**
 * Which terms and privacy policy a person agreed to, and when.
 *
 * ONE STRING, ON BOTH SIDES OF THE WIRE. The text lives in `app/src/legal/*.md` and this deployment
 * stamps `users.consent_version` with the value here; `server/tests/legal-version.test.ts` reads
 * those files and fails the moment they carry a different version than this one. Without that the
 * two drift the first time somebody edits the text: the page shows a new date and every new account
 * is recorded as having agreed to the old one.
 *
 * A date rather than a number, because "which text" is a question about a day — the day the
 * text on the page changed — and a counter has to be looked up to mean anything.
 *
 * THE STAMP IS ITS OWN CALL, not a side effect of onboarding. It was written into `markOnboarded`
 * first, and that put the consent at the END of the first run — after the Bot existed — while the
 * sentence saying "continuing means you agree" is on the first screen, before either button. A
 * consent recorded by a different act than the one the sentence names is a consent nobody gave. So
 * `POST /api/me/consent` is what the first screen's 다음 calls, and what the re-ask screen calls
 * when the version has moved.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { users } from "../db/schema";

export const LEGAL_VERSION = "2026-09-06";

/** What one person has agreed to: nothing yet, or one version at one moment. */
export type Consent = {
  version: string | null;
  at: Date | null;
};

export type ConsentStore = {
  /** Unknown people have agreed to nothing. Never throws on a missing row. */
  read: (userId: string) => Promise<Consent>;
  /**
   * Record that this person agreed to {@link LEGAL_VERSION}, now.
   *
   * Idempotent for the same version — pressing 다음 twice, or reloading the welcome screen, must not
   * move the moment somebody actually agreed. It DOES move when the version differs: that is a new
   * agreement to a new text, and the old stamp is the thing being replaced. Nothing else ever
   * writes these columns; a record with no sentence in front of it is what this exists to prevent.
   */
  record: (userId: string) => Promise<void>;
};

export function createConsentStore(database: Database): ConsentStore {
  return {
    read: async (userId) => {
      const [row] = await database
        .select({ version: users.consentVersion, at: users.consentedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return { version: row?.version ?? null, at: row?.at ?? null };
    },
    record: async (userId) => {
      await database
        .update(users)
        .set({ consentedAt: sql`now()`, consentVersion: LEGAL_VERSION })
        // `and(...)`, never `&&`, for the same reason `onboarding.ts` says so: the JavaScript
        // operator would keep only the second condition and stamp everybody on the deployment.
        // `IS DISTINCT FROM`, because a null version is "never agreed", which is distinct too.
        .where(
          and(
            eq(users.id, userId),
            sql`${users.consentVersion} is distinct from ${LEGAL_VERSION}`,
          ),
        );
    },
  };
}
