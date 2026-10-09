/**
 * 로그인 보관함, AGAINST THE REAL TABLE (`docs/laf/redesign-2026-10.md` §6, piece 2-3).
 *
 * What a person saves for their Bot's browser to sign in with is sealed before it is written, is
 * read back by nobody, is its owner's row by row, and is gone the moment they delete it. Held
 * here against Postgres because every one of those is a claim about what is IN THE DATABASE —
 * and the way CLAUDE.md says a secret is tested: plant one, serialise everything, look for it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAccountExport } from "../src/account/export";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { lafSavedLogins, users } from "../src/db/schema";
import { LoginSealError } from "../src/logins/crypto";
import { createLoginRoutes } from "../src/logins/routes";
import { createLoginVault, SAVED_LOGINS_MAX } from "../src/logins/store";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const tag = randomUUID().slice(0, 8);
const KEY = Buffer.alloc(32, 21).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 22).toString("base64");

/** Two values no other test writes, so finding either anywhere is this file's doing. */
const USERNAME = `sajang-CANARY-${tag}@example.test`;
// A space at each end: a password is sealed as it was typed, and one that begins with a space
// begins with a space.
const PASSWORD = ` hunter2-CANARY-${tag} 한글 🔑 `;

const rows: AuditEventInput[] = [];
const auditStore: AuditStore = {
  insert: async (event) => void rows.push(event),
};
const vault = createLoginVault({ database, auditStore, keyEncryptionKey: KEY });

const owner = `login-owner-${tag}`;
const other = `login-other-${tag}`;

/** The doors, with the session stood in for by a header: who is asking. */
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", {
    id: context.req.header("x-test-user") ?? owner,
    role: "user",
  } as AppVariables["actor"]);
  await next();
};
const app = new Hono<{ Variables: AppVariables }>().route(
  "/api/logins",
  createLoginRoutes(vault, requireUser),
);
const call = (
  method: string,
  path: string,
  body?: unknown,
  as: string = owner,
) =>
  app.request(`/api/logins${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": as },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const NAVER = {
  label: "  네이버\n(가게)  ",
  site: "naver-smartstore",
  origins: ["nid.naver.com", "https://SELL.smartstore.naver.com/#/home"],
  username: USERNAME,
  password: PASSWORD,
};

/** The row as the database holds it, whole, as text: what a dump or a backup would carry. */
const stored = async (userId: string) =>
  (
    (await database.execute(
      sql`select coalesce(json_agg(row_to_json(l))::text, '[]') as held from laf_saved_logins l where l.user_id = ${userId}`,
    )) as unknown as Array<{ held: string }>
  )[0]?.held ?? "[]";

const holdsAValue = (text: string) =>
  text.includes(USERNAME) ||
  text.includes(PASSWORD) ||
  text.includes("hunter2-CANARY") ||
  text.includes("sajang-CANARY");

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@laf.test`, name: owner },
    { id: other, email: `${other}@laf.test`, name: other },
  ]);
});

afterAll(async () => {
  // The rows go with their owners (the foreign key), which is also what this leaves behind: none.
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

describe("a login a person saves", () => {
  test("is sealed before it is written: the row, every answer, the trail and the export hold neither value", async () => {
    const saved = await call("POST", "", NAVER);
    expect(saved.status).toBe(201);
    const answered = await saved.text();
    const login = JSON.parse(answered) as { id: string; origins: string[] };
    // What comes back is what it is called and where it may go, each origin written one way.
    expect(JSON.parse(answered)).toMatchObject({
      label: "네이버 (가게)",
      site: "naver-smartstore",
      origins: ["https://nid.naver.com", "https://sell.smartstore.naver.com"],
      lastUsedAt: null,
    });
    expect(Object.keys(JSON.parse(answered)).sort()).toEqual([
      "createdAt",
      "id",
      "label",
      "lastUsedAt",
      "origins",
      "site",
      "updatedAt",
    ]);

    const row = await stored(owner);
    const listed = await (await call("GET", "")).text();
    const exported = await new Response(
      createAccountExport(database).stream(owner),
    ).text();
    for (const [where, text] of [
      ["the answer to the save", answered],
      ["the row in the database", row],
      ["the list", listed],
      ["the trail", JSON.stringify(rows)],
      ["the export", exported],
    ] as const) {
      expect([where, holdsAValue(text)]).toEqual([where, false]);
    }
    // The row is there, sealed in this vault's own format, and names the deployment's key by a
    // fingerprint that is not the key.
    expect(row).toContain(login.id);
    expect(row.match(/lv1\./g)).toHaveLength(3);
    expect(row).not.toContain(KEY);
    // The list and the export say WHICH logins — and carry no seal either: a sealed value is
    // still not something to hand out.
    expect(JSON.parse(listed)).toMatchObject({
      logins: [{ id: login.id, label: "네이버 (가게)" }],
      max: SAVED_LOGINS_MAX,
    });
    const document = JSON.parse(exported) as {
      savedLogins: Array<Record<string, unknown>>;
    };
    expect(document.savedLogins).toMatchObject([
      {
        id: login.id,
        label: "네이버 (가게)",
        site: "naver-smartstore",
        origins: login.origins,
      },
    ]);
    expect(Object.keys(document.savedLogins[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "label",
      "lastUsedAt",
      "origins",
      "site",
      "updatedAt",
    ]);
    for (const text of [answered, listed, exported]) {
      expect(text).not.toContain("lv1.");
    }
    // One row of the trail, under the person, saying which login and where it may go.
    expect(rows.map((one) => [one.eventType, one.actorUserId])).toEqual([
      ["account.login_saved", owner],
    ]);
    // The row is about the login, by the login's own id; it says for where. Not what the person
    // called it — the trail outlives the account, and those are their words — and not their id
    // as its target, which nothing could re-point when they leave.
    expect([rows[0]?.targetType, rows[0]?.targetId]).toEqual([
      "saved_login",
      login.id,
    ]);
    expect(rows[0]?.payload).toEqual({
      site: "naver-smartstore",
      origins: login.origins,
    });
    expect(JSON.stringify(rows)).not.toContain("네이버 (가게)");
    expect(
      JSON.stringify(rows.map((one) => [one.targetId, one.payload])),
    ).not.toContain(owner);

    // And the values are there, for the one caller that puts them into a page — exactly as typed.
    const opened = await vault.open(owner, login.id);
    expect(opened).toMatchObject({ username: USERNAME, password: PASSWORD });
    // Under another deployment's key it does not open, and says nothing of why.
    const elsewhere = createLoginVault({
      database,
      auditStore,
      keyEncryptionKey: OTHER_KEY,
    });
    expect(
      await elsewhere.open(owner, login.id).catch((error: unknown) => error),
    ).toBeInstanceOf(LoginSealError);
  });

  test("is its owner's and nobody else's: another person lists none, changes none, deletes none and opens none", async () => {
    const [mine] = await vault.list(owner);
    if (!mine) throw new Error("the owner has no saved login");
    const before = await stored(owner);

    expect(await (await call("GET", "", undefined, other)).json()).toEqual({
      logins: [],
      max: SAVED_LOGINS_MAX,
    });
    const changed = await call(
      "PATCH",
      `/${mine.id}`,
      { label: "내 것", password: "theirs-now" },
      other,
    );
    expect([changed.status, await changed.json()]).toEqual([
      404,
      { error: "laf:login_not_found", code: "laf:login_not_found" },
    ]);
    expect((await call("DELETE", `/${mine.id}`, undefined, other)).status).toBe(
      404,
    );
    expect(await vault.open(other, mine.id)).toBeNull();
    // Untouched: the same bytes as before anybody else asked.
    expect(await stored(owner)).toBe(before);
    expect(await stored(other)).toBe("[]");
  });

  test("gets a new key when a value changes, and keeps its key when only its name does", async () => {
    const [mine] = await vault.list(owner);
    if (!mine) throw new Error("the owner has no saved login");
    const sealedOf = async () => {
      const [row] = await database
        .select()
        .from(lafSavedLogins)
        .where(eq(lafSavedLogins.id, mine.id));
      if (!row) throw new Error("the row is gone");
      return [row.wrappedKey, row.sealedUsername, row.sealedPassword];
    };
    const first = await sealedOf();
    rows.length = 0;

    // Renamed, and told to go one more place: nothing sealed is touched.
    const renamed = await call("PATCH", `/${mine.id}`, {
      label: "네이버",
      origins: [...mine.origins, "https://www.naver.com/"],
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      label: "네이버",
      origins: [...mine.origins, "https://www.naver.com"],
    });
    expect(await sealedOf()).toEqual(first);

    // A new password: both values are sealed again under a key that has sealed nothing before.
    const NEW = `rotated-CANARY-${tag}`;
    const replaced = await call("PATCH", `/${mine.id}`, { password: NEW });
    expect(replaced.status).toBe(200);
    expect(await replaced.text()).not.toContain(NEW);
    const second = await sealedOf();
    for (const [index, sealed] of second.entries()) {
      expect(sealed).not.toBe(first[index]);
    }
    // The name the row already held came with it.
    expect(await vault.open(owner, mine.id)).toMatchObject({
      username: USERNAME,
      password: NEW,
    });
    // The trail says that the values changed, and not what to.
    expect(
      rows.map((one) => [
        one.eventType,
        (one.payload as { values?: string }).values,
      ]),
    ).toEqual([
      ["account.login_replaced", "kept"],
      ["account.login_replaced", "replaced"],
    ]);
    expect(JSON.stringify(rows)).not.toContain(NEW);
    expect(await stored(owner)).not.toContain(NEW);

    // A change that changes nothing writes nothing: the row is answered as it stands, its seals
    // and its time untouched, and the trail is not told of a change that was not.
    const [held] = await database
      .select()
      .from(lafSavedLogins)
      .where(eq(lafSavedLogins.id, mine.id));
    rows.length = 0;
    const nothing = await call("PATCH", `/${mine.id}`, {});
    expect(nothing.status).toBe(200);
    expect(await nothing.json()).toMatchObject({
      id: mine.id,
      label: "네이버",
    });
    expect(rows).toEqual([]);
    expect(
      await database
        .select()
        .from(lafSavedLogins)
        .where(eq(lafSavedLogins.id, mine.id)),
    ).toEqual(held ? [held] : []);
  });

  test("is not saved at all when it is not one: no HTTPS origin, no name, no value, a site nobody knows", async () => {
    const before = await stored(owner);
    const nine = Array.from({ length: 9 }, (_, n) => `https://s${n}.example`);
    for (const [body, code, field] of [
      [
        { ...NAVER, origins: ["http://nid.naver.com"] },
        "laf:login_origin_refused",
        "origins",
      ],
      // One good origin does not carry one that is not: the whole save is refused.
      [
        { ...NAVER, origins: ["nid.naver.com", "http://naver.com"] },
        "laf:login_origin_refused",
        "origins",
      ],
      [
        { ...NAVER, origins: ["http://127.0.0.1:4395"] },
        "laf:login_origin_refused",
        "origins",
      ],
      [{ ...NAVER, origins: [] }, "laf:login_origin_refused", "origins"],
      [
        { ...NAVER, origins: "nid.naver.com" },
        "laf:login_origin_refused",
        "origins",
      ],
      [{ ...NAVER, origins: nine }, "laf:login_origin_refused", "origins"],
      [{ ...NAVER, label: "   " }, "laf:login_label_required", "label"],
      [{ ...NAVER, username: "" }, "laf:login_value_required", "username"],
      [
        { ...NAVER, password: undefined },
        "laf:login_value_required",
        "password",
      ],
      [
        { ...NAVER, password: "x".repeat(1025) },
        "laf:login_value_too_long",
        "password",
      ],
      [{ ...NAVER, site: "not-a-site" }, "laf:login_site_unknown", "site"],
      ["not an object", "laf:login_label_required", "label"],
    ] as const) {
      const refused = await call("POST", "", body);
      const said = await refused.text();
      expect([refused.status, JSON.parse(said)]).toEqual([
        400,
        { error: code, code, field },
      ]);
      // A refusal does not say back what it refused.
      expect(holdsAValue(said)).toBe(false);
    }
    expect(await stored(owner)).toBe(before);
    // A change is held to the same: a login is not edited into one that is not.
    const [mine] = await vault.list(owner);
    const edited = await call("PATCH", `/${mine?.id}`, {
      origins: ["http://nid.naver.com"],
    });
    expect(edited.status).toBe(400);
    expect(await stored(owner)).toBe(before);
  });

  test("is gone the moment it is deleted, and the trail says which one went", async () => {
    const [mine] = await vault.list(owner);
    if (!mine) throw new Error("the owner has no saved login");
    rows.length = 0;

    const gone = await call("DELETE", `/${mine.id}`);
    expect([gone.status, await gone.text()]).toEqual([204, ""]);
    expect(await stored(owner)).toBe("[]");
    expect(await vault.open(owner, mine.id)).toBeNull();
    expect(rows.map((one) => one.eventType)).toEqual(["account.login_removed"]);
    expect([rows[0]?.targetId, rows[0]?.payload]).toEqual([
      mine.id,
      { site: "naver-smartstore", origins: mine.origins },
    ]);
    // Deleting what is not there is said as that, and writes nothing.
    expect((await call("DELETE", `/${mine.id}`)).status).toBe(404);
    expect(rows).toHaveLength(1);
  });

  test("stops at what one person may save, and says full rather than failing", async () => {
    await database.insert(lafSavedLogins).values(
      Array.from({ length: SAVED_LOGINS_MAX }, (_, n) => ({
        id: `login-full-${tag}-${n}`,
        userId: other,
        label: `자리 ${n}`,
        origins: ["https://full.example"],
        wrappedKey: "lv1.AAAA.AAAA",
        kekId: "0000000000000000",
        sealedUsername: "lv1.AAAA.AAAA",
        sealedPassword: "lv1.AAAA.AAAA",
      })),
    );
    const full = await call("POST", "", NAVER, other);
    expect([full.status, await full.json()]).toEqual([
      409,
      { error: "laf:logins_full", code: "laf:logins_full" },
    ]);
    // The other person's being full is not this one's.
    const mine = await call("POST", "", NAVER);
    expect(mine.status).toBe(201);
    // A row that is not this vault's seal does not open, and does not say what it holds.
    const sealedElsewhere = `login-full-${tag}-0`;
    expect(
      await vault.open(other, sealedElsewhere).catch((error: unknown) => error),
    ).toBeInstanceOf(LoginSealError);

    /*
     * AND IT CAN BE PUT RIGHT. A deployment whose key was changed holds rows it cannot open. One
     * value alone cannot be saved onto such a row — the other is the one that does not open — and
     * that is said as a fact. Both, typed again, are sealed under the key there is now, and the
     * old seal is never opened to do it.
     */
    const half = await call(
      "PATCH",
      `/${sealedElsewhere}`,
      { password: "half-CANARY" },
      other,
    );
    expect([half.status, await half.json()]).toEqual([
      409,
      {
        error: "laf:login_seal_unreadable",
        code: "laf:login_seal_unreadable",
      },
    ]);
    const both = await call(
      "PATCH",
      `/${sealedElsewhere}`,
      { username: USERNAME, password: PASSWORD },
      other,
    );
    expect(both.status).toBe(200);
    expect(await vault.open(other, sealedElsewhere)).toMatchObject({
      username: USERNAME,
      password: PASSWORD,
    });
  });

  test("is saved, changed and deleted even when the trail cannot be written: the row's loss is not the act's", async () => {
    const down = createLoginVault({
      database,
      auditStore: {
        insert: async () => {
          throw new Error("the audit store is unreachable");
        },
      },
      keyEncryptionKey: KEY,
    });
    const saved = await down.save(owner, { ...NAVER, label: "기록 없이" });
    expect(await vault.open(owner, saved.id)).toMatchObject({
      username: USERNAME,
    });
    expect(
      (await down.replace(owner, saved.id, { label: "기록 없이 고침" }))?.label,
    ).toBe("기록 없이 고침");
    // A person who deletes a password has deleted it, whatever else is down.
    expect(await down.remove(owner, saved.id)).toBe(true);
    expect(await vault.open(owner, saved.id)).toBeNull();
  });
});
