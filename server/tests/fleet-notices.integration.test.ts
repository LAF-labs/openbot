import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAccountDeletion } from "../src/account/deletion";
import { pseudonymFor } from "../src/account/pseudonym";
import { createAccountRoutes } from "../src/account/routes";
import { createAuditStore } from "../src/audit";
import { announceArrival } from "../src/auth";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { auditEvents, lafNotifications, users } from "../src/db/schema";
import {
  countAccounts,
  createFleetDoor,
  createFleetNotifier,
} from "../src/fleet/notify";
import {
  createNotificationOutbox,
  purgeNotificationsBefore,
} from "../src/notifications/outbox";
import { TEST_POOL } from "./support/database";

/**
 * A person presses "delete everything", and the machine they were on hears about it.
 *
 * DRIVEN THROUGH THE ROUTE, against a webhook that is really listening on a port, because the two
 * failures this is about are both invisible from the module's own tests. The first is a withdrawal
 * that answers 500 because the fleet was down — the account really is gone by then, and telling
 * somebody otherwise is the worst answer this route can give. The second is arithmetic: the fleet
 * destroys a VM on `remainingAccounts: 0`, so a count taken one statement too early destroys a
 * machine that still has staff on it, or spares one that has nobody.
 *
 * And a third since audit A1-4 (2026-09-10): the notice was one `fetch` after the commit, so a
 * process that died in between, or a fleet that was down, lost it for good — the person gone, the
 * VM billed on. It is a row in the notification outbox now, written in the deletion's transaction
 * and offered to the fleet's door until the fleet takes it.
 *
 * The counts are read live rather than asserted as a constant: this database is shared with the
 * rest of the suite, so what is asserted is the DIFFERENCE the deletion made.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);
const auditStore = createAuditStore(database);
const suite = randomUUID().slice(0, 8);
const ORIGIN = "https://example.agent.laf-co.com";
const SECRET = "fleet-secret-for-this-suite";
const madeIds: string[] = [];

type Received = { body: string; signature: string; event: string };

type FleetServer = ReturnType<typeof Bun.serve>;

/** A fleet endpoint on a real port, answering whatever this test needs it to. */
function fleetOn(status: number): {
  server: FleetServer;
  received: Received[];
} {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({
        body: await request.text(),
        signature: request.headers.get("x-laf-signature") ?? "",
        event: request.headers.get("x-laf-event") ?? "",
      });
      return new Response(null, { status });
    },
  });
  return { server, received };
}

async function makePerson(label: string) {
  const id = `fleet-${suite}-${label}`;
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email, name: label });
  madeIds.push(id);
  return { id, email };
}

/** The outbox as `main.ts` builds it for a deployment with a fleet: the fleet's door among its doors. */
function outboxTo(webhookUrl: string) {
  return createNotificationOutbox({
    database,
    adapters: [
      createFleetDoor(
        createFleetNotifier({
          webhookUrl,
          secret: SECRET,
          origin: ORIGIN,
          auditStore,
          // The retries inside one delivery are the notifier's own test; here they only cost time.
          sleep: async () => {},
        }),
      ),
    ],
    log: () => {},
  });
}

/** The route as the browser reaches it, with the fleet told through `fleetNotices`. */
function surface(
  actor: { id: string; email: string },
  fleetNotices: ReturnType<typeof outboxTo>,
) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { ...actor, role: "user" });
    await next();
  };

  return new Hono<{ Variables: AppVariables }>().route(
    "/api",
    createAccountRoutes(
      {
        exporter: {
          stream: () => new Response("{}").body as ReadableStream<Uint8Array>,
        },
        deletion: createAccountDeletion({ database, fleetNotices }),
        auditStore,
      },
      requireUser,
    ),
  );
}

const withdraw = (
  person: { id: string; email: string },
  fleetNotices: ReturnType<typeof outboxTo>,
) =>
  surface(person, fleetNotices).request("/api/me/delete", {
    method: "POST",
    body: JSON.stringify({ confirm: person.email }),
  });

/** The fleet rows this file wrote. They carry no person, so they are found by the pseudonym. */
async function noticesFor(person: { id: string }) {
  return database
    .select()
    .from(lafNotifications)
    .where(
      and(
        eq(lafNotifications.kind, "fleet.account_deleted"),
        sql`${lafNotifications.subject} ->> 'actor' = ${pseudonymFor(person.id)}`,
      ),
    );
}

// A fleet row outlives its person by design and no cascade takes it, so this file removes its own —
// by pseudonym, never by kind — before the next test's outbox would offer it to the next fleet.
afterEach(async () => {
  const pseudonyms = madeIds.map((id) => pseudonymFor(id));
  if (pseudonyms.length === 0) return;
  await database
    .delete(lafNotifications)
    .where(
      and(
        eq(lafNotifications.kind, "fleet.account_deleted"),
        inArray(
          sql<string>`${lafNotifications.subject} ->> 'actor'`,
          pseudonyms,
        ),
      ),
    );
});

afterAll(async () => {
  // Audit rows cannot be removed — the table refuses DELETE — and land in the disposable test
  // database. The `users` rows are this file's to clean up.
  if (madeIds.length) {
    await database.delete(users).where(inArray(users.id, madeIds));
  }
});

describe("a withdrawal reaching the fleet", () => {
  test("carries a verifiable signature and the headcount left behind", async () => {
    const { server, received } = fleetOn(204);
    const person = await makePerson("told");
    const before = await countAccounts(database);

    try {
      const response = await withdraw(person, outboxTo(server.url.href));
      expect(response.status).toBe(200);
    } finally {
      await server.stop(true);
    }

    expect(received).toHaveLength(1);
    const notice = received[0];
    expect(notice?.event).toBe("account.deleted");
    // Verified the way the other repository will verify it: over the bytes that arrived.
    expect(notice?.signature).toBe(
      `sha256=${createHmac("sha256", SECRET)
        .update(notice?.body ?? "")
        .digest("hex")}`,
    );

    const payload = JSON.parse(notice?.body ?? "{}");
    expect(payload.origin).toBe(ORIGIN);
    // The pseudonym the trail carries from here on, and not the address that was just deleted.
    expect(payload.actor).toBe(pseudonymFor(person.id));
    expect(notice?.body).not.toContain(person.email);
    // Counted inside the deletion, after the person's row: one fewer than a moment ago.
    expect(payload.remainingAccounts).toBe(before - 1);
    expect(await countAccounts(database)).toBe(before - 1);

    // The outbox row says the fleet took it, so no tick will send it again.
    const [row] = await noticesFor(person);
    expect(row?.userId).toBeNull();
    expect(row?.deliveredVia).toEqual(["fleet"]);
    expect(row?.deliveredAt).not.toBeNull();

    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, pseudonymFor(person.id)),
          eq(auditEvents.eventType, "fleet.notified"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      event: "account.deleted",
      status: "204",
      attempts: 1,
    });
    // The row says what happened, not what was said: no body, so no origin and no headcount that
    // outlives the account by a year.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain(ORIGIN);
  });

  test("still answers with its counts when the fleet is down, and keeps the notice", async () => {
    const { server, received } = fleetOn(500);
    const person = await makePerson("untold");
    const before = await countAccounts(database);

    let body: { deleted: boolean; counts: Record<string, number> };
    try {
      const response = await withdraw(person, outboxTo(server.url.href));
      // The account is gone. A fleet that could not be told must not make this look like a failure.
      expect(response.status).toBe(200);
      body = (await response.json()) as typeof body;
    } finally {
      await server.stop(true);
    }

    expect(body.deleted).toBe(true);
    expect(body.counts.user).toBe(1);
    expect(
      await database.select().from(users).where(eq(users.id, person.id)),
    ).toHaveLength(0);

    // Three attempts, and then the trail carries the one thing nobody could otherwise find out.
    expect(received).toHaveLength(3);
    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, pseudonymFor(person.id)),
          eq(auditEvents.eventType, "fleet.notify_failed"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ status: "500", attempts: 3 });

    // And the notice is not lost with that one try: a row, undelivered, with the headcount.
    const [notice] = await noticesFor(person);
    expect(notice?.deliveredAt).toBeNull();
    expect(notice?.subject).toMatchObject({
      event: "account.deleted",
      remainingAccounts: before - 1,
    });
  }, 20_000);

  test("a notice the fleet did not take is offered again until it does — once", async () => {
    const down = fleetOn(503);
    const person = await makePerson("retried");
    try {
      expect(
        (await withdraw(person, outboxTo(down.server.url.href))).status,
      ).toBe(200);
    } finally {
      await down.server.stop(true);
    }

    // The tick, with the fleet back: delivered, and marked so the next tick sends nothing.
    const up = fleetOn(204);
    const outbox = outboxTo(up.server.url.href);
    try {
      expect(await outbox.redeliver()).toBe(1);
      expect(await outbox.redeliver()).toBe(0);
    } finally {
      await up.server.stop(true);
    }
    expect(up.received).toHaveLength(1);
    expect(JSON.parse(up.received[0]?.body ?? "{}").actor).toBe(
      pseudonymFor(person.id),
    );
    const [notice] = await noticesFor(person);
    expect(notice?.deliveredVia).toEqual(["fleet"]);
  }, 20_000);

  test("a process that dies after the commit leaves the notice for the next boot", async () => {
    const person = await makePerson("died");
    // The process that deleted the account dies before it can offer the notice to anybody.
    const dying = outboxTo("http://127.0.0.1:9/never");
    const deletion = createAccountDeletion({
      database,
      fleetNotices: {
        recordFleetNotice: dying.recordFleetNotice,
        redeliver: async () => 0,
      },
    });
    const result = await deletion.delete({ userId: person.id, by: person.id });
    expect(result.deleted).toBe(true);
    expect((await noticesFor(person))[0]?.deliveredAt).toBeNull();

    // The next process boots with the fleet reachable, and the one call it makes at boot tells it.
    const { server, received } = fleetOn(204);
    try {
      await outboxTo(server.url.href).redeliver();
    } finally {
      await server.stop(true);
    }
    expect(received.map((notice) => JSON.parse(notice.body).actor)).toEqual([
      pseudonymFor(person.id),
    ]);
  });

  test("a withdrawal whose notice cannot be written does not happen", async () => {
    const person = await makePerson("unwritten");
    const deletion = createAccountDeletion({
      database,
      fleetNotices: {
        recordFleetNotice: async () => {
          throw new Error("the outbox is unwritable");
        },
        redeliver: async () => 0,
      },
    });

    await expect(
      deletion.delete({ userId: person.id, by: person.id }),
    ).rejects.toThrow("the outbox is unwritable");
    // All or nothing: a person still here can press the button again; a person gone with no notice
    // is the VM nobody ever destroys.
    expect(
      await database.select().from(users).where(eq(users.id, person.id)),
    ).toHaveLength(1);
  });

  test("the thirty-day sweep keeps a notice the fleet has not taken", async () => {
    const kept = await makePerson("sweep-kept");
    const gone = await makePerson("sweep-gone");
    const outbox = outboxTo("http://127.0.0.1:9/never");
    for (const person of [kept, gone]) {
      await outbox.recordFleetNotice(database, {
        event: "account.deleted",
        actor: pseudonymFor(person.id),
        remainingAccounts: 1,
      });
    }
    // Both written long ago, which no other file's row is; one of them delivered.
    const longAgo = new Date("2001-01-01T00:00:00Z");
    for (const person of [kept, gone]) {
      await database
        .update(lafNotifications)
        .set({ createdAt: longAgo })
        .where(
          eq(lafNotifications.id, (await noticesFor(person))[0]?.id ?? ""),
        );
    }
    await database
      .update(lafNotifications)
      .set({ deliveredAt: longAgo, deliveredVia: ["fleet"] })
      .where(eq(lafNotifications.id, (await noticesFor(gone))[0]?.id ?? ""));

    await purgeNotificationsBefore(database, new Date("2001-06-01T00:00:00Z"));

    expect(await noticesFor(kept)).toHaveLength(1);
    expect(await noticesFor(gone)).toHaveLength(0);
  });

  test("a deployment with no fleet configured still deletes the account", async () => {
    const person = await makePerson("nofleet");
    const deletion = createAccountDeletion({ database });

    const result = await deletion.delete({ userId: person.id, by: person.id });

    expect(result.deleted).toBe(true);
    expect(
      await database.select().from(users).where(eq(users.id, person.id)),
    ).toHaveLength(0);
    expect(await noticesFor(person)).toHaveLength(0);
  });
});

/**
 * The other end of the same envelope.
 *
 * Driven through `announceArrival` rather than through a sign-in, because everything between an
 * OAuth redirect and better-auth's `user.create.after` hook belongs to better-auth. What is asserted
 * here is the half this repository owns: that the notice carries the account it was given, the
 * headcount including it, and no address.
 */
describe("an arrival reaching the fleet", () => {
  test("counts the person who just arrived", async () => {
    const { server, received } = fleetOn(204);
    const person = await makePerson("arrived");
    const notifier = createFleetNotifier({
      webhookUrl: server.url.href,
      secret: SECRET,
      origin: ORIGIN,
      auditStore,
    });

    try {
      await announceArrival(database, notifier, person.id);
    } finally {
      await server.stop(true);
    }

    expect(received).toHaveLength(1);
    expect(received[0]?.event).toBe("account.created");
    const payload = JSON.parse(received[0]?.body ?? "{}");
    expect(payload.actor).toBe(person.id);
    expect(received[0]?.body).not.toContain(person.email);
    // Including them: an arrival that counted before its own row would report the deployment empty.
    expect(payload.remainingAccounts).toBe(await countAccounts(database));
    expect(payload.remainingAccounts).toBeGreaterThan(0);

    const rows = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, person.id),
          eq(auditEvents.eventType, "fleet.notified"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ event: "account.created" });
  });

  test("a deployment with no fleet says nothing and does not fail the sign-in", async () => {
    const person = await makePerson("arrived-nofleet");
    await expect(
      announceArrival(database, undefined, person.id),
    ).resolves.toBeUndefined();
  });
});
