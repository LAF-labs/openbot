import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { HUB_FLEET_PATH } from "../../shared/hub/protocol";
import { createHubApp } from "../src/app";
import { hashPass } from "../src/auth";
import { hubAudit, hubEvents, hubMembers } from "../src/db/schema";
import { hubFleetKeyFor, signHubFleetBody } from "../src/fleet";
import {
  newPass,
  putMember,
  sendFleet,
  startTestHub,
  type TestHub,
} from "./support/hub";

let hub: TestHub;
beforeAll(async () => {
  hub = await startTestHub();
});
afterAll(() => hub.stop());

const memberBody = (email: string, pass = newPass()) => ({
  event: "member.put",
  member: {
    email,
    role: "member",
    vmOrigin: `https://${email.split("@")[0]}.example`,
    vmKeyHash: hashPass(pass),
    state: "active",
  },
});

async function eventsAbout(id: string): Promise<number> {
  const rows = await hub.database
    .select({ seq: hubEvents.seq })
    .from(hubEvents)
    .where(eq(hubEvents.refId, id));
  return rows.length;
}

describe("the registry's signature", () => {
  test("a body signed with another key is refused and changes nothing", async () => {
    const response = await sendFleet(hub, memberBody("forged@example.com"), {
      key: randomBytes(32).toString("hex"),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_signature_refused",
    });
    const rows = await hub.database
      .select()
      .from(hubMembers)
      .where(eq(hubMembers.email, "forged@example.com"));
    expect(rows).toEqual([]);
  });

  test("the key is derived per hub: another hub's key for the same master is refused", () => {
    const master = randomBytes(24).toString("hex");
    const mine = hubFleetKeyFor(master, "https://a.hub.example");
    expect(hubFleetKeyFor(master, "https://a.hub.example/")).toBe(mine);
    expect(hubFleetKeyFor(master, "https://b.hub.example")).not.toBe(mine);
  });

  test("a body that names another hub is refused even when signed with this hub's key", async () => {
    const raw = JSON.stringify({
      ...memberBody("misdirected@example.com"),
      id: randomUUID(),
      at: new Date().toISOString(),
      hub: "https://other.hub.example",
    });
    const response = await fetch(`${hub.url}${HUB_FLEET_PATH}`, {
      method: "POST",
      headers: { "x-laf-signature": signHubFleetBody(raw, hub.fleetKey) },
      body: raw,
    });
    expect(response.status).toBe(401);
  });

  test("a body older than five minutes is refused; one inside them is taken", async () => {
    const send = (at: Date, email: string) => {
      const raw = JSON.stringify({
        ...memberBody(email),
        id: randomUUID(),
        at: at.toISOString(),
        hub: hub.origin,
      });
      return fetch(`${hub.url}${HUB_FLEET_PATH}`, {
        method: "POST",
        headers: { "x-laf-signature": signHubFleetBody(raw, hub.fleetKey) },
        body: raw,
      });
    };
    expect(
      (await send(new Date(Date.now() - 6 * 60_000), "stale@example.com"))
        .status,
    ).toBe(401);
    expect(
      (await send(new Date(Date.now() - 4 * 60_000), "fresh@example.com"))
        .status,
    ).toBe(200);
  });

  test.each([
    ["role", { role: "boss" }],
    ["vmKeyHash", { vmKeyHash: "not-a-hash" }],
    ["vmOrigin", { vmOrigin: "ftp://x" }],
    ["email", { email: "no-at-sign" }],
  ])("a member with a bad %s is a 400 naming it", async (field, patch) => {
    const body = memberBody(`bad-${field.toLowerCase()}@example.com`);
    const response = await sendFleet(hub, {
      ...body,
      member: { ...body.member, ...patch },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:request_invalid",
      field: `member.${field}`,
    });
  });
});

describe("the registry's writes", () => {
  test("the same id sent twice is one member and one event, answered the same both times", async () => {
    const id = randomUUID();
    const body = memberBody("twice@example.com");
    const first = await sendFleet(hub, body, { id });
    const second = await sendFleet(hub, body, { id });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const one = (await first.json()) as { member: { id: string }; seq: number };
    expect(await second.json()).toEqual(one);
    expect(await eventsAbout(one.member.id)).toBe(1);
  });

  test("two copies racing each other still make one write", async () => {
    const id = randomUUID();
    const body = memberBody("racing@example.com");
    const answers = await Promise.all([
      sendFleet(hub, body, { id }),
      sendFleet(hub, body, { id }),
      sendFleet(hub, body, { id }),
    ]);
    const bodies = await Promise.all(answers.map((answer) => answer.json()));
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    const memberId = (bodies[0] as { member: { id: string } }).member.id;
    expect(await eventsAbout(memberId)).toBe(1);
  });

  test("a new id with nothing changed writes no event", async () => {
    const pass = newPass();
    const member = {
      email: "steady@example.com",
      vmOrigin: "https://steady.example",
      pass,
    };
    const { id } = await putMember(hub, member);
    await putMember(hub, member);
    expect(await eventsAbout(id)).toBe(1);
  });

  test("a VM or a pass already another member's is a conflict, not a takeover", async () => {
    const owner = {
      email: "first@example.com",
      vmOrigin: "https://shared.example",
      pass: newPass(),
    };
    await putMember(hub, owner);
    const sameVm = await sendFleet(hub, {
      ...memberBody("second@example.com"),
      member: {
        ...memberBody("second@example.com").member,
        vmOrigin: "https://shared.example",
      },
    });
    expect(sameVm.status).toBe(409);
    const samePass = await sendFleet(hub, {
      ...memberBody("third@example.com", owner.pass),
    });
    expect(samePass.status).toBe(409);
    const [row] = await hub.database
      .select({ vmOrigin: hubMembers.vmOrigin })
      .from(hubMembers)
      .where(eq(hubMembers.email, owner.email));
    expect(row?.vmOrigin).toBe("https://shared.example");

    // A pass still inside another member's rotation grace is theirs too: no constraint holds the
    // previous hash, so only the hub's own check refuses it.
    await putMember(hub, { ...owner, pass: newPass() });
    const theirOldPass = await sendFleet(
      hub,
      memberBody("fourth@example.com", owner.pass),
    );
    expect(theirOldPass.status).toBe(409);
    expect(await theirOldPass.json()).toEqual({
      ok: false,
      code: "laf:hub_conflict",
    });
  });

  test("leaving someone the hub never had is a 404", async () => {
    const body = memberBody("never@example.com");
    const response = await sendFleet(hub, {
      ...body,
      member: { ...body.member, state: "left" },
    });
    expect(response.status).toBe(404);
  });

  test("the trail says what the registry did, and holds no hash", async () => {
    const pass = newPass();
    const { id } = await putMember(hub, {
      email: "trail@example.com",
      vmOrigin: "https://trail.example",
      pass,
    });
    await putMember(hub, {
      email: "trail@example.com",
      vmOrigin: "https://trail.example",
      pass: newPass(),
    });
    const rows = await hub.database
      .select()
      .from(hubAudit)
      .where(eq(hubAudit.target, id))
      .orderBy(hubAudit.id);
    expect(rows.map((row) => row.action)).toEqual([
      "member.joined",
      "pass.rotated",
    ]);
    expect(rows.every((row) => row.member === "fleet")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(hashPass(pass));
  });

  test("without a key configured the door answers 503, not 401", async () => {
    const { app } = createHubApp({
      database: hub.database,
      log: { svc: "hub", info() {}, warn() {}, error() {} },
      publicOrigin: hub.origin,
      fleetSecret: undefined,
      privateIp: null,
    });
    const response = await app.request(HUB_FLEET_PATH, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:hub_fleet_unset",
    });
  });

  test("workspace.put keeps one row however often it is sent", async () => {
    await sendFleet(hub, {
      event: "workspace.put",
      workspace: { name: "One" },
    });
    await sendFleet(hub, {
      event: "workspace.put",
      workspace: { name: "Two", plan: "team" },
    });
    const rows = await hub.database.execute<{ name: string; n: string }>(
      sql`select name, count(*) over ()::text as n from hub_workspace`,
    );
    expect(rows.map((row) => [row.name, row.n])).toEqual([["Two", "1"]]);
  });
});
