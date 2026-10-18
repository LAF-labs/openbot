import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  HUB_VAULT_LEASE_MS,
  type HubVault,
  type HubVaultLease,
  type HubVaultLeaseAsk,
  type HubVaultPut,
} from "../../shared/hub/protocol";
import { createLogger } from "../../shared/log";
import * as sharedSeal from "../../shared/login-seal";
import * as serverSeal from "../../server/src/logins/crypto";
import { createHubApp } from "../src/app";
import { readHubConfig } from "../src/config";
import {
  hubAudit,
  hubEvents,
  hubIdempotency,
  hubVaultDevices,
  hubVaultGrants,
  hubVaultLeases,
  hubVaultLogins,
} from "../src/db/schema";
import { HUB_VAULT_SEAL_OWNER } from "../src/vault";
import {
  asMember,
  newPass,
  putMember,
  sendFleet,
  startTestHub,
  type TestHub,
} from "./support/hub";

/**
 * Made up for this file and for nothing else: what a login's values are while a test runs. Long
 * and odd enough that finding either anywhere is finding it, not a coincidence.
 */
const USERNAME = "hv-made-up-user-4b1f@example.test";
const PASSWORD = "Hv-made-up-pw-91c2-zq7!";
const SITE = "https://wing.example.test";

const vaultKey = randomBytes(32).toString("hex");
let offsetMs = 0;
let hub: TestHub;
const ids: Record<"admin" | "a" | "b" | "c", string> = {
  admin: "",
  a: "",
  b: "",
  c: "",
};
const passes = {
  admin: newPass(),
  a: newPass(),
  b: newPass(),
  c: newPass(),
};

beforeAll(async () => {
  hub = await startTestHub({
    vaultKey,
    now: () => new Date(Date.now() + offsetMs),
  });
  for (const [who, role] of [
    ["admin", "admin"],
    ["a", "member"],
    ["b", "member"],
    ["c", "member"],
  ] as const) {
    ids[who] = (
      await putMember(hub, {
        email: `vault-${who}@example.com`,
        role,
        vmOrigin: `https://vault-${who}.example`,
        pass: passes[who],
      })
    ).id;
  }
});
afterAll(() => hub.stop());

type Who = keyof typeof passes;

async function call(
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init = asMember(passes[who], { "content-type": "application/json" });
  const response = await fetch(`${hub.url}/hub/v1/vault${path}`, {
    method,
    ...init,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function store(
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const body: HubVaultPut = {
    label: `Wing ${id}`,
    site: "wing",
    origins: [SITE],
    username: USERNAME,
    password: PASSWORD,
    ...extra,
  };
  const answer = await call("admin", "PUT", `/${id}`, body);
  expect(answer).toEqual({ status: 200, body: { ok: true, id } });
}

async function grant(id: string, members: Who[]): Promise<void> {
  const answer = await call("admin", "PUT", `/${id}/grants`, {
    members: members.map((who) => ids[who]),
  });
  expect(answer.status).toBe(200);
}

async function lease(who: Who, id: string) {
  const ask: HubVaultLeaseAsk = { origin: SITE, runId: `run-${who}` };
  return call(who, "POST", `/${id}/lease`, ask);
}

const leaseOf = (answer: { body: Record<string, unknown> }) =>
  (answer.body as HubVaultLease).lease;

describe("storing and granting", () => {
  test("only an admin stores a login, and the row holds seals, not values", async () => {
    const refused = await call("a", "PUT", "/store-1", {
      label: "Wing",
      origins: [SITE],
      username: USERNAME,
      password: PASSWORD,
    });
    expect(refused).toEqual({
      status: 403,
      body: { ok: false, code: "laf:hub_forbidden" },
    });
    await store("store-1");
    const [row] = await hub.database
      .select()
      .from(hubVaultLogins)
      .where(eq(hubVaultLogins.id, "store-1"));
    expect(row?.origins).toEqual([SITE]);
    expect(row?.sealedPassword).toStartWith("lv1.");
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    expect(JSON.stringify(row)).not.toContain(USERNAME);
  });

  test("a new login without values is refused, a change without them keeps them", async () => {
    const bare = await call("admin", "PUT", "/store-2", {
      label: "Wing",
      origins: [SITE],
    });
    expect(bare.body).toEqual({
      ok: false,
      code: "laf:request_invalid",
      field: "password",
    });
    await store("store-3");
    const renamed = await call("admin", "PUT", "/store-3", {
      label: "Wing renamed",
      origins: [SITE],
    });
    expect(renamed.status).toBe(200);
    await grant("store-3", ["a"]);
    const opened = await call("a", "POST", "/store-3/open", {
      lease: leaseOf(await lease("a", "store-3")),
    });
    expect(opened.body).toEqual({
      ok: true,
      username: USERNAME,
      password: PASSWORD,
    });
  });

  test("the list says who may use what and never a value", async () => {
    await store("list-1");
    await grant("list-1", ["a", "c"]);
    const forA = await call("a", "GET", "");
    const forB = await call("b", "GET", "");
    const rowOf = (answer: { body: Record<string, unknown> }) =>
      (answer.body as HubVault).logins.find((login) => login.id === "list-1");
    expect(rowOf(forA)).toEqual({
      id: "list-1",
      label: "Wing list-1",
      site: "wing",
      origins: [SITE],
      canUse: true,
      concurrent: false,
      verifiedVms: 0,
      totalVms: 2,
    });
    expect(rowOf(forB)?.canUse).toBe(false);
    for (const answer of [forA, forB]) {
      expect(JSON.stringify(answer)).not.toContain(PASSWORD);
      expect(JSON.stringify(answer)).not.toContain(USERNAME);
    }
  });
});

describe("leasing and opening", () => {
  test("a member without a grant can neither lease nor open", async () => {
    await store("grant-1");
    await grant("grant-1", ["a"]);
    const held = await lease("a", "grant-1");
    expect(held.status).toBe(200);
    expect(await lease("b", "grant-1")).toEqual({
      status: 403,
      body: { ok: false, code: "laf:hub_forbidden" },
    });
    // Even holding a lease that is good for somebody else.
    const stolen = await call("b", "POST", "/grant-1/open", {
      lease: leaseOf(held),
    });
    expect(stolen.status).toBe(403);
    expect(JSON.stringify(stolen.body)).not.toContain(PASSWORD);
  });

  test("a lease opens once; the second open is refused", async () => {
    await store("once-1");
    await grant("once-1", ["a"]);
    const held = await lease("a", "once-1");
    const first = await call("a", "POST", "/once-1/open", {
      lease: leaseOf(held),
    });
    expect(first.body).toEqual({
      ok: true,
      username: USERNAME,
      password: PASSWORD,
    });
    const second = await call("a", "POST", "/once-1/open", {
      lease: leaseOf(held),
    });
    expect(second).toEqual({
      status: 409,
      body: { ok: false, code: "laf:vault_lease_invalid" },
    });
  });

  test("two VMs racing for one login: one holds it, the other is told who and until when", async () => {
    await store("race-1");
    await grant("race-1", ["a", "c"]);
    // Rounds, because one pair of requests can happen to arrive one after the other; each round
    // the winner lets go, so both are asking for a free login every time.
    for (let round = 0; round < 8; round += 1) {
      const [forA, forC] = await Promise.all([
        lease("a", "race-1"),
        lease("c", "race-1"),
      ]);
      expect([forA.status, forC.status].sort()).toEqual([200, 409]);
      const [winner, loser, winnerId, winnerWho] =
        forA.status === 200
          ? ([forA, forC, ids.a, "a"] as const)
          : ([forC, forA, ids.c, "c"] as const);
      expect(loser.body).toEqual({
        ok: false,
        code: "laf:vault_busy",
        busy: {
          member: winnerId,
          until: (winner.body as HubVaultLease).until,
        },
      });
      const holders = await hub.database
        .select()
        .from(hubVaultLeases)
        .where(eq(hubVaultLeases.loginId, "race-1"));
      expect(holders.map((row) => row.memberId)).toEqual([winnerId]);
      await call(winnerWho, "POST", "/race-1/release", {
        lease: leaseOf(winner),
      });
    }
  });

  test("a released login is free for the next VM", async () => {
    await store("release-1");
    await grant("release-1", ["a", "c"]);
    const held = await lease("a", "release-1");
    expect((await lease("c", "release-1")).status).toBe(409);
    expect(
      await call("a", "POST", "/release-1/release", { lease: leaseOf(held) }),
    ).toEqual({ status: 200, body: { ok: true } });
    expect((await lease("c", "release-1")).status).toBe(200);
  });

  test("an expired lease cannot open, and no longer holds the login", async () => {
    await store("expire-1");
    await grant("expire-1", ["a", "c"]);
    const held = await lease("a", "expire-1");
    offsetMs = HUB_VAULT_LEASE_MS + 1_000;
    try {
      const late = await call("a", "POST", "/expire-1/open", {
        lease: leaseOf(held),
      });
      expect(late).toEqual({
        status: 409,
        body: { ok: false, code: "laf:vault_lease_invalid" },
      });
      expect((await lease("c", "expire-1")).status).toBe(200);
    } finally {
      offsetMs = 0;
    }
  });

  test("renewing moves a lease's end and keeps it the same lease", async () => {
    await store("renew-1");
    await grant("renew-1", ["a"]);
    const held = await lease("a", "renew-1");
    offsetMs = 60_000;
    try {
      const renewed = await call("a", "POST", "/renew-1/lease", {
        origin: SITE,
        lease: leaseOf(held),
      });
      expect(renewed.status).toBe(200);
      expect(leaseOf(renewed)).toBe(leaseOf(held));
      expect(
        Date.parse((renewed.body as HubVaultLease).until) -
          Date.parse((held.body as HubVaultLease).until),
      ).toBeGreaterThanOrEqual(59_000);
    } finally {
      offsetMs = 0;
    }
  });

  test("a concurrent login is never busy, and each lease still opens once", async () => {
    await store("shared-1", { concurrent: true });
    await grant("shared-1", ["a", "c"]);
    const [forA, forC] = await Promise.all([
      lease("a", "shared-1"),
      lease("c", "shared-1"),
    ]);
    expect([forA.status, forC.status]).toEqual([200, 200]);
    expect((forA.body as HubVaultLease).concurrent).toBe(true);
    for (const [who, held] of [
      ["a", forA],
      ["c", forC],
    ] as const) {
      const opened = await call(who, "POST", "/shared-1/open", {
        lease: leaseOf(held),
      });
      expect(opened.body).toMatchObject({ ok: true, password: PASSWORD });
    }
    const again = await call("a", "POST", "/shared-1/open", {
      lease: leaseOf(forA),
    });
    expect(again.status).toBe(409);
  });

  test("a lease is only for one of the login's origins", async () => {
    await store("origin-1");
    await grant("origin-1", ["a"]);
    const elsewhere = await call("a", "POST", "/origin-1/lease", {
      origin: "https://elsewhere.example.test",
    });
    expect(elsewhere).toEqual({
      status: 409,
      body: { ok: false, code: "laf:login_origin_mismatch" },
    });
    // The same origin spelled with a path and capitals is the same origin.
    const same = await call("a", "POST", "/origin-1/lease", {
      origin: "https://WING.example.test/login",
    });
    expect(same.status).toBe(200);
  });

  test("a grant taken away ends the lease it gave", async () => {
    await store("revoke-1");
    await grant("revoke-1", ["a"]);
    const held = await lease("a", "revoke-1");
    await grant("revoke-1", []);
    const opened = await call("a", "POST", "/revoke-1/open", {
      lease: leaseOf(held),
    });
    expect(opened.status).toBe(403);
    const left = await hub.database
      .select()
      .from(hubVaultLeases)
      .where(eq(hubVaultLeases.loginId, "revoke-1"));
    expect(left).toEqual([]);
  });

  test("a verified VM is counted, and only the caller's own VM can be named", async () => {
    await store("device-1");
    await grant("device-1", ["a", "c"]);
    const other = await call("a", "POST", "/device-1/verified", {
      vm: "https://vault-c.example",
    });
    expect(other.body).toEqual({
      ok: false,
      code: "laf:request_invalid",
      field: "vm",
    });
    expect(
      (
        await call("a", "POST", "/device-1/verified", {
          vm: "https://vault-a.example",
        })
      ).status,
    ).toBe(200);
    expect((await call("b", "POST", "/device-1/verified", {})).status).toBe(
      403,
    );
    const list = await call("c", "GET", "");
    const row = (list.body as HubVault).logins.find(
      (login) => login.id === "device-1",
    );
    expect(row).toMatchObject({ verifiedVms: 1, totalVms: 2 });
  });
});

describe("where a value never is", () => {
  test("after a store and an open, no log line, trail row, event, ledger row or list holds either value", async () => {
    await store("serial-1");
    await grant("serial-1", ["a"]);
    // A body that does not parse, with the password in it: answered, never logged.
    const broken = await fetch(`${hub.url}/hub/v1/vault/serial-1`, {
      method: "PUT",
      ...asMember(passes.admin, { "content-type": "application/json" }),
      body: `{"label":"x","password":"${PASSWORD}"`,
    });
    expect(broken.status).toBe(400);
    const held = await lease("a", "serial-1");
    const opened = await call("a", "POST", "/serial-1/open", {
      lease: leaseOf(held),
    });
    // The presence, so the absences below are about a value that was really handed out.
    expect(JSON.stringify(opened.body)).toContain(PASSWORD);
    expect(JSON.stringify(opened.body)).toContain(USERNAME);
    await call("a", "POST", "/serial-1/verified", {});

    const everything = JSON.stringify({
      lines: hub.lines,
      audit: await hub.database.select().from(hubAudit),
      events: await hub.database.select().from(hubEvents),
      idempotency: await hub.database.select().from(hubIdempotency),
      logins: await hub.database.select().from(hubVaultLogins),
      grants: await hub.database.select().from(hubVaultGrants),
      leases: await hub.database.select().from(hubVaultLeases),
      devices: await hub.database.select().from(hubVaultDevices),
      list: (await call("a", "GET", "")).body,
      sync: await (
        await fetch(`${hub.url}/hub/v1/sync?since=0`, asMember(passes.a))
      ).json(),
    });
    expect(everything).toContain("vault.opened");
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(USERNAME);
    // Nor the lease that opened it: the table keeps its hash.
    expect(everything).not.toContain(leaseOf(held));
  });

  test("the trail says who opened which login from which VM in which run, with ids only", async () => {
    await store("trail-1");
    await grant("trail-1", ["a"]);
    await call("a", "POST", "/trail-1/open", {
      lease: leaseOf(await lease("a", "trail-1")),
    });
    const rows = await hub.database
      .select()
      .from(hubAudit)
      .where(eq(hubAudit.target, "trail-1"))
      .orderBy(hubAudit.id);
    expect(
      rows.map((row) => [row.action, row.member, row.outcome, row.runId]),
    ).toEqual([
      ["vault.changed", ids.admin, "created", null],
      ["vault.changed", ids.admin, "granted", null],
      ["vault.leased", ids.a, "ok", "run-a"],
      ["vault.opened", ids.a, "ok", "run-a"],
    ]);
    expect(rows[3]?.vmOrigin).toBe("https://vault-a.example");
    expect(rows[3]?.payload).toEqual({ origin: SITE });
  });
});

describe("leaving", () => {
  test("the registry's answer names the origins the member had, and their grants go", async () => {
    const pass = newPass();
    const member = {
      email: "vault-leaver@example.com",
      vmOrigin: "https://vault-leaver.example",
      pass,
    };
    const { id } = await putMember(hub, member);
    await store("leave-1", { origins: [SITE, "https://other.example.test"] });
    await store("leave-2", { origins: ["https://third.example.test"] });
    await store("leave-3", { origins: ["https://never.example.test"] });
    await call("admin", "PUT", "/leave-1/grants", { members: [id] });
    await call("admin", "PUT", "/leave-2/grants", { members: [id] });

    const leave = (requestId?: string) =>
      sendFleet(
        hub,
        {
          event: "member.put",
          member: {
            email: member.email,
            role: "member",
            vmOrigin: member.vmOrigin,
            vmKeyHash: "0".repeat(64),
            state: "left",
          },
        },
        requestId ? { id: requestId } : {},
      );
    const answer = (await (await leave()).json()) as {
      vault: { origins: string[] };
    };
    expect(answer.vault.origins).toEqual([
      "https://other.example.test",
      "https://third.example.test",
      SITE,
    ]);
    const grants = await hub.database
      .select()
      .from(hubVaultGrants)
      .where(eq(hubVaultGrants.memberId, id));
    expect(grants).toEqual([]);
    // Asked again after the leaving, the answer is the same.
    const again = (await (await leave()).json()) as {
      vault: { origins: string[] };
    };
    expect(again.vault.origins).toEqual(answer.vault.origins);
  });

  test("an origin the member opened is in the answer after the admin moves the login off it", async () => {
    const member = {
      email: "vault-moved@example.com",
      vmOrigin: "https://vault-moved.example",
      pass: newPass(),
    };
    const { id } = await putMember(hub, member);
    await store("moved-1");
    await call("admin", "PUT", "/moved-1/grants", { members: [id] });
    const asked = await fetch(`${hub.url}/hub/v1/vault/moved-1/lease`, {
      method: "POST",
      ...asMember(member.pass, { "content-type": "application/json" }),
      body: JSON.stringify({ origin: SITE }),
    });
    const lease = ((await asked.json()) as HubVaultLease).lease;
    const opened = await fetch(`${hub.url}/hub/v1/vault/moved-1/open`, {
      method: "POST",
      ...asMember(member.pass, { "content-type": "application/json" }),
      body: JSON.stringify({ lease }),
    });
    expect(opened.status).toBe(200);
    // The site moved: the login is filled somewhere else now, and the cookies are still on SITE.
    await store("moved-1", { origins: ["https://moved.example.test"] });

    const answer = (await (await leaveAs(member)).json()) as {
      vault: { origins: string[] };
    };
    expect(answer.vault.origins).toEqual(["https://moved.example.test", SITE]);
  });

  test("a VM's verified devices go with its member, so the next member on that VM starts unverified", async () => {
    const vmOrigin = "https://vault-reused.example";
    const first = {
      email: "vault-first@example.com",
      vmOrigin,
      pass: newPass(),
    };
    const { id: firstId } = await putMember(hub, first);
    await store("reused-1");
    await call("admin", "PUT", "/reused-1/grants", { members: [firstId] });
    const verified = await fetch(`${hub.url}/hub/v1/vault/reused-1/verified`, {
      method: "POST",
      ...asMember(first.pass, { "content-type": "application/json" }),
      body: "{}",
    });
    expect(verified.status).toBe(200);
    const countOf = async () =>
      ((await call("admin", "GET", "")).body as HubVault).logins.find(
        (login) => login.id === "reused-1",
      );
    // The presence, so the absence after the leaving is about a row that was counted.
    expect(await countOf()).toMatchObject({ verifiedVms: 1, totalVms: 1 });

    expect((await leaveAs(first)).status).toBe(200);
    const second = {
      email: "vault-second@example.com",
      vmOrigin,
      pass: newPass(),
    };
    const { id: secondId } = await putMember(hub, second);
    await call("admin", "PUT", "/reused-1/grants", { members: [secondId] });
    expect(await countOf()).toMatchObject({ verifiedVms: 0, totalVms: 1 });
    const rows = await hub.database
      .select()
      .from(hubVaultDevices)
      .where(eq(hubVaultDevices.vmOrigin, vmOrigin));
    expect(rows).toEqual([]);
  });
});

/** The registry saying a member left, as laf-control will. */
function leaveAs(member: { email: string; vmOrigin: string }) {
  return sendFleet(hub, {
    event: "member.put",
    member: {
      email: member.email,
      role: "member",
      vmOrigin: member.vmOrigin,
      vmKeyHash: "0".repeat(64),
      state: "left",
    },
  });
}

describe("the key", () => {
  test("without it the vault answers a fact and the rest of the hub serves", async () => {
    const { app } = createHubApp({
      database: hub.database,
      log: createLogger("hub", () => {}),
      publicOrigin: hub.origin,
      fleetSecret: hub.fleetKey,
      privateIp: null,
    });
    const asA = asMember(passes.a);
    const vault = await app.request("/hub/v1/vault", asA);
    expect(vault.status).toBe(503);
    expect(await vault.json()).toEqual({
      ok: false,
      code: "laf:hub_vault_unset",
    });
    expect((await app.request("/hub/v1/health")).status).toBe(200);
    expect((await app.request("/hub/v1/me", asA)).status).toBe(200);
  });

  test("a hub started on another key answers a fact, logs no value, and leaves the lease unspent", async () => {
    await store("rekey-1");
    await grant("rekey-1", ["a"]);
    const held = await lease("a", "rekey-1");
    const lines: string[] = [];
    const { app } = createHubApp({
      database: hub.database,
      log: createLogger("hub", (_level, line) => lines.push(line)),
      publicOrigin: hub.origin,
      fleetSecret: hub.fleetKey,
      privateIp: null,
      vaultKey: randomBytes(32).toString("hex"),
    });
    const open = () =>
      app.request("/hub/v1/vault/rekey-1/open", {
        method: "POST",
        ...asMember(passes.a, { "content-type": "application/json" }),
        body: JSON.stringify({ lease: leaseOf(held) }),
      });
    const refused = await open();
    expect(refused.status).toBe(500);
    expect(await refused.json()).toEqual({
      ok: false,
      code: "laf:login_seal_unreadable",
    });
    expect(lines.join("\n")).toContain("vault_seal_unreadable");
    expect(lines.join("\n")).not.toContain(PASSWORD);
    // The right hub still opens it: the failed attempt rolled back with the lease unspent.
    const opened = await call("a", "POST", "/rekey-1/open", {
      lease: leaseOf(held),
    });
    expect(opened.body).toMatchObject({ ok: true, password: PASSWORD });
  });

  test("HUB_KEY_ENCRYPTION_KEY is read as 64 hex, and anything else is refused at boot", () => {
    const env = { DATABASE_URL: "postgres://x@localhost/x" };
    expect(readHubConfig(env).vaultKey).toBeUndefined();
    expect(
      readHubConfig({ ...env, HUB_KEY_ENCRYPTION_KEY: vaultKey }).vaultKey,
    ).toBe(vaultKey);
    expect(() =>
      readHubConfig({ ...env, HUB_KEY_ENCRYPTION_KEY: "not-a-key" }),
    ).toThrow("HUB_KEY_ENCRYPTION_KEY is not 64 hex characters");
  });

  test("the hub seals with the server's own envelope: the same functions, and a hub row opens with them", async () => {
    expect(serverSeal.sealLogin).toBe(sharedSeal.sealLogin);
    expect(serverSeal.openLogin).toBe(sharedSeal.openLogin);
    expect(serverSeal.kekIdOf).toBe(sharedSeal.kekIdOf);
    expect(serverSeal.LoginSealError).toBe(sharedSeal.LoginSealError);

    await store("seal-1");
    const [row] = await hub.database
      .select()
      .from(hubVaultLogins)
      .where(eq(hubVaultLogins.id, "seal-1"));
    if (!row) throw new Error("no row");
    const encoded = Buffer.from(vaultKey, "hex").toString("base64");
    expect(row.kekId).toBe(await serverSeal.kekIdOf(encoded));
    expect(
      await serverSeal.openLogin(
        encoded,
        { id: "seal-1", userId: HUB_VAULT_SEAL_OWNER },
        row,
      ),
    ).toEqual({ username: USERNAME, password: PASSWORD });
    // Bound to its row: the same seals read as another login's do not open.
    await expect(
      serverSeal.openLogin(
        encoded,
        { id: "seal-2", userId: HUB_VAULT_SEAL_OWNER },
        row,
      ),
    ).rejects.toBeInstanceOf(serverSeal.LoginSealError);
  });
});
