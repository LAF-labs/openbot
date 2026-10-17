import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { HubSync } from "../../shared/hub/protocol";
import { emitEvent, eventsSince } from "../src/events";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";

let hub: TestHub;
const ann = {
  email: "ann@example.com",
  vmOrigin: "https://ann.example",
  pass: newPass(),
};
const ben = {
  email: "ben@example.com",
  vmOrigin: "https://ben.example",
  pass: newPass(),
};
let annId = "";
let benId = "";

beforeAll(async () => {
  hub = await startTestHub();
  annId = (await putMember(hub, ann)).id;
  benId = (await putMember(hub, ben)).id;
});
afterAll(() => hub.stop());

async function sync(pass: string, query: string): Promise<HubSync> {
  const response = await fetch(
    `${hub.url}/hub/v1/sync?${query}`,
    asMember(pass),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as HubSync;
}

async function emit(count: number, visibleTo: string[] | null = null) {
  const seqs: number[] = [];
  for (let index = 0; index < count; index += 1) {
    seqs.push(
      await hub.database.transaction((tx) =>
        emitEvent(tx, {
          type: "member.changed",
          refId: `r${index}`,
          visibleTo,
        }),
      ),
    );
  }
  return seqs;
}

describe("/sync", () => {
  test("pages through everything after the cursor, in order, and says when there is more", async () => {
    const start = (await sync(ann.pass, "since=0")).seq;
    const written = await emit(7);
    const first = await sync(ann.pass, `since=${start}&limit=3`);
    expect(first.events.map((event) => event.seq)).toEqual(written.slice(0, 3));
    expect(first.more).toBe(true);
    expect(first.seq).toBe(written[2] as number);
    const second = await sync(ann.pass, `since=${first.seq}&limit=3`);
    expect(second.events.map((event) => event.seq)).toEqual(
      written.slice(3, 6),
    );
    const third = await sync(ann.pass, `since=${second.seq}&limit=3`);
    expect(third.events.map((event) => event.seq)).toEqual(written.slice(6));
    expect(third.more).toBe(false);
    const fourth = await sync(ann.pass, `since=${third.seq}`);
    expect(fourth).toEqual({
      ok: true,
      events: [],
      seq: third.seq,
      more: false,
    });
  });

  test("an event for one member is not listed for another, and the other's cursor still passes it", async () => {
    const start = (await sync(ben.pass, "since=0")).seq;
    const [onlyAnn] = await emit(1, [annId]);
    const [everyone] = await emit(1);
    const [onlyBen] = await emit(1, [benId]);

    const forBen = await sync(ben.pass, `since=${start}`);
    expect(forBen.events.map((event) => event.seq)).toEqual([
      everyone,
      onlyBen,
    ]);
    expect(forBen.seq).toBe(onlyBen as number);

    const forAnn = await sync(ann.pass, `since=${start}`);
    expect(forAnn.events.map((event) => event.seq)).toEqual([
      onlyAnn,
      everyone,
    ]);
    // Ann's cursor moves past Ben's event without listing it.
    expect(forAnn.seq).toBe(onlyBen as number);
  });

  test("the cursor moves past a page of nothing but other members' events", async () => {
    const start = (await sync(ann.pass, "since=0")).seq;
    const hidden = await emit(4, [benId]);
    const page = await eventsSince(hub.database, annId, start, 2);
    expect(page.events).toEqual([]);
    expect(page.seq).toBe(hidden[3] as number);
  });

  test.each(["since=-1", "since=abc", "since=1.5", "limit=0"])(
    "%s is a 400",
    async (query) => {
      const response = await fetch(
        `${hub.url}/hub/v1/sync?${query}`,
        asMember(ann.pass),
      );
      expect(response.status).toBe(400);
    },
  );

  test("an event numbered earlier but committed later is never skipped by a cursor", async () => {
    const start = (await sync(ann.pass, "since=0")).seq;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let emittedA = () => {};
    const aEmitted = new Promise<void>((resolve) => {
      emittedA = resolve;
    });
    const a = hub.database.transaction(async (tx) => {
      const seq = await emitEvent(tx, { type: "member.changed", refId: "a" });
      emittedA();
      await held;
      return seq;
    });
    await aEmitted;
    const b = hub.database.transaction((tx) =>
      emitEvent(tx, { type: "member.changed", refId: "b" }),
    );
    // B is made to wait for A's commit: that wait is the guarantee, so the test waits to see it.
    for (let tries = 0; ; tries += 1) {
      const [waiting] = await hub.database.execute<{ n: string }>(
        sql`select count(*)::text as n from pg_locks where locktype = 'advisory' and not granted`,
      );
      if (waiting?.n === "1") break;
      if (tries > 100)
        throw new Error("the second writer never waited for the first");
      await Bun.sleep(10);
    }
    const during = await eventsSince(hub.database, annId, start);
    expect(during).toEqual({ events: [], seq: start, more: false });
    release();
    const [seqA, seqB] = await Promise.all([a, b]);
    expect(seqB).toBeGreaterThan(seqA);
    const after = await eventsSince(hub.database, annId, start);
    expect(after.events.map((event) => event.refId)).toEqual(["a", "b"]);
  });

  test("an event carries what changed and never more", async () => {
    const start = (await sync(ann.pass, "since=0")).seq;
    await emit(1);
    const [event] = (await sync(ann.pass, `since=${start}`)).events;
    expect(Object.keys(event ?? {}).sort()).toEqual([
      "actor",
      "at",
      "refId",
      "seq",
      "type",
    ]);
  });
});
