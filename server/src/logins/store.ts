import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { loginOriginOf } from "../../../shared/login-origin";
import { siteById } from "../../../shared/sites/catalogue";
import { cutOnGraphemes, soundText } from "../../../shared/sound-text";
import { pseudonymFor } from "../account/pseudonym";
import {
  type AuditEventInput,
  type AuditStore,
  auditRowLost,
  recordAuditEvent,
} from "../audit";
import type { Database } from "../db/client";
import { auditEvents, lafSavedLogins, users } from "../db/schema";
import { LoginSealError, openLogin, type SealedFor, sealLogin } from "./crypto";

/** A transaction of this database: what a change and the trail's row about it are written on. */
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * 로그인 보관함 (`docs/laf/redesign-2026-10.md` §6, piece 2-3): the logins a person saved for their
 * Bot's browser to sign in with.
 *
 * WHAT COMES OUT OF HERE IS NEVER A VALUE, WITH ONE EXCEPTION THAT IS NOT A DOOR. Every read a
 * person or a Bot can reach — the list, a row after it is saved or changed, the export — is what
 * the row is called and where it may go. The name and the password leave through {@link
 * LoginVault.open} alone, which no route calls: it is for the server putting them into a page
 * (piece 2-4), and it is handed the owner as well as the id so a row cannot be opened for somebody
 * it is not.
 *
 * EVERY ROW IS ASKED FOR WITH ITS OWNER. There is no read or write here by id alone.
 *
 * A CHANGE OF VALUE IS A NEW KEY. The row's key is made when its values are sealed and never used
 * for a second pair: replacing a password seals both values again under a fresh key, so nothing
 * sealed for the old password opens anything of the new.
 */

/** How many logins one person may save. A bound, so the list a Bot is shown is one a prompt can hold. */
export const SAVED_LOGINS_MAX = 100;
/** How many origins one login may be for: a site, and where its sign-in box lives. */
export const LOGIN_ORIGINS_MAX = 8;
const LABEL_MAX = 80;
const USERNAME_MAX = 320;
const PASSWORD_MAX = 1024;

/** Why a login was not saved, as a fact a surface has words for. */
export type LoginRefusal =
  // What was sent is not something a login can be read from: bytes that are not JSON, a list.
  | "laf:login_invalid"
  | "laf:login_label_required"
  // An address that is not an HTTPS site; no address at all; more than a login may have.
  | "laf:login_origin_refused"
  | "laf:login_origins_required"
  | "laf:login_origins_too_many"
  | "laf:login_site_unknown"
  | "laf:login_value_required"
  | "laf:login_value_too_long"
  | "laf:logins_full";

export class LoginRefused extends Error {
  constructor(
    readonly code: LoginRefusal,
    /** Which field, where it is one: what a form marks. Never the value. */
    readonly field?: "label" | "origins" | "site" | "username" | "password",
  ) {
    super(code);
    this.name = "LoginRefused";
  }
}

/** A saved login as anybody may read it: what it is called and where it may go. No value. */
export type SavedLogin = {
  id: string;
  label: string;
  site: string | null;
  origins: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

/** What a person writes to save one. */
export type LoginInput = {
  label: unknown;
  site?: unknown;
  origins: unknown;
  username: unknown;
  password: unknown;
};

type Row = typeof lafSavedLogins.$inferSelect;

const view = (row: Row): SavedLogin => ({
  id: row.id,
  label: row.label,
  site: row.site,
  origins: row.origins,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
});

export type LoginVault = ReturnType<typeof createLoginVault>;

export function createLoginVault(input: {
  database: Database;
  /** The deployment's key, base64 of 32 bytes (`KEY_ENCRYPTION_KEY`). Not in the database. */
  keyEncryptionKey: string;
  /**
   * A developer's stack, where the page under test is on a loopback address without a
   * certificate. Never set by a deployment (`shared/login-origin.ts`).
   */
  allowLoopbackHttp?: boolean;
  now?: () => Date;
  /**
   * Where a row of the trail is written, given the transaction it is written in. For a test that
   * reads the rows or needs the trail to fail; a deployment leaves it out and every row goes on
   * the transaction itself — there is no other way this vault writes to the trail.
   */
  trailWithin?: (transaction: Transaction) => AuditStore;
}) {
  const { database, keyEncryptionKey } = input;
  const now = input.now ?? (() => new Date());
  const originOptions = { allowLoopbackHttp: input.allowLoopbackHttp === true };

  /**
   * What the person calls it, as one line the database can hold. The name is the one thing here
   * that is written as it was typed: a zero byte in it is text Postgres cannot store, and the
   * save failed inside the database with no refusal and no row (Codex's fifth read of this
   * change). Control characters are read as the spaces they would be drawn as, and what is left
   * is cut where a character ends — half of one is not a name either (`shared/sound-text.ts`).
   */
  const labelOf = (written: unknown): string => {
    const label =
      typeof written === "string"
        ? soundText(
            // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
            written.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " "),
          ).trim()
        : "";
    if (!label) throw new LoginRefused("laf:login_label_required", "label");
    return cutOnGraphemes(label, LABEL_MAX);
  };

  /**
   * The origins a login is for, each normalised the one way it is ever compared. ALL OR NOTHING:
   * one that is not an HTTPS origin refuses the save rather than being dropped — a person who
   * typed `http://…` and saw their login saved would believe it is used there.
   */
  const originsOf = (written: unknown): string[] => {
    // THREE DIFFERENT THINGS, SAID AS THREE. No address at all, too many, and one that is not an
    // HTTPS site were one fact, and the trail's page said "not an HTTPS site" of all of them —
    // false of a list of nine good ones (Codex's fourth read of this change).
    if (!Array.isArray(written) || written.length === 0) {
      throw new LoginRefused("laf:login_origins_required", "origins");
    }
    /*
     * REFUSED AT THE NINTH, NOT AFTER THE LAST. A body may be a megabyte, which is tens of
     * thousands of addresses: read to the end with the bound checked afterwards, each was looked
     * for in a list that kept growing, and one request held the deployment's one API process for
     * as long as that took (Codex's third read of this change). The list never holds more than a
     * login may have, and a body that is mostly the same address over and over is not read past
     * a few times that either.
     */
    if (written.length > LOGIN_ORIGINS_MAX * 8) {
      throw new LoginRefused("laf:login_origins_too_many", "origins");
    }
    const origins: string[] = [];
    for (const one of written) {
      const origin =
        typeof one === "string" ? loginOriginOf(one, originOptions) : null;
      if (!origin)
        throw new LoginRefused("laf:login_origin_refused", "origins");
      if (origins.includes(origin)) continue;
      if (origins.length === LOGIN_ORIGINS_MAX) {
        throw new LoginRefused("laf:login_origins_too_many", "origins");
      }
      origins.push(origin);
    }
    return origins;
  };

  const siteOf = (written: unknown): string | null => {
    if (written === undefined || written === null || written === "") {
      return null;
    }
    if (typeof written !== "string" || !siteById(written)) {
      throw new LoginRefused("laf:login_site_unknown", "site");
    }
    return written;
  };

  /** A value as it was typed: not trimmed, not tidied — a password may begin with a space. */
  const typedValue = (
    written: unknown,
    field: "username" | "password",
    max: number,
  ): string => {
    if (typeof written !== "string" || written === "") {
      throw new LoginRefused("laf:login_value_required", field);
    }
    if (written.length > max) {
      throw new LoginRefused("laf:login_value_too_long", field);
    }
    return written;
  };

  /**
   * What a row of the trail says of a login: which one — the row's target, by the login's own id
   * — and for where. Never a value, AND NOT WHAT THE PERSON CALLED IT. The trail is append-only
   * and outlives the account: when a person leaves, their rows are re-pointed at a pseudonym and
   * nothing else in them can be rewritten (migration 0028). A label is words they typed — "엄마
   * 계좌", their own name — and the person's id in a row's target would be the one thing still
   * pointing at them. So the target is the login, and the payload is the site and the origins.
   */
  const onTrail = (login: SavedLogin) => ({
    ...(login.site ? { site: login.site } : {}),
    origins: login.origins,
  });

  const mine = (userId: string, id: string) =>
    and(eq(lafSavedLogins.userId, userId), eq(lafSavedLogins.id, id));

  /**
   * THE ROW ABOUT A CHANGE IS WRITTEN WITH THE CHANGE, OR NEITHER IS. On the transaction, and not
   * through the pooled audit store: a row written on the pool lands outside the transaction, so
   * a save could be in the vault with no row saying so — or, the other way, a request could be
   * answered with a failure after what it asked for had been done, and done again when it was
   * sent again (Codex's read of this change). The way a person's leaving is written
   * (`account/deletion.ts`).
   */
  const trailWithin = (transaction: Transaction): AuditStore => ({
    insert: async (event) => {
      await (
        input.trailWithin?.(transaction) ?? {
          insert: (written: AuditEventInput) =>
            transaction.insert(auditEvents).values(written),
        }
      ).insert(event);
    },
  });

  /**
   * A SAVE OR A CHANGE THAT WAS NOT MADE LEAVES A ROW TOO: that it was refused, as which fact,
   * and about which field — and nothing of what was written. A login somebody tried to save for
   * an origin that is not HTTPS is something the trail should be able to say happened; so is a
   * row whose seal no longer opens. This row has nothing to be written together with, so its
   * loss is logged rather than made the refusal's.
   */
  const orRefused = async <T>(
    userId: string,
    /**
     * The login a change was sent for: its id for the row's target, and where it may go — as it
     * STANDS, never as the change would have had it — so a reader of the trail can tell which
     * login a refusal was about. Absent for a save, which made no login to name.
     */
    about: SavedLogin | undefined,
    act: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await act();
    } catch (error) {
      const refusal =
        error instanceof LoginRefused
          ? { code: error.code, ...(error.field ? { field: error.field } : {}) }
          : error instanceof LoginSealError
            ? { code: error.code }
            : null;
      if (refusal) {
        /*
         * UNDER THE PERSON WHILE THERE IS ONE, AND UNDER THEIR PSEUDONYM ONCE THERE IS NOT. This
         * row has no key to the person, so it can be written after they have left: a request
         * that was already past the session check when their account's deletion committed
         * would put their id back into a trail that had just been re-pointed away from it
         * (Codex's fourth read of this change). The person's row is looked for, and held, in
         * the transaction that writes this one; where it is gone the row is written under the
         * same string everything else of theirs now carries (`account/pseudonym.ts`).
         *
         * Not closed by this: a row written while a deletion is under way but has not yet
         * removed the person. That is every row any request writes under its actor, and is the
         * deletion's to close by taking the person's row first — not one writer's.
         */
        await database
          .transaction(async (transaction) => {
            const [here] = await transaction
              .select({ id: users.id })
              .from(users)
              .where(eq(users.id, userId))
              .for("key share");
            await recordAuditEvent(trailWithin(transaction), {
              eventType: "account.login_refused",
              targetType: "saved_login",
              // A save that was refused made no login to name.
              targetId: about?.id ?? "unsaved",
              actorUserId: here ? userId : pseudonymFor(userId),
              payload: { ...(about ? onTrail(about) : {}), ...refusal },
            });
          })
          .catch(auditRowLost("account.login_refused"));
      }
      throw error;
    }
  };

  return {
    /** Every login a person saved, oldest first. What each is called and where it may go. */
    async list(userId: string): Promise<SavedLogin[]> {
      const rows = await database
        .select()
        .from(lafSavedLogins)
        .where(eq(lafSavedLogins.userId, userId))
        .orderBy(asc(lafSavedLogins.createdAt), asc(lafSavedLogins.id));
      return rows.map(view);
    },

    /**
     * Save one. The values are sealed before anything is written, and are in no row of the trail.
     * The row and the trail's row about it are written together or not at all.
     */
    async save(
      userId: string,
      /** `null` where what was sent could not be read as a login at all. */
      written: LoginInput | null,
    ): Promise<SavedLogin> {
      return orRefused(userId, undefined, async () => {
        if (!written) throw new LoginRefused("laf:login_invalid");
        const label = labelOf(written.label);
        const site = siteOf(written.site);
        const origins = originsOf(written.origins);
        const username = typedValue(written.username, "username", USERNAME_MAX);
        const password = typedValue(written.password, "password", PASSWORD_MAX);

        const belongs: SealedFor = { id: `login_${randomUUID()}`, userId };
        const sealed = await sealLogin(keyEncryptionKey, belongs, {
          username,
          password,
        });
        const at = now();
        return database.transaction(async (transaction) => {
          const [held] = await transaction
            .select({ saved: count() })
            .from(lafSavedLogins)
            .where(eq(lafSavedLogins.userId, userId));
          if ((held?.saved ?? 0) >= SAVED_LOGINS_MAX) {
            throw new LoginRefused("laf:logins_full");
          }
          const [row] = await transaction
            .insert(lafSavedLogins)
            .values({
              id: belongs.id,
              userId,
              label,
              site,
              origins,
              ...sealed,
              createdAt: at,
              updatedAt: at,
            })
            .returning();
          if (!row) throw new Error("the saved login was not written");
          const saved = view(row);
          await recordAuditEvent(trailWithin(transaction), {
            eventType: "account.login_saved",
            targetType: "saved_login",
            targetId: saved.id,
            actorUserId: userId,
            payload: onTrail(saved),
          });
          return saved;
        });
      });
    },

    /**
     * Change one: what it is called, where it may go, or its values. Anything left out stays as
     * it is — except that the two values travel together: a new password without the name is
     * sealed with the name the row already holds, under a NEW key.
     *
     * `null` where the row is not this person's, which is also what a row that does not exist is.
     * Throws `LoginSealError` where one value was sent and the other, which the row holds, does
     * not open.
     */
    async replace(
      userId: string,
      id: string,
      /** `null` where what was sent could not be read as a change at all. */
      written: Partial<LoginInput> | null,
    ): Promise<SavedLogin | null> {
      const [row] = await database
        .select()
        .from(lafSavedLogins)
        .where(mine(userId, id));
      /*
       * WHAT COULD NOT BE READ IS REFUSED BEFORE ANYTHING IS LOOKED FOR. Sent for a login that is
       * not this person's — or is nobody's — it was answered "not found" first: a 404, and no
       * row, for the same bytes that are a refusal with a row when the login is theirs (Codex's
       * fifth read of this change). The row says which login only where there is one of theirs.
       */
      if (!written) {
        return orRefused(userId, row ? view(row) : undefined, async () => {
          throw new LoginRefused("laf:login_invalid");
        });
      }
      if (!row) return null;
      // Nothing was sent: nothing is written, and the trail is not told of a change that was not.
      const sent = written
        ? [
            written.label,
            written.site,
            written.origins,
            written.username,
            written.password,
          ]
        : [null];
      if (sent.every((one) => one === undefined)) return view(row);

      return orRefused(userId, view(row), async () => {
        /*
         * A BODY THAT COULD NOT BE READ IS A REFUSAL LIKE ANY, WITH ITS ROW. Answered at the door
         * it wrote none — and "a change somebody sent that this could not read" is exactly the
         * attempt a trail is asked about afterwards (Codex's second read of this change).
         */
        if (!written) throw new LoginRefused("laf:login_invalid");
        const label =
          written.label === undefined ? row.label : labelOf(written.label);
        const site =
          written.site === undefined ? row.site : siteOf(written.site);
        const origins =
          written.origins === undefined
            ? row.origins
            : originsOf(written.origins);
        const newUsername =
          written.username === undefined
            ? undefined
            : typedValue(written.username, "username", USERNAME_MAX);
        const newPassword =
          written.password === undefined
            ? undefined
            : typedValue(written.password, "password", PASSWORD_MAX);

        const belongs: SealedFor = { id: row.id, userId };
        /*
         * The value that was not sent is the one the row holds, so the row is opened for it — and
         * ONLY for it. With both sent there is nothing to keep, and the old seal is not opened at
         * all: that is how a row this deployment can no longer open (its key was changed) is put
         * right by the person typing both again, rather than being a row nothing can fix.
         */
        const resealed =
          newUsername === undefined && newPassword === undefined
            ? {}
            : await (async () => {
                const held =
                  newUsername !== undefined && newPassword !== undefined
                    ? undefined
                    : await openLogin(keyEncryptionKey, belongs, row);
                return sealLogin(keyEncryptionKey, belongs, {
                  username: newUsername ?? held?.username ?? "",
                  password: newPassword ?? held?.password ?? "",
                });
              })();
        return database.transaction(async (transaction) => {
          const [changed] = await transaction
            .update(lafSavedLogins)
            .set({ label, site, origins, ...resealed, updatedAt: now() })
            .where(mine(userId, id))
            .returning();
          // Deleted between the read and the write: nothing to change, and nothing to tell.
          if (!changed) return null;
          const saved = view(changed);
          await recordAuditEvent(trailWithin(transaction), {
            eventType: "account.login_replaced",
            targetType: "saved_login",
            targetId: saved.id,
            actorUserId: userId,
            payload: {
              ...onTrail(saved),
              // Whether the values changed, which is what somebody reading the trail asks. Not which.
              values: "sealedPassword" in resealed ? "replaced" : "kept",
            },
          });
          return saved;
        });
      });
    },

    /** Delete one, now. Says whether there was one of this person's to delete. */
    async remove(userId: string, id: string): Promise<boolean> {
      return database.transaction(async (transaction) => {
        const [gone] = await transaction
          .delete(lafSavedLogins)
          .where(mine(userId, id))
          .returning();
        if (!gone) return false;
        await recordAuditEvent(trailWithin(transaction), {
          eventType: "account.login_removed",
          targetType: "saved_login",
          targetId: gone.id,
          actorUserId: userId,
          payload: onTrail(view(gone)),
        });
        return true;
      });
    },

    /**
     * THE ONE WAY A VALUE LEAVES, and no route is it: for the server putting a saved login into a
     * page (piece 2-4), which decides — at the gateway, with a row of its own — whether it may.
     * `null` where the row is not this person's. Throws `LoginSealError` where it does not open:
     * the deployment's key changed under it, or the row is not what was written.
     */
    async open(
      userId: string,
      id: string,
    ): Promise<{
      login: SavedLogin;
      username: string;
      password: string;
    } | null> {
      const [row] = await database
        .select()
        .from(lafSavedLogins)
        .where(mine(userId, id));
      if (!row) return null;
      const values = await openLogin(
        keyEncryptionKey,
        { id: row.id, userId },
        row,
      );
      return { login: view(row), ...values };
    },
  };
}
