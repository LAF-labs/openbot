import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { loginOriginOf } from "../../../shared/login-origin";
import { siteById } from "../../../shared/sites/catalogue";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { lafSavedLogins } from "../db/schema";
import { openLogin, type SealedFor, sealLogin } from "./crypto";

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
  | "laf:login_label_required"
  | "laf:login_origin_refused"
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
  auditStore: AuditStore;
  /** The deployment's key, base64 of 32 bytes (`KEY_ENCRYPTION_KEY`). Not in the database. */
  keyEncryptionKey: string;
  /**
   * A developer's stack, where the page under test is on a loopback address without a
   * certificate. Never set by a deployment (`shared/login-origin.ts`).
   */
  allowLoopbackHttp?: boolean;
  now?: () => Date;
}) {
  const { database, auditStore, keyEncryptionKey } = input;
  const now = input.now ?? (() => new Date());
  const originOptions = { allowLoopbackHttp: input.allowLoopbackHttp === true };

  const labelOf = (written: unknown): string => {
    const label =
      typeof written === "string" ? written.replace(/\s+/g, " ").trim() : "";
    if (!label) throw new LoginRefused("laf:login_label_required", "label");
    return label.slice(0, LABEL_MAX);
  };

  /**
   * The origins a login is for, each normalised the one way it is ever compared. ALL OR NOTHING:
   * one that is not an HTTPS origin refuses the save rather than being dropped — a person who
   * typed `http://…` and saw their login saved would believe it is used there.
   */
  const originsOf = (written: unknown): string[] => {
    if (!Array.isArray(written) || written.length === 0) {
      throw new LoginRefused("laf:login_origin_refused", "origins");
    }
    const origins: string[] = [];
    for (const one of written) {
      const origin =
        typeof one === "string" ? loginOriginOf(one, originOptions) : null;
      if (!origin)
        throw new LoginRefused("laf:login_origin_refused", "origins");
      if (!origins.includes(origin)) origins.push(origin);
    }
    if (origins.length > LOGIN_ORIGINS_MAX) {
      throw new LoginRefused("laf:login_origin_refused", "origins");
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

    /** Save one. The values are sealed before anything is written, and are in no row of the trail. */
    async save(userId: string, written: LoginInput): Promise<SavedLogin> {
      const label = labelOf(written.label);
      const site = siteOf(written.site);
      const origins = originsOf(written.origins);
      const username = typedValue(written.username, "username", USERNAME_MAX);
      const password = typedValue(written.password, "password", PASSWORD_MAX);

      const [held] = await database
        .select({ saved: count() })
        .from(lafSavedLogins)
        .where(eq(lafSavedLogins.userId, userId));
      if ((held?.saved ?? 0) >= SAVED_LOGINS_MAX) {
        throw new LoginRefused("laf:logins_full");
      }

      const belongs: SealedFor = { id: `login_${randomUUID()}`, userId };
      const sealed = await sealLogin(keyEncryptionKey, belongs, {
        username,
        password,
      });
      const at = now();
      const [row] = await database
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
      await recordAuditEvent(auditStore, {
        eventType: "account.login_saved",
        targetType: "saved_login",
        targetId: saved.id,
        actorUserId: userId,
        payload: onTrail(saved),
      });
      return saved;
    },

    /**
     * Change one: what it is called, where it may go, or its values. Anything left out stays as
     * it is — except that the two values travel together: a new password without the name is
     * sealed with the name the row already holds, under a NEW key.
     *
     * `null` where the row is not this person's, which is also what a row that does not exist is.
     */
    async replace(
      userId: string,
      id: string,
      written: Partial<LoginInput>,
    ): Promise<SavedLogin | null> {
      const [row] = await database
        .select()
        .from(lafSavedLogins)
        .where(mine(userId, id));
      if (!row) return null;
      // Nothing was sent: nothing is written, and the trail is not told of a change that was not.
      const sent = [
        written.label,
        written.site,
        written.origins,
        written.username,
        written.password,
      ];
      if (sent.every((one) => one === undefined)) return view(row);

      const label =
        written.label === undefined ? row.label : labelOf(written.label);
      const site = written.site === undefined ? row.site : siteOf(written.site);
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
      const resealed =
        newUsername === undefined && newPassword === undefined
          ? {}
          : await (async () => {
              const held = await openLogin(keyEncryptionKey, belongs, row);
              return sealLogin(keyEncryptionKey, belongs, {
                username: newUsername ?? held.username,
                password: newPassword ?? held.password,
              });
            })();
      const [changed] = await database
        .update(lafSavedLogins)
        .set({ label, site, origins, ...resealed, updatedAt: now() })
        .where(mine(userId, id))
        .returning();
      if (!changed) return null;
      const saved = view(changed);
      await recordAuditEvent(auditStore, {
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
    },

    /** Delete one, now. Says whether there was one of this person's to delete. */
    async remove(userId: string, id: string): Promise<boolean> {
      const [gone] = await database
        .delete(lafSavedLogins)
        .where(mine(userId, id))
        .returning();
      if (!gone) return false;
      await recordAuditEvent(auditStore, {
        eventType: "account.login_removed",
        targetType: "saved_login",
        targetId: gone.id,
        actorUserId: userId,
        payload: onTrail(view(gone)),
      });
      return true;
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
