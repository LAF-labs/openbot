import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HUB_PROTOCOL } from "../../shared/hub/protocol";
import { hashPass, memberForPass } from "../src/auth";
import { hubMembers } from "../src/db/schema";
import {
  asMember,
  newPass,
  putMember,
  sendFleet,
  startTestHub,
  type TestHub,
} from "./support/hub";

let hub: TestHub;
const alice = {
  email: "alice@example.com",
  vmOrigin: "https://alice.example",
  pass: newPass(),
};
let aliceId = "";

beforeAll(async () => {
  hub = await startTestHub();
  aliceId = (await putMember(hub, { ...alice, role: "admin", name: "Alice" }))
    .id;
  await sendFleet(hub, {
    event: "workspace.put",
    workspace: { name: "Sweet Shop" },
  });
});
afterAll(() => hub.stop());

describe("a member's pass", () => {
  test("opens /me as that member, with the workspace and the protocol", async () => {
    const response = await fetch(`${hub.url}/hub/v1/me`, asMember(alice.pass));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      member: { id: aliceId, role: "admin", name: "Alice" },
      workspace: { name: "Sweet Shop" },
      protocol: HUB_PROTOCOL,
      privateIp: "10.20.0.5",
    });
    expect(body.seq).toBeGreaterThan(0);
  });

  test("a wrong pass is one line of 401, and nothing is logged with it", async () => {
    const wrong = newPass();
    const before = hub.lines.length;
    // The hub runs in this process, so anything it prints passes through these.
    const printed: unknown[][] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((name) =>
      spyOn(console, name).mockImplementation((...args: unknown[]) => {
        printed.push(args);
      }),
    );
    try {
      const response = await fetch(`${hub.url}/hub/v1/me`, asMember(wrong));
      expect(response.status).toBe(401);
      const text = await response.text();
      expect(text).toBe('{"ok":false,"code":"laf:hub_pass_refused"}');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(hub.lines.length).toBe(before);
    expect(printed).toEqual([]);
  });

  test.each([
    ["no header", {}],
    ["not bearer", { authorization: `Basic ${alice.pass}` }],
    [
      "the hash instead of the pass",
      { authorization: `Bearer ${hashPass(alice.pass)}` },
    ],
    [
      "a pass that is not 64 hex",
      { authorization: `Bearer ${alice.pass.slice(1)}` },
    ],
  ])("%s is refused", async (_name, headers) => {
    const response = await fetch(`${hub.url}/hub/v1/me`, { headers });
    expect(response.status).toBe(401);
  });

  test("used from another VM than the row names, the pass is refused", async () => {
    const elsewhere = await fetch(
      `${hub.url}/hub/v1/me`,
      asMember(alice.pass, { "x-laf-vm": "https://bob.example" }),
    );
    expect(elsewhere.status).toBe(401);
    const home = await fetch(
      `${hub.url}/hub/v1/me`,
      asMember(alice.pass, { "x-laf-vm": "https://alice.example/" }),
    );
    expect(home.status).toBe(200);
  });

  test("a member who left is refused, and coming back with a new pass opens again", async () => {
    const carol = {
      email: "carol@example.com",
      vmOrigin: "https://carol.example",
      pass: newPass(),
    };
    await putMember(hub, carol);
    expect(
      (await fetch(`${hub.url}/hub/v1/me`, asMember(carol.pass))).status,
    ).toBe(200);

    await putMember(hub, { ...carol, state: "left" });
    expect(
      (await fetch(`${hub.url}/hub/v1/me`, asMember(carol.pass))).status,
    ).toBe(401);
    const [row] = await hub.database
      .select()
      .from(hubMembers)
      .where(eq(hubMembers.email, carol.email));
    expect(row).toMatchObject({
      state: "left",
      vmKeyHash: null,
      prevKeyHash: null,
    });

    const fresh = newPass();
    await putMember(hub, { ...carol, pass: fresh });
    expect((await fetch(`${hub.url}/hub/v1/me`, asMember(fresh))).status).toBe(
      200,
    );
    // The pass from before leaving is not given a rotation's grace.
    expect(
      (await fetch(`${hub.url}/hub/v1/me`, asMember(carol.pass))).status,
    ).toBe(401);
  });

  test("a rotated pass keeps working for ten minutes, and not after", async () => {
    const dave = {
      email: "dave@example.com",
      vmOrigin: "https://dave.example",
      pass: newPass(),
    };
    const { id } = await putMember(hub, dave);
    const next = newPass();
    await putMember(hub, { ...dave, pass: next });

    const now = new Date();
    expect((await memberForPass(hub.database, next, now))?.id).toBe(id);
    expect((await memberForPass(hub.database, dave.pass, now))?.id).toBe(id);
    const later = new Date(now.getTime() + 11 * 60 * 1000);
    expect(await memberForPass(hub.database, dave.pass, later)).toBeNull();
    expect((await memberForPass(hub.database, next, later))?.id).toBe(id);
  });
});

describe("what the hub answers without a pass", () => {
  test("health says the database answers", async () => {
    const response = await fetch(`${hub.url}/hub/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { db: "ok" },
    });
  });

  test("metrics are counts", async () => {
    const body = (await (await fetch(`${hub.url}/hub/v1/metrics`)).json()) as {
      members: { active: number };
      events: { head: number };
    };
    expect(body.members.active).toBeGreaterThanOrEqual(1);
    expect(body.events.head).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("@");
  });
});
