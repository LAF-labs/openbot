/**
 * A person this deployment no longer lets in, taken out of every session they already hold.
 *
 * MEASURED 2026-09-14 on a local stack (`dab7754`, a stub broker, two people): staff struck off
 * `SIGN_IN_ALLOWED_EMAILS` and the server restarted — which is exactly what `laf member remove`
 * does to a VM — were refused a NEW sign-in with `laf:sign_in_not_admitted`, and the cookie they
 * already held answered `GET /api/me` 200 and renewed on use. The list was checked by a hook that
 * runs when a session is CREATED (`auth/index.ts`), so a removal decided who could come back and
 * nothing about who was still inside: seven days of the owner's Bots, conversations and screens.
 * The administrator's delete route did remove the rows — and the old cookie then read as nobody
 * signed in (`laf:unauthenticated`), so the door held and the person was told nothing about why.
 *
 * THE SOURCE OF TRUTH IS THE SIGN-IN LIST THIS PROCESS BOOTED WITH. The roster lives in laf-control
 * (`customer_emails`, written by `laf member` and `laf member remove`), which renders it into this
 * VM's `SIGN_IN_ALLOWED_EMAILS` and recreates the container (laf-control `core/customer-env.ts`).
 * This process cannot read the roster and does not need to: the list in its environment IS the
 * roster as of the last push, and the push restarts it. So "still admitted" is two facts, both in
 * hand the moment better-auth has read the session — the account row exists (the session is read
 * joined to it, so a deleted account has no session left to check) and the list admits the address.
 * No lookup is added to a request that passes; see `admits`.
 *
 * REVOKED, NOT REFUSED. A session that fails is deleted — every one the person holds, on every
 * device — rather than answered 401 and left in the table, because a row left there is still a
 * session to better-auth's own endpoints under `/api/auth/*`, which this deployment's guard never
 * sees and which renew it.
 *
 * WHICH COOKIES WERE TAKEN AWAY is remembered here, in this process, by a hash of the token: once
 * the row is gone, nothing else can tell a cookie that was revoked from one that was never valid,
 * and the two want different sentences. One process per VM (docs/laf/deployment-model.md), so the
 * map is the whole record. A restart forgets it: a cookie revoked before a restart reads as signed out
 * after it — the door holds, only the sentence is lost. A removal from the sign-in list is not lost to
 * the restart that carries it, because that boot's sweep is what ends the sessions and remembers them;
 * a second restart before the person comes back forgets those as well.
 */
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { sessions, users } from "../db/schema";
import { log } from "../log";

/** Why somebody other than the person ended their sessions. The log line's word for it. */
export type RevocationReason =
  /** The deployment's sign-in list no longer admits the address (`laf member remove`, then a push). */
  | "sign_in_list"
  /** An administrator deleted the account (`POST /api/admin/users/:id/delete`). */
  | "account_removed";

/** A session row that is gone, as much of it as is needed to recognise its cookie afterwards. */
export type EndedSession = { token: string; expiresAt: Date };

/** What the session guards ask. The rest of `SessionRevocation` is for the removal paths and boot. */
export type SessionAdmission = {
  /**
   * Does this deployment still let this address in. Always yes when no list is set.
   *
   * THE WHOLE PER-REQUEST CHECK, AND IT IS A SET LOOKUP. The account's existence came with the
   * session read, the list is this process's configuration, and nothing here touches the database
   * for a person who passes. Measured 2026-09-14: 0.03 µs a call in-process; on the local stack,
   * `GET /api/me` p50 2.45 ms before and 2.53 ms after over three runs of 1,000 sequential requests
   * each, inside the 0.2 ms the runs of one build differ by.
   */
  admits(email: string): boolean;
  /** End every session this person holds, because they are no longer admitted. Rows removed. */
  revoke(userId: string, reason: RevocationReason): Promise<number>;
  /** Whether a request whose session is gone carries a cookie this deployment took away. */
  wasRevoked(headers: Headers): boolean;
};

export type SessionRevocation = SessionAdmission & {
  /**
   * Sessions a caller has already deleted inside its own transaction, reported once it committed.
   *
   * With a reason, the cookies are remembered as revoked. With `null` — a person leaving by their
   * own hand — they simply stop working: the account page they pressed says the account is gone,
   * and a sign-in door telling them their access was taken away would be a lie about who decided.
   * Either way, whatever holds the person's open sockets is told.
   */
  ended(
    userId: string,
    ended: readonly EndedSession[],
    reason: RevocationReason | null,
  ): void;
  /** Attach something holding a person's open sockets. Returns the detach. */
  onEnded(listener: (userId: string) => void): () => void;
  /**
   * At boot: end the sessions of every account the list no longer admits.
   *
   * `laf member remove` reaches this process as a restart with a shorter list, so the boot is that
   * removal's moment, and the sessions end then rather than whenever the person next knocks.
   *
   * `among` narrows it to some accounts, and only a test passes it: the test database is shared by
   * every suite, and a sweep there with a list naming one test's people would end every other
   * suite's sessions — the unscoped delete CLAUDE.md warns about. The boot never narrows.
   */
  sweep(
    among?: readonly string[],
  ): Promise<{ people: number; sessions: number }>;
};

/** The one fact the guards answer a revoked session with. The surface owns the words. */
export const SESSION_REVOKED = "laf:session_revoked";

/**
 * The names better-auth gives the session cookie under `auth/index.ts`'s configuration, which sets
 * no prefix of its own: `__Secure-` when the public URL is https, bare on a laptop. Read by name
 * rather than through better-auth, because a revoked cookie is exactly the one it no longer has a
 * session for. `session-revocation.integration.test.ts` takes its cookies from better-auth itself,
 * so a renamed cookie fails there.
 */
const SESSION_COOKIES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
] as const;

/**
 * How many revoked cookies are remembered at once. A VM has an owner and a few staff; this is the
 * bound on a process that lives for months, never a number anybody is expected to reach.
 */
const REMEMBERED_AT_MOST = 10_000;

/** The token a session cookie carries, unverified — see `wasRevoked` for why that is enough. */
function sessionTokensIn(headers: Headers): string[] {
  const header = headers.get("cookie");
  if (!header) return [];
  const tokens: string[] = [];
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (!(SESSION_COOKIES as readonly string[]).includes(name)) continue;
    let value = part.slice(at + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    // `token.signature`: the signature is base64 and has no dot, the token is alphanumeric.
    const dot = value.lastIndexOf(".");
    if (dot > 0) tokens.push(value.slice(0, dot));
  }
  return tokens;
}

/** A remembered cookie is a hash of its token: the map should not be a list of anybody's cookies. */
const fingerprint = (token: string) =>
  createHash("sha256").update(token).digest("base64url");

export function createSessionRevocation(input: {
  database: Database;
  /** The deployment's sign-in list — the same `createSignInAllowlist` the create hook refuses with. */
  allowlist: { enforced: boolean; admits(email: string): boolean };
  now?: () => number;
}): SessionRevocation {
  const { database, allowlist } = input;
  const now = input.now ?? Date.now;
  /** Fingerprint → when the session would have expired anyway. Insertion order is age. */
  const remembered = new Map<string, number>();
  const listeners = new Set<(userId: string) => void>();

  const remember = (ended: readonly EndedSession[]) => {
    for (const session of ended) {
      const expiresAt = session.expiresAt.getTime();
      // Already past its own expiry: better-auth would have said so, and "revoked" adds nothing.
      if (expiresAt <= now()) continue;
      remembered.set(fingerprint(session.token), expiresAt);
    }
    for (const key of remembered.keys()) {
      if (remembered.size <= REMEMBERED_AT_MOST) break;
      remembered.delete(key);
    }
  };

  const ended: SessionRevocation["ended"] = (userId, rows, reason) => {
    if (reason) remember(rows);
    for (const listener of listeners) {
      try {
        listener(userId);
      } catch (error) {
        // One holder of sockets failing must not keep the others' sockets open.
        log.warn("session_end_listener_failed", { reason: error });
      }
    }
  };

  return {
    // An address that is not there is not on a list — and when there is no list, nobody is asked.
    admits: (email) => allowlist.admits(typeof email === "string" ? email : ""),

    async revoke(userId, reason) {
      const rows = await database
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ token: sessions.token, expiresAt: sessions.expiresAt });
      ended(userId, rows, reason);
      if (rows.length > 0) {
        log.info("sessions_revoked", {
          user: userId,
          why: reason,
          sessions: rows.length,
        });
      }
      return rows.length;
    },

    /*
     * The token is NOT verified against the signature. Nothing is granted by a match: it only
     * decides whether a request that is already refused is told its session was taken away or that
     * nobody is signed in. Forging a match needs the revoked token itself, which is the secret the
     * cookie was.
     */
    wasRevoked(headers) {
      for (const token of sessionTokensIn(headers)) {
        const key = fingerprint(token);
        const expiresAt = remembered.get(key);
        if (expiresAt === undefined) continue;
        if (expiresAt > now()) return true;
        remembered.delete(key);
      }
      return false;
    },

    ended,

    onEnded(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async sweep(among) {
      if (!allowlist.enforced) return { people: 0, sessions: 0 };
      if (among?.length === 0) return { people: 0, sessions: 0 };
      const held = await database
        .select({
          id: sessions.id,
          userId: sessions.userId,
          email: users.email,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(among ? inArray(sessions.userId, [...among]) : undefined);
      const doomed = held.filter((row) => !allowlist.admits(row.email));
      if (doomed.length === 0) return { people: 0, sessions: 0 };
      const rows = await database
        .delete(sessions)
        .where(
          inArray(
            sessions.id,
            doomed.map((row) => row.id),
          ),
        )
        .returning({
          userId: sessions.userId,
          token: sessions.token,
          expiresAt: sessions.expiresAt,
        });
      const byPerson = new Map<string, EndedSession[]>();
      for (const row of rows) {
        const list = byPerson.get(row.userId) ?? [];
        list.push({ token: row.token, expiresAt: row.expiresAt });
        byPerson.set(row.userId, list);
      }
      for (const [userId, list] of byPerson) {
        ended(userId, list, "sign_in_list");
      }
      log.info("sessions_revoked", {
        why: "sign_in_list",
        people: byPerson.size,
        sessions: rows.length,
      });
      return { people: byPerson.size, sessions: rows.length };
    },
  };
}
