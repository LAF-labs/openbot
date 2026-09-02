/**
 * Telling the fleet tool that a person arrived, and that a person left.
 *
 * WHY THIS EXISTS AT ALL. A VM is created when somebody signs up and pays, and destroyed when they
 * withdraw. Neither half is done here: the fleet tool (`laf-control`, a separate private
 * repository) owns the machines, and this deployment is the only thing that knows the moment a
 * person pressed the button on `POST /api/me/delete`. Without this webhook a withdrawal is complete
 * in the database and invisible everywhere else — the person is gone, their rows are gone, and
 * their VM keeps running and keeps being paid for, indefinitely.
 *
 * `remainingAccounts` IS THE FACT THE FLEET ACTS ON. Not "somebody left" — how many are left. Zero
 * means this machine has nobody on it and may be destroyed; anything else means it may not, and a
 * deployment with staff accounts on it is exactly the case a naive "account.deleted → destroy"
 * would get catastrophically wrong.
 *
 * THE CUSTOMER IS THE ORIGIN, NEVER THE PERSON. `PUBLIC_ORIGIN` already names this deployment and
 * the fleet's own records are keyed by it, so that is what identifies the notice. No email address
 * goes over this wire in either direction: the actor is the same pseudonym the audit trail carries
 * after a deletion (`deleted-<hash>`), and on the arrival side an opaque user id. A fleet tool
 * holding a list of customer addresses is a second copy of the thing this product spends a whole
 * deletion path removing.
 *
 * SIGNED, because the endpoint on the other end takes destructive action on a machine. HMAC-SHA256
 * over the exact bytes sent, in `x-laf-signature`, with the event repeated in `x-laf-event` so a
 * receiver can route without parsing. The secret is shared configuration, not a per-deployment key:
 * the origin in the body is what says which deployment this is, and it is inside the signed bytes.
 *
 * AND IT NEVER THROWS. A fleet that cannot be told must not undo a person's withdrawal — the rows
 * are already gone by the time this runs, so an exception here would be a 500 in front of somebody
 * whose account really was deleted. Every failure ends as an audit row instead.
 */
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { users } from "../db/schema";

/** What the fleet is told about. Both carry the same envelope. */
export type FleetEvent = "account.created" | "account.deleted";

export type FleetNotice = {
  event: FleetEvent;
  /** The pseudonym the trail carries after a deletion, or an opaque user id. Never an address. */
  actor: string;
  /** How many `users` rows are left. Zero means this VM has nobody on it. */
  remainingAccounts: number;
};

export type FleetNotifier = {
  notify: (notice: FleetNotice) => Promise<void>;
};

/**
 * Three attempts, and the gaps between them.
 *
 * The bound that matters is the total, not the count: the deletion route awaits this, so a person
 * who pressed "delete everything" is watching a spinner for as long as it runs. Worst case here is
 * three timeouts plus the two waits — a little over ten seconds — against a fleet that is down,
 * which is a case that ends in an audit row rather than in anything the person has to care about.
 */
const ATTEMPTS = 3;
const BACKOFF_MS = [250, 1_000];
const SEND_TIMEOUT_MS = 3_000;

/**
 * The signature the receiver checks, over the exact body bytes.
 *
 * Exported because it is the half of the contract the other repository has to implement, and a
 * signature that is computed over a re-serialised body agrees with this only by luck — the caller
 * below signs and sends one string for that reason.
 */
export function signFleetBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * How many accounts this deployment still has.
 *
 * Here rather than at each call site so that "the count after the change" is one statement in one
 * place: a deletion that counted before its own transaction committed, or a sign-up that counted
 * before the row it just created, would each hand the fleet a number that is off by exactly one —
 * and the one that matters is one versus zero.
 */
export async function countAccounts(database: Database): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  return Number(row?.count ?? 0);
}

export type FleetNotifierOptions = {
  webhookUrl: string;
  secret: string;
  /** `PUBLIC_ORIGIN`: what the fleet knows this customer by. */
  origin: string;
  auditStore: AuditStore;
  /** Injected in tests. Production passes neither. */
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
};

export function createFleetNotifier(
  options: FleetNotifierOptions,
): FleetNotifier {
  const send = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? (() => new Date());

  return {
    async notify(notice) {
      /*
       * Serialised once and both signed and sent, because a signature over anything but the bytes
       * on the wire is a signature the receiver cannot reproduce.
       */
      const body = JSON.stringify({
        event: notice.event,
        origin: options.origin,
        actor: notice.actor,
        remainingAccounts: notice.remainingAccounts,
        at: now().toISOString(),
      });
      const headers = {
        "content-type": "application/json",
        "x-laf-event": notice.event,
        "x-laf-signature": signFleetBody(body, options.secret),
      };

      let delivered = false;
      let status = "unreachable";
      let attempts = 0;

      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        attempts = attempt;
        try {
          const response = await send(options.webhookUrl, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
          status = String(response.status);
          if (response.ok) {
            delivered = true;
            break;
          }
          /*
           * A 4xx is the fleet understanding the notice and refusing it — a bad signature, an
           * origin it has never heard of. Sending the identical bytes twice more changes nothing
           * and delays the person waiting, so only a 5xx and a network failure are retried.
           */
          if (response.status < 500) break;
        } catch (error) {
          // The name, when the failure has one worth recording — `TimeoutError` and
          // `ConnectionRefused` say different things to whoever reads the row. A plain `Error` is
          // every other network failure and its name says nothing, so it reads as unreachable.
          const name = error instanceof Error ? error.name : "";
          status = name && name !== "Error" ? name : "unreachable";
        }
        if (attempt < ATTEMPTS) {
          await sleep(BACKOFF_MS[attempt - 1] ?? 1_000);
        }
      }

      /*
       * The row, and no body in it. What an operator needs from the trail is whether the fleet was
       * told and what it said back; the payload is already in this file and in the fleet's own
       * logs, and a copy of it here would put an origin, an actor and a headcount into a table that
       * outlives the account by a year for no question it answers.
       */
      await recordAuditEvent(options.auditStore, {
        eventType: delivered ? "fleet.notified" : "fleet.notify_failed",
        targetType: "fleet",
        targetId: options.origin,
        actorUserId: notice.actor,
        payload: {
          event: notice.event,
          status,
          attempts,
          remainingAccounts: notice.remainingAccounts,
        },
      }).catch(() => undefined);

      if (!delivered) {
        console.error(
          `[fleet] ${notice.event} was not delivered after ${attempts} attempt(s): ${status}`,
        );
      }
    },
  };
}
