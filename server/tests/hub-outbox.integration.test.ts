import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { hubOutbox } from "../src/db/schema";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import { createHubOutbox } from "../src/hub/outbox";

/**
 * The hub outbox against a real Postgres, because what it promises is the database's: a row that
 * outlives a hub being down, a key that stays the same across every attempt, and a row lock that
 * lets two senders run at once and still send each row once.
 *
 * The hub is a script: each request is answered from a function the test sets, and recorded.
 */

// Two transactions at once for the race below: `createDatabase` gives transactions half of `max`.
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  { max: 4 },
);

const made: string[] = [];

afterEach(async () => {
  if (made.length) {
    await database.delete(hubOutbox).where(inArray(hubOutbox.id, made));
    made.length = 0;
  }
});

afterAll(async () => {
  await database.$client.close();
});

type Answer = HubAnswer<unknown>;

function scriptedHub(
  answer: (request: HubRequest) => Answer | Promise<Answer>,
) {
  const seen: HubRequest[] = [];
  const http: HubHttp = {
    async request(request) {
      seen.push(request);
      return (await answer(request)) as never;
    },
    socket: () => ({ url: "ws://unused", headers: {} }),
  };
  return { http, seen };
}

const down: Answer = { ok: false, status: null, code: "laf:hub_unreachable" };
const took: Answer = { ok: true, status: 200, body: { ok: true } };

async function rowOf(id: string) {
  const [row] = await database
    .select()
    .from(hubOutbox)
    .where(inArray(hubOutbox.id, [id]));
  return row;
}

describe("the hub outbox", () => {
  test("a hub that is down keeps the row; when it is back the row is sent with the same key", async () => {
    let up = false;
    const waits: number[] = [];
    const hub = scriptedHub(() => (up ? took : down));
    const outbox = createHubOutbox({
      database,
      http: hub.http,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    const id = await outbox.enqueue({
      method: "POST",
      path: "/rooms/r1/messages",
      body: { text: "내일 회의 10시" },
      origin: "chat",
      runId: "run_9",
    });
    made.push(id);
    await outbox.sweep();

    const kept = await rowOf(id);
    // Tried once and three more times, 0.5 s, 2 s and 8 s apart, and still there.
    expect(kept?.deliveredAt).toBeNull();
    expect(kept?.refusedAt).toBeNull();
    expect(kept?.lastCode).toBe("laf:hub_unreachable");
    expect(kept?.attempts).toBe(4);
    expect(waits).toEqual([500, 2_000, 8_000]);

    up = true;
    const sweep = await outbox.sweep();
    expect(sweep.delivered).toBe(1);
    const delivered = await rowOf(id);
    expect(delivered?.deliveredAt).toBeInstanceOf(Date);
    expect(delivered?.status).toBe(200);
    expect(delivered?.lastCode).toBeNull();

    // Every attempt carried the row's id as its key, one attempt each, with the run and origin.
    expect(hub.seen).toHaveLength(5);
    expect(new Set(hub.seen.map((request) => request.idempotencyKey))).toEqual(
      new Set([id]),
    );
    expect(hub.seen.every((request) => request.retry === false)).toBe(true);
    expect(hub.seen[4]).toMatchObject({
      method: "POST",
      path: "/rooms/r1/messages",
      body: { text: "내일 회의 10시" },
      origin: "chat",
      run: "run_9",
    });

    // Delivered is the end: the next sweep sends nothing.
    await outbox.sweep();
    expect(hub.seen).toHaveLength(5);
  });

  test("a refusal ends the row and is never sent again", async () => {
    const hub = scriptedHub(() => ({
      ok: false,
      status: 400,
      code: "laf:request_invalid",
    }));
    const outbox = createHubOutbox({
      database,
      http: hub.http,
      sleep: async () => {},
    });
    const id = await outbox.enqueue({
      method: "PUT",
      path: "/skills/x",
      body: {},
      origin: "person",
    });
    made.push(id);
    await outbox.sweep();
    await outbox.sweep();
    const row = await rowOf(id);
    expect(row?.refusedAt).toBeInstanceOf(Date);
    expect(row?.status).toBe(400);
    expect(row?.lastCode).toBe("laf:request_invalid");
    expect(
      hub.seen.filter((request) => request.idempotencyKey === id),
    ).toHaveLength(1);
  });

  test("a refused pass keeps the row, says so once, and sends nothing while paused", async () => {
    let paused = false;
    let told = 0;
    const hub = scriptedHub(() => ({
      ok: false,
      status: 401,
      code: "laf:hub_pass_refused",
    }));
    const outbox = createHubOutbox({
      database,
      http: hub.http,
      paused: () => paused,
      onPassRefused: () => {
        told += 1;
        paused = true;
      },
      sleep: async () => {},
    });
    const id = await outbox.enqueue({
      method: "POST",
      path: "/tasks",
      body: { title: "견적" },
      origin: "job",
    });
    made.push(id);
    await outbox.sweep();
    await outbox.sweep();
    const row = await rowOf(id);
    expect(row?.deliveredAt).toBeNull();
    expect(row?.refusedAt).toBeNull();
    expect(row?.lastCode).toBe("laf:hub_pass_refused");
    expect(told).toBe(1);
    expect(hub.seen).toHaveLength(1);
  });

  test("two senders at once send each row once", async () => {
    let inFlight = 0;
    let most = 0;
    const answer = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Bun.sleep(30);
      inFlight -= 1;
      return took;
    };
    const parked = scriptedHub(() => down);
    const writer = createHubOutbox({
      database,
      http: parked.http,
      // Paused, so the rows wait for the two senders below rather than being sent on enqueue.
      paused: () => true,
    });
    for (let index = 0; index < 6; index += 1) {
      made.push(
        await writer.enqueue({
          method: "POST",
          path: `/rooms/r1/messages`,
          body: { n: index },
          origin: "chat",
        }),
      );
    }
    const first = scriptedHub(answer);
    const second = scriptedHub(answer);
    const [a, b] = await Promise.all([
      createHubOutbox({ database, http: first.http }).sweep(),
      createHubOutbox({ database, http: second.http }).sweep(),
    ]);
    expect(parked.seen).toHaveLength(0);
    expect(a.delivered + b.delivered).toBe(6);
    const keys = [...first.seen, ...second.seen].map(
      (request) => request.idempotencyKey,
    );
    expect(keys).toHaveLength(6);
    expect(new Set(keys)).toEqual(new Set(made));
    // They did run side by side; a lock that serialised them whole would pass the count above too.
    expect(most).toBe(2);
  });
});
