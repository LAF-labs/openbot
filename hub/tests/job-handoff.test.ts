import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  HUB_JOB_LIMITS,
  type HubJobHandoff,
  type HubSync,
  hubJobHandoffBytes,
} from "../../shared/hub/protocol";
import { sweepExpiredHandoffs } from "../src/job-handoff";
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
const cho = {
  email: "cho@example.com",
  vmOrigin: "https://cho.example",
  pass: newPass(),
  role: "admin" as const,
};
const dan = {
  email: "dan@example.com",
  vmOrigin: "https://dan.example",
  pass: newPass(),
};
let annId = "";
let benId = "";
let danId = "";

beforeAll(async () => {
  hub = await startTestHub();
  annId = (await putMember(hub, ann)).id;
  benId = (await putMember(hub, ben)).id;
  await putMember(hub, cho);
  danId = (await putMember(hub, dan)).id;
});
afterAll(() => hub.stop());

// The hub's database is this file's own; the handoffs go with their jobs.
beforeEach(async () => {
  await hub.database.execute(sql`delete from hub_jobs`);
});

type Reply = { status: number; body: Record<string, unknown> };

async function call(
  pass: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply> {
  const response = await fetch(`${hub.url}/hub/v1${path}`, {
    ...asMember(pass, { "content-type": "application/json" }),
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** A routine as #265's VM sends it (`server/src/hub/wire.ts`, `JobDefinition`). */
const definition = (instruction: string) => ({
  name: "아침 정리",
  instruction,
  summary: null,
  schedule: {
    kind: "daily",
    time: "07:30",
    timeZone: "Asia/Seoul",
    days: [1, 2, 3],
  },
  delivery: "chat",
});

/** Ann's job, handed to Ben: the move that opens the slot. */
async function movedToBen(id: string) {
  expect(
    (await call(ann.pass, "PUT", `/jobs/${id}`, { name: "Morning" })).status,
  ).toBe(200);
  const moved = await call(ann.pass, "PUT", `/jobs/${id}`, { owner: benId });
  expect(moved.status).toBe(200);
}

const handoff = (id: string) => `/jobs/${id}/handoff`;

async function seen(pass: string, since: number) {
  const reply = await call(pass, "GET", `/sync?since=${since}`);
  return (reply.body as unknown as HubSync).events;
}

async function headSeq(): Promise<number> {
  const rows = await hub.database.execute<{ head: string | null }>(
    sql`select max(seq)::text as head from hub_events`,
  );
  return Number(rows[0]?.head ?? 0);
}

test("the old runner hands on, the new one is told, takes it and clears it", async () => {
  await movedToBen("j-hand");
  const before = await headSeq();
  const put = await call(ann.pass, "PUT", handoff("j-hand"), {
    to: benId,
    definition: definition("매일 아침 메일 정리"),
  });
  expect(put.status).toBe(200);
  expect(put.body.to).toBe(benId);
  // The definition is not echoed: the answer may be kept for a retry.
  expect(JSON.stringify(put.body)).not.toContain("메일 정리");
  // Told again, to the new runner alone, so a VM that looked too early looks again.
  expect(
    (await seen(ben.pass, before)).map((event) => [event.type, event.refId]),
  ).toEqual([["job.moved", "j-hand"]]);
  expect(await seen(dan.pass, before)).toEqual([]);

  const got = await call(ben.pass, "GET", handoff("j-hand"));
  expect(got.status).toBe(200);
  const held = got.body.handoff as HubJobHandoff;
  expect(held).toMatchObject({
    jobId: "j-hand",
    from: annId,
    to: benId,
    definition: definition("매일 아침 메일 정리"),
  });
  expect(
    new Date(held.expiresAt).getTime() - new Date(held.createdAt).getTime(),
  ).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);

  expect((await call(ben.pass, "DELETE", handoff("j-hand"))).status).toBe(200);
  expect((await call(ben.pass, "GET", handoff("j-hand"))).status).toBe(404);
});

test("PUT: only the member it moved away from, and only with a move pending", async () => {
  await call(ann.pass, "PUT", "/jobs/j-put", { name: "Morning" });
  // Not moved yet: nobody is handing anything on.
  const early = await call(ann.pass, "PUT", handoff("j-put"), {
    definition: definition("x"),
  });
  expect(early.status).toBe(409);
  expect(early.body.code).toBe("laf:job_not_moving");
  await call(ann.pass, "PUT", "/jobs/j-put", { owner: benId });
  for (const pass of [ben.pass, dan.pass, cho.pass]) {
    const refused = await call(pass, "PUT", handoff("j-put"), {
      definition: definition("x"),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("laf:job_not_moving");
  }
  expect((await call(ben.pass, "GET", handoff("j-put"))).status).toBe(404);
  expect(
    (
      await call(ann.pass, "PUT", handoff("j-put"), {
        definition: definition("x"),
      })
    ).status,
  ).toBe(200);
  expect((await call(ben.pass, "GET", handoff("j-put"))).status).toBe(200);
});

test("GET: only the member it moved to — not the old runner, an admin or anybody else", async () => {
  await movedToBen("j-get");
  await call(ann.pass, "PUT", handoff("j-get"), {
    definition: definition("x"),
  });
  for (const pass of [ann.pass, cho.pass, dan.pass]) {
    const refused = await call(pass, "GET", handoff("j-get"));
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain("instruction");
  }
  expect((await call(ben.pass, "GET", handoff("j-get"))).status).toBe(200);
});

test("DELETE: the new runner or an admin; the old runner and a third member are refused", async () => {
  await movedToBen("j-del");
  await call(ann.pass, "PUT", handoff("j-del"), {
    definition: definition("x"),
  });
  expect((await call(ann.pass, "DELETE", handoff("j-del"))).status).toBe(403);
  expect((await call(dan.pass, "DELETE", handoff("j-del"))).status).toBe(403);
  expect((await call(ben.pass, "GET", handoff("j-del"))).status).toBe(200);
  expect((await call(cho.pass, "DELETE", handoff("j-del"))).status).toBe(200);
  expect((await call(ben.pass, "GET", handoff("j-del"))).status).toBe(404);
});

test("a definition over 64 KB is refused and nothing is kept; one under it is taken", async () => {
  await movedToBen("j-big");
  const big = await call(ann.pass, "PUT", handoff("j-big"), {
    definition: definition("가".repeat(22_000)),
  });
  expect(big.status).toBe(413);
  expect(big.body.field).toBe("definition");
  expect((await call(ben.pass, "GET", handoff("j-big"))).status).toBe(404);
  const fits = await call(ann.pass, "PUT", handoff("j-big"), {
    definition: definition("가".repeat(21_000)),
  });
  expect(fits.status).toBe(200);
});

test("the cap is the shared measure's: a definition at the cap is taken, one byte over is refused", async () => {
  await movedToBen("j-edge");
  // What a VM checks before it hands a job on, and what the hub counts, are the same number.
  const sized = (bytes: number) => {
    const empty = hubJobHandoffBytes(definition(""));
    const made = definition("a".repeat(bytes - empty));
    expect(hubJobHandoffBytes(made)).toBe(bytes);
    return made;
  };
  const over = await call(ann.pass, "PUT", handoff("j-edge"), {
    to: benId,
    definition: sized(HUB_JOB_LIMITS.handoffBytes + 1),
  });
  expect(over.status).toBe(413);
  const at = await call(ann.pass, "PUT", handoff("j-edge"), {
    to: benId,
    definition: sized(HUB_JOB_LIMITS.handoffBytes),
  });
  expect(at.status).toBe(200);
});

test("a second move before it is collected points the slot at the newest runner", async () => {
  await movedToBen("j-twice");
  await call(ann.pass, "PUT", handoff("j-twice"), {
    definition: definition("둘째"),
  });
  expect(
    (await call(ben.pass, "PUT", "/jobs/j-twice", { owner: danId })).status,
  ).toBe(200);
  expect((await call(ben.pass, "GET", handoff("j-twice"))).status).toBe(403);
  const got = await call(dan.pass, "GET", handoff("j-twice"));
  expect(got.status).toBe(200);
  expect(got.body.handoff).toMatchObject({
    from: annId,
    to: danId,
    definition: definition("둘째"),
  });
});

test("a handoff nobody came for runs out: not given, refused a late fill, and swept", async () => {
  await movedToBen("j-old");
  await call(ann.pass, "PUT", handoff("j-old"), {
    definition: definition("x"),
  });
  await movedToBen("j-fresh");
  await call(ann.pass, "PUT", handoff("j-fresh"), {
    definition: definition("y"),
  });
  await hub.database.execute(
    sql`update hub_job_handoffs set expires_at = now() - interval '1 second' where job_id = 'j-old'`,
  );
  expect((await call(ben.pass, "GET", handoff("j-old"))).status).toBe(404);
  expect(
    (
      await call(ann.pass, "PUT", handoff("j-old"), {
        definition: definition("x"),
      })
    ).status,
  ).toBe(409);
  expect(await sweepExpiredHandoffs(hub.database)).toBe(1);
  const left = await hub.database.execute<{ job_id: string }>(
    sql`select job_id from hub_job_handoffs order by job_id`,
  );
  expect(left.map((row) => row.job_id)).toEqual(["j-fresh"]);
  expect((await call(ben.pass, "GET", handoff("j-fresh"))).status).toBe(200);
});

test("the definition is in no event, trail row, kept answer, register row or log line", async () => {
  const marker = "MARKER-def-7f3a";
  await movedToBen("j-secret");
  // Refused and oversized attempts carry it too.
  await call(dan.pass, "PUT", handoff("j-secret"), {
    definition: definition(marker),
  });
  await call(ann.pass, "PUT", handoff("j-secret"), {
    definition: definition(`${marker}${"가".repeat(22_000)}`),
  });
  await fetch(`${hub.url}/hub/v1${handoff("j-secret")}`, {
    ...asMember(ann.pass, {
      "content-type": "application/json",
      "idempotency-key": "handoff-key-0001",
    }),
    method: "PUT",
    body: JSON.stringify({ to: benId, definition: definition(marker) }),
  });
  const got = await call(ben.pass, "GET", handoff("j-secret"));
  // Where it is meant to be: the one read by the member it moved to.
  expect(JSON.stringify(got.body)).toContain(marker);
  await call(ben.pass, "DELETE", handoff("j-secret"));

  const everything = await hub.database.execute(sql`
    select json_build_object(
      'events', (select json_agg(e) from hub_events e),
      'audit', (select json_agg(a) from hub_audit a),
      'idempotency', (select json_agg(i) from hub_idempotency i),
      'jobs', (select json_agg(j) from hub_jobs j),
      'handoffs', (select json_agg(h) from hub_job_handoffs h)
    ) as dump
  `);
  const dump = JSON.stringify(everything);
  expect(dump).toContain("job.handoff_put");
  expect(dump).not.toContain(marker);
  expect(JSON.stringify(hub.lines)).not.toContain(marker);
});
