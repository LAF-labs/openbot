import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AbstractAgent } from "@ag-ui/client";
import { eq, inArray } from "drizzle-orm";
import type { AgentActor } from "../src/agents/profile-types";
import { createDeploymentAdmission } from "../src/auth/admission";
import { createSignInAllowlist } from "../src/auth/allowlist";
import type { AuditEventInput } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  lafNotifications,
  lafRoutineRuns,
  lafRoutines,
  users,
} from "../src/db/schema";
import {
  createNotificationOutbox,
  type NotificationAdapter,
} from "../src/notifications/outbox";
import { createRoutineService } from "../src/routines/service";
import { TEST_POOL } from "./support/database";

/**
 * A PERSON THE DEPLOYMENT NO LONGER ADMITS ACTS ON NOTHING — NOT EVEN WHILE NOBODY IS WATCHING.
 *
 * Removing somebody from the sign-in list ended their sessions (`auth/session-revocation.ts`) and
 * nothing else. Measured in the 2026-09-16 audit (R1-04, R2-F6): their routines kept firing on the
 * clock, "run now" and the webhook trigger kept running them, on the deployment's one shared browser
 * — which since `bc5bf3e` is signed in as the owner — and their notifications kept going out,
 * 알림톡 included, to a person who could no longer open what they were about.
 *
 * So every path that runs for a person with nobody signed in asks the one question
 * (`auth/admission.ts`), and a routine whose author is not admitted is skipped on the clock, refused
 * on "run now", declined on the trigger — each with a `routine.skipped_not_admitted` row — while the
 * deployment's own person is untouched. A notification addressed to somebody not admitted is kept as
 * a row and offered to no door.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const run = randomUUID().slice(0, 8);

type Person = AgentActor & { email: string; botId: string };

const person = (label: string): Person => ({
  id: `unattended-${label}-${run}`,
  role: "user",
  email: `unattended-${label}-${run}@laf.test`,
  botId: `unattended-${label}-bot-${run}`,
});
const OWNER = person("owner");
const LEFTOVER = person("leftover");
const PEOPLE = [OWNER, LEFTOVER];

/** The sign-in list this deployment booted with: the owner, and nobody else. */
const admission = createDeploymentAdmission({
  database,
  allowlist: createSignInAllowlist({
    allowedEmails: [OWNER.email],
    initialAdminEmails: [],
  }),
});

beforeAll(async () => {
  for (const one of PEOPLE) {
    await database
      .insert(users)
      .values({ id: one.id, email: one.email, name: one.id });
    await database.insert(agents).values({
      id: one.botId,
      name: `${one.id}'s Bot`,
      type: "remote_ag_ui",
      configuration: { endpoint: "https://bot.example.test/ag-ui" },
    });
    await database.insert(agentProfiles).values({
      agentId: one.botId,
      ownerUserId: one.id,
      roleDescription: "Keeps the books.",
      avatarSeed: one.botId,
    });
  }
});

afterAll(async () => {
  const botIds = PEOPLE.map((one) => one.botId);
  const routineIds = database
    .select({ id: lafRoutines.id })
    .from(lafRoutines)
    .where(inArray(lafRoutines.agentId, botIds));
  await database
    .delete(lafRoutineRuns)
    .where(inArray(lafRoutineRuns.routineId, routineIds));
  await database
    .delete(lafRoutines)
    .where(inArray(lafRoutines.agentId, botIds));
  await database
    .delete(lafNotifications)
    .where(inArray(lafNotifications.botId, botIds));
  await database.delete(agents).where(inArray(agents.id, botIds));
  await database.delete(users).where(
    inArray(
      users.id,
      PEOPLE.map((one) => one.id),
    ),
  );
  await database.$client.close();
});

/** Each Bot answers at once, and says whose instruction reached it. */
function roster() {
  const asked: string[] = [];
  const agentFor = (): AbstractAgent =>
    ({
      setMessages(messages: { content?: string }[]) {
        asked.push(messages[0]?.content ?? "");
      },
      async runAgent() {
        return {
          result: undefined,
          newMessages: [{ id: "m", role: "assistant", content: "done" }],
        };
      },
    }) as unknown as AbstractAgent;
  return {
    asked,
    agents: { [OWNER.botId]: agentFor(), [LEFTOVER.botId]: agentFor() },
  };
}

function serviceAt(clock: () => Date) {
  const { asked, agents: bots } = roster();
  const rows: AuditEventInput[] = [];
  const service = createRoutineService({
    database,
    resolveAgents: async () => bots,
    auditStore: {
      insert: async (event) => {
        rows.push(event);
      },
    },
    now: clock,
    admission,
  });
  const skipped = () =>
    rows.filter((row) => row.eventType === "routine.skipped_not_admitted");
  const ran = () => rows.filter((row) => row.eventType === "routine.ran");
  return { service, asked, rows, skipped, ran };
}

/** A routine on `whose` Bot, written by `whose` — or by somebody else, the way a leftover row is. */
async function routineOn(
  service: ReturnType<typeof serviceAt>["service"],
  whose: Person,
  instruction: string,
  author: Person = whose,
) {
  const routine = await service.create(whose, {
    agentId: whose.botId,
    name: instruction,
    instruction,
    schedule: { kind: "interval", minutes: 30 },
  });
  if (!routine) throw new Error("not created");
  if (author.id !== whose.id) {
    await database
      .update(lafRoutines)
      .set({ createdById: author.id })
      .where(eq(lafRoutines.id, routine.id));
  }
  return routine;
}

const rowOf = async (id: string) =>
  (await database.select().from(lafRoutines).where(eq(lafRoutines.id, id)))[0];

describe("a routine whose author the deployment no longer admits", () => {
  test("is skipped on the clock, with a row saying why, while the owner's runs", async () => {
    /*
     * A clock in 2020, far behind every other suite's: the tick claims whatever is due in the whole
     * (shared) table, and nothing anybody else made is due this early. The assertions still read only
     * this file's routines.
     */
    const created = new Date("2020-01-06T00:00:00Z");
    let clock = created;
    const { service, asked, skipped, ran } = serviceAt(() => clock);
    const leftovers = await routineOn(service, LEFTOVER, `leftover-${run}`);
    const owners = await routineOn(service, OWNER, `owner-${run}`);
    const ours = new Set([leftovers.id, owners.id]);
    const about = (rows: AuditEventInput[]) =>
      rows.filter((row) => ours.has(row.targetId ?? ""));

    clock = new Date(created.getTime() + 31 * 60_000);
    await service.tick();

    // The owner's Bot was asked; the leftover's never was.
    expect(asked.some((text) => text.includes(`owner-${run}`))).toBe(true);
    expect(asked.some((text) => text.includes(`leftover-${run}`))).toBe(false);
    expect(about(ran()).map((row) => row.targetId)).toEqual([owners.id]);
    expect(
      about(skipped()).map((row) => ({
        target: row.targetId,
        via: row.payload.via,
        actor: row.payload.actor,
      })),
    ).toEqual([{ target: leftovers.id, via: "clock", actor: LEFTOVER.id }]);
    // Nothing was recorded as a run of it, anywhere a person would read one.
    expect(
      await database
        .select()
        .from(lafRoutineRuns)
        .where(eq(lafRoutineRuns.routineId, leftovers.id)),
    ).toEqual([]);

    // Claimed for that window, so the next tick does not write the same skip again.
    const after = await rowOf(leftovers.id);
    expect(after?.nextRunAt.getTime()).toBeGreaterThan(clock.getTime());
    await service.tick();
    expect(about(skipped())).toHaveLength(1);
  });

  test("is refused on 'run now', without moving its clock", async () => {
    // The only way such a routine is in front of anybody: it drives the owner's Bot, and its author
    // is somebody the list has since dropped — a row from before a Bot was its owner's alone.
    const clock = new Date("2020-01-08T03:00:00Z");
    const { service, asked, skipped } = serviceAt(() => clock);
    const planted = await routineOn(service, OWNER, `planted-${run}`, LEFTOVER);
    const before = await rowOf(planted.id);

    await expect(service.runNow(OWNER, planted.id)).rejects.toMatchObject({
      status: 409,
      code: "laf:routine_author_not_admitted",
    });

    expect(asked).toEqual([]);
    expect(skipped().map((row) => row.payload.via)).toEqual(["run_now"]);
    const after = await rowOf(planted.id);
    expect(after?.nextRunAt).toEqual(before?.nextRunAt as Date);
    expect(after?.lastRunAt).toEqual(before?.lastRunAt ?? null);
  });

  test("is declined on the webhook, and the sender is told it did not run", async () => {
    let clock = new Date("2020-01-09T04:00:00Z");
    const { service, asked, skipped } = serviceAt(() => clock);
    const hooked = await routineOn(service, LEFTOVER, `hooked-${run}`);

    const outcome = await service.trigger(hooked.id, hooked.triggerToken);

    expect(outcome).toEqual({ ran: false, reason: "not_admitted" });
    expect(asked).toEqual([]);
    expect(skipped().map((row) => row.payload.via)).toEqual(["trigger"]);

    /*
     * The window is taken the way a run takes it, so a sender retrying in a burst — the token holder
     * is a machine, and nothing else bounds it — writes one row, not one per retry.
     */
    expect((await rowOf(hooked.id))?.lastRunAt).toEqual(clock);
    clock = new Date(clock.getTime() + 5_000);
    expect(await service.trigger(hooked.id, hooked.triggerToken)).toEqual({
      ran: false,
      reason: "debounced",
    });
    expect(skipped()).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  test("the owner's own routine still runs by every door", async () => {
    let clock = new Date("2020-01-07T05:00:00Z");
    const { service, asked, skipped } = serviceAt(() => clock);
    const mine = await routineOn(service, OWNER, `mine-${run}`);
    const reached = () =>
      asked.filter((text) => text.includes(`mine-${run}`)).length;

    await service.runNow(OWNER, mine.id);
    expect(reached()).toBe(1);

    // Past the trigger's debounce, so what answers is the admission and nothing else.
    clock = new Date(clock.getTime() + 60_000);
    const fired = await service.trigger(mine.id, mine.triggerToken);
    expect(fired.ran).toBe(true);
    if (fired.ran) await fired.finished;
    expect(reached()).toBe(2);

    clock = new Date(clock.getTime() + 31 * 60_000);
    await service.tick();
    expect(reached()).toBe(3);

    expect(skipped().filter((row) => row.targetId === mine.id)).toEqual([]);
  });
});

describe("a notification for somebody the deployment no longer admits", () => {
  /** A person's door that says it took everything, and remembers who it was offered. */
  const door = (name: string) => {
    const offered: string[] = [];
    const adapter: NotificationAdapter = {
      name,
      deliver: async (record) => {
        offered.push(record.userId);
        return true;
      },
    };
    return { adapter, offered };
  };

  test("is kept as a row and offered to no door; the owner's goes out as before", async () => {
    const webhook = door("webhook");
    const alimtalk = door("alimtalk");
    const outbox = createNotificationOutbox({
      database,
      adapters: [webhook.adapter, alimtalk.adapter],
      admission,
      log: () => undefined,
    });

    const forLeftover = await outbox.enqueue({
      kind: "run.failed",
      botId: LEFTOVER.botId,
      userId: LEFTOVER.id,
      run: { origin: "routine", code: "laf:turn_failed" },
    });
    const forOwner = await outbox.enqueue({
      kind: "run.failed",
      botId: OWNER.botId,
      userId: OWNER.id,
      run: { origin: "routine", code: "laf:turn_failed" },
    });

    expect(webhook.offered).toEqual([OWNER.id]);
    expect(alimtalk.offered).toEqual([OWNER.id]);
    expect(forLeftover?.deliveredVia).toEqual([]);
    expect(forLeftover?.deliveredAt).toBeUndefined();
    expect(forOwner?.deliveredVia).toEqual(["webhook", "alimtalk"]);

    // Nothing is thrown away: the row is there, undelivered, the way a door that declined leaves it.
    const [row] = await database
      .select()
      .from(lafNotifications)
      .where(eq(lafNotifications.id, forLeftover?.id ?? ""));
    expect(row?.deliveredAt).toBeNull();
  });

  test("a row offered again later is still offered to no door", async () => {
    const webhook = door("webhook");
    const outbox = createNotificationOutbox({
      database,
      adapters: [webhook.adapter],
      admission,
      log: () => undefined,
    });
    // Written the way a failure group's row is: inside somebody else's transaction, offered after.
    const [written] = await database
      .insert(lafNotifications)
      .values({
        id: randomUUID(),
        kind: "run.failed",
        botId: LEFTOVER.botId,
        userId: LEFTOVER.id,
        subject: { kind: "run", origin: "routine", code: "laf:turn_failed" },
        createdAt: new Date(),
      })
      .returning({ id: lafNotifications.id });

    const offered = await outbox.offer(written?.id ?? "");

    expect(webhook.offered).toEqual([]);
    expect(offered?.deliveredAt).toBeUndefined();
  });
});
