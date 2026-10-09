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
import { pseudonymFor } from "../src/account/pseudonym";
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
/*
 * The rows a change writes with itself are caught here too, so a test can read them as it reads
 * the refusals. That they are written ON THE CHANGE'S TRANSACTION when nobody says otherwise —
 * and what happens when that row cannot be written — has tests of its own at the end.
 */
const vault = createLoginVault({
  database,
  keyEncryptionKey: KEY,
  trailWithin: () => auditStore,
});

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

  /*
   * WHICH LOGIN IS A SITE'S (2026-10-10, record §6, piece 2-4). The gateway asks the vault, with the
   * origin of the document a sign-in's boxes are in, and puts a login only where the vault says it
   * was saved for — so the rule about origins is read in one place, the one that read it when the
   * login was saved.
   */
  test("is found by the origin of the document its boxes are in — any of its origins, however the address is spelled, and no other — and says when it was last put in, in no row of the trail", async () => {
    const [mine] = await vault.list(owner);
    if (!mine) throw new Error("the owner has no saved login");
    for (const address of [
      "https://nid.naver.com",
      "https://NID.naver.com:443/nidlogin.login?mode=form",
      "https://sell.smartstore.naver.com",
    ]) {
      expect(
        (await vault.forOrigin(owner, address)).map((login) => login.id),
      ).toEqual([mine.id]);
    }
    for (const address of [
      // The same host without TLS, its parent, a look-alike, another port, and no address at all.
      "http://nid.naver.com",
      "https://naver.com",
      "https://nid.naver.com.evil.example",
      "https://nid.naver.com:8443",
      "about:blank",
      "",
    ]) {
      expect(await vault.forOrigin(owner, address)).toEqual([]);
    }
    // Nobody else's, and nothing of a value in what is handed back.
    expect(await vault.forOrigin(other, "https://nid.naver.com")).toEqual([]);
    expect(
      holdsAValue(
        JSON.stringify(await vault.forOrigin(owner, "https://nid.naver.com")),
      ),
    ).toBe(false);

    expect(mine.lastUsedAt).toBeNull();
    const written = rows.length;
    await vault.used(other, mine.id);
    expect((await vault.list(owner))[0]?.lastUsedAt).toBeNull();
    await vault.used(owner, mine.id);
    expect((await vault.list(owner))[0]?.lastUsedAt).not.toBeNull();
    // The fill writes its own row, at the gate: this writes none.
    expect(rows.length).toBe(written);
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
      // No address, too many, and one that is not an HTTPS site are three facts: the trail's page
      // says why in words, and "not an HTTPS site" is false of nine good ones.
      [{ ...NAVER, origins: [] }, "laf:login_origins_required", "origins"],
      [
        { ...NAVER, origins: "nid.naver.com" },
        "laf:login_origins_required",
        "origins",
      ],
      [{ ...NAVER, origins: nine }, "laf:login_origins_too_many", "origins"],
      // The same address sixty-five times, and twenty thousand different ones: neither is read
      // to its end to be refused — a body may be a megabyte, and the bound is on what is READ.
      [
        {
          ...NAVER,
          origins: Array.from({ length: 65 }, () => "nid.naver.com"),
        },
        "laf:login_origins_too_many",
        "origins",
      ],
      [
        {
          ...NAVER,
          origins: Array.from(
            { length: 20_000 },
            (_, n) => `https://s${n}.example`,
          ),
        },
        "laf:login_origins_too_many",
        "origins",
      ],
      // A host name longer than one can be, and an address that is most of a megabyte: saved,
      // either would be in the row, in the trail for good, and in every list sent back.
      [
        { ...NAVER, origins: [`${"a.".repeat(127)}example`] },
        "laf:login_origin_refused",
        "origins",
      ],
      [
        { ...NAVER, origins: [`https://${"a".repeat(900_000)}.example`] },
        "laf:login_origin_refused",
        "origins",
      ],
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
    ] as const) {
      rows.length = 0;
      const refused = await call("POST", "", body);
      const said = await refused.text();
      expect([refused.status, JSON.parse(said)]).toEqual([
        400,
        { error: code, code, field },
      ]);
      // A refusal does not say back what it refused.
      expect(holdsAValue(said)).toBe(false);
      /*
       * AND IT LEAVES A ROW: that a save was refused, as which fact, about which field — and
       * nothing of what was written, not the origin that was refused either (Codex's read of
       * this change: a refusal with no row is an attempt the trail cannot say happened).
       */
      expect(
        rows.map((one) => [
          one.eventType,
          one.actorUserId,
          one.targetType,
          one.targetId,
          one.payload,
        ]),
      ).toEqual([
        [
          "account.login_refused",
          owner,
          "saved_login",
          "unsaved",
          { code, field },
        ],
      ]);
    }
    expect(JSON.stringify(rows)).not.toContain("naver");
    expect(await stored(owner)).toBe(before);
    // A change is held to the same: a login is not edited into one that is not — and its row
    // names the login the change was refused for.
    const [mine] = await vault.list(owner);
    rows.length = 0;
    const edited = await call("PATCH", `/${mine?.id}`, {
      origins: ["http://nid.naver.com"],
    });
    expect(edited.status).toBe(400);
    expect(await stored(owner)).toBe(before);
    expect(
      rows.map((one) => [one.eventType, one.targetId, one.payload]),
    ).toEqual([
      [
        "account.login_refused",
        mine?.id,
        // Which login, by where it may go AS IT STANDS — the refused address is not in the row.
        {
          site: "naver-smartstore",
          origins: mine?.origins,
          code: "laf:login_origin_refused",
          field: "origins",
        },
      ],
    ]);
    expect(JSON.stringify(rows)).not.toContain("http://");

    /*
     * A BODY THAT CANNOT BE READ IS REFUSED AS THAT, never taken for an empty one: a change of
     * nothing answers 200 with the row as it stands, and a window that had sent a new password
     * as bytes this could not read would be told it was saved. AND IT LEAVES ITS ROW like any
     * refusal — answered at the door it left none (Codex's second read).
     */
    rows.length = 0;
    for (const [method, path] of [
      ["POST", ""],
      ["PATCH", `/${mine?.id}`],
    ] as const) {
      // The last is an object, and names something a login is not made of: a typo for
      // `password`, which read as "nothing was sent" would be answered as a change that was made.
      for (const body of [
        '"not an object"',
        '["label"]',
        "{not json",
        "",
        '{"passwrod":"typo-CANARY"}',
      ]) {
        const unreadable = await app.request(`/api/logins${path}`, {
          method,
          headers: { "content-type": "application/json", "x-test-user": owner },
          body,
        });
        expect([
          method,
          body,
          unreadable.status,
          await unreadable.json(),
        ]).toEqual([
          method,
          body,
          400,
          { error: "laf:login_invalid", code: "laf:login_invalid" },
        ]);
      }
    }
    expect(await stored(owner)).toBe(before);
    // Five that never became a login, and five about the login a change was sent for.
    expect(
      rows.map((one) => [one.eventType, one.targetId, one.payload]),
    ).toEqual([
      ...Array.from({ length: 5 }, () => [
        "account.login_refused",
        "unsaved",
        { code: "laf:login_invalid" },
      ]),
      ...Array.from({ length: 5 }, () => [
        "account.login_refused",
        mine?.id,
        {
          site: "naver-smartstore",
          origins: mine?.origins,
          code: "laf:login_invalid",
        },
      ]),
    ]);
  });

  test("a change that cannot be read is refused before its login is looked for, and a name is saved as one the database can hold", async () => {
    /*
     * Sent for a login that is nobody's, bytes that could not be read were answered "not found"
     * — a 404 and no row, for what is a refusal with a row when the login is theirs.
     */
    rows.length = 0;
    for (const body of ["{not json", '{"passwrod":"x"}']) {
      const unreadable = await app.request("/api/logins/login_nobodys", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-test-user": owner },
        body,
      });
      expect([unreadable.status, await unreadable.json()]).toEqual([
        400,
        { error: "laf:login_invalid", code: "laf:login_invalid" },
      ]);
    }
    // No login of theirs to name: the row is about a change that was about nothing.
    expect(
      rows.map((one) => [one.eventType, one.targetId, one.payload]),
    ).toEqual(
      Array.from({ length: 2 }, () => [
        "account.login_refused",
        "unsaved",
        { code: "laf:login_invalid" },
      ]),
    );
    // A change that CAN be read, for a login that is nobody's, is still not found — and is
    // nothing the trail is told of.
    rows.length = 0;
    const missing = await call("PATCH", "/login_nobodys", { label: "가게" });
    expect(missing.status).toBe(404);
    expect(rows).toEqual([]);

    /*
     * A NAME WITH A ZERO BYTE IN IT is text Postgres cannot store: the save died inside the
     * database, as a 500 with no refusal and no row. Control characters are read as the spaces
     * they would be drawn as; a name made of nothing else is no name.
     */
    const named = await call("POST", "", {
      ...NAVER,
      label: "가게\u0000스마트\u0007스토어\u009f ",
    });
    expect(named.status).toBe(201);
    const saved = (await named.json()) as { id: string; label: string };
    expect(saved.label).toBe("가게 스마트 스토어");
    const unnamed = await call("POST", "", { ...NAVER, label: "\u0000\u0001" });
    expect([unnamed.status, await unnamed.json()]).toEqual([
      400,
      {
        error: "laf:login_label_required",
        code: "laf:login_label_required",
        field: "label",
      },
    ]);
    // A name whose first character is longer than a name may be cuts to nothing: no name.
    const accents = await call("POST", "", {
      ...NAVER,
      label: `a${"\u0301".repeat(90)}`,
    });
    expect([
      accents.status,
      ((await accents.json()) as { code: string }).code,
    ]).toEqual([400, "laf:login_label_required"]);
    /*
     * A VALUE THAT IS NOT TEXT IS REFUSED, NOT MENDED. Half a character in a password is
     * replaced when it is turned into bytes: what would be opened later is not what was typed.
     */
    const before = await stored(owner);
    for (const [field, value] of [
      ["password", "hunter\ud800"],
      ["username", "\udc00sajang"],
    ] as const) {
      const half = await call("POST", "", { ...NAVER, [field]: value });
      expect([field, half.status, await half.json()]).toEqual([
        field,
        400,
        { error: "laf:login_invalid", code: "laf:login_invalid", field },
      ]);
    }
    expect(await stored(owner)).toBe(before);
    // And a name is cut where a character ends, not through one.
    const long = await call("PATCH", `/${saved.id}`, {
      label: "🏪".repeat(200),
    });
    const cut = ((await long.json()) as { label: string }).label;
    expect(cut.isWellFormed()).toBe(true);
    expect([...cut].every((character) => character === "🏪")).toBe(true);
    // Eighty as a person counts them — which for these is twice that many code units.
    expect([...cut]).toHaveLength(80);
    expect(await vault.remove(owner, saved.id)).toBe(true);
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

  test("is written with its row in the trail or not at all: a trail that cannot be written leaves nothing saved, changed or deleted", async () => {
    /*
     * The row about a change used to be written after the change had committed. A trail that
     * could not be written then answered a save with a failure AFTER the login was in the vault —
     * and the same request, sent again, saved it twice (Codex's read of this change). The change
     * and its row are one transaction: both, or neither.
     */
    let down = true;
    const fragile = createLoginVault({
      database,
      keyEncryptionKey: KEY,
      trailWithin: () => ({
        insert: async (event) => {
          if (down) throw new Error("the audit store is unreachable");
          rows.push(event);
        },
      }),
    });
    const before = await stored(owner);
    const failed = (act: Promise<unknown>) =>
      act.then(
        () => "done",
        (error: unknown) => (error as Error).message,
      );

    // A save that cannot be recorded is not made.
    expect(
      await failed(fragile.save(owner, { ...NAVER, label: "기록 없이" })),
    ).toBe("the audit store is unreachable");
    expect(await stored(owner)).toBe(before);
    // Nor a change, nor a delete: the login is as it was, and still there.
    const [mine] = await vault.list(owner);
    if (!mine) throw new Error("the owner has no saved login");
    expect(
      await failed(
        fragile.replace(owner, mine.id, { password: "never-CANARY" }),
      ),
    ).toBe("the audit store is unreachable");
    expect(await failed(fragile.remove(owner, mine.id))).toBe(
      "the audit store is unreachable",
    );
    expect(await stored(owner)).toBe(before);
    expect(await vault.open(owner, mine.id)).toMatchObject({
      password: PASSWORD,
    });

    // The trail is back: the same save, sent again, is made — once.
    down = false;
    rows.length = 0;
    const saved = await fragile.save(owner, { ...NAVER, label: "기록 없이" });
    expect(
      (await vault.list(owner)).filter((one) => one.label === "기록 없이"),
    ).toHaveLength(1);
    expect(rows.map((one) => [one.eventType, one.targetId])).toEqual([
      ["account.login_saved", saved.id],
    ]);
    expect(await fragile.remove(owner, saved.id)).toBe(true);
  });

  test("writes a refusal under the person's pseudonym once the person is gone: a request that outlived its account does not put their id back in the trail", async () => {
    /*
     * A refusal's row has no key to the person, so it can be written after they have left — by a
     * request that was already past the session check when the deletion committed. Everything
     * else of theirs in the trail has just been re-pointed at a pseudonym (migration 0028).
     */
    const gone = `login-gone-${tag}`;
    rows.length = 0;
    await vault
      .save(gone, { ...NAVER, origins: ["http://nid.naver.com"] })
      .catch(() => undefined);
    await vault.save(owner, { ...NAVER, origins: [] }).catch(() => undefined);
    expect(rows.map((one) => [one.eventType, one.actorUserId])).toEqual([
      ["account.login_refused", pseudonymFor(gone)],
      // Somebody who is here is still themselves.
      ["account.login_refused", owner],
    ]);
    expect(JSON.stringify(rows)).not.toContain(gone);
  });

  test("holds under two requests at the same moment: neither change puts back what the other made, and the hundredth login is saved once", async () => {
    /*
     * This file's own pool gives transactions ONE connection, so two of them take turns and a
     * race cannot be seen. A second client with room for two at once is what these need.
     */
    const wide = createDatabase(
      process.env.DATABASE_URL ??
        "postgres://openbot:openbot@localhost:5432/openbot",
      { max: 4 },
    );
    const atOnce = createLoginVault({
      database: wide,
      keyEncryptionKey: KEY,
      trailWithin: () => ({ insert: async () => undefined }),
    });
    const person = `login-race-${tag}`;
    await database
      .insert(users)
      .values({ id: person, email: `${person}@laf.test`, name: person });
    const saved = await atOnce.save(person, NAVER);

    /*
     * A new sign-in name and a new password, sent together as two changes. Each is sealed with
     * the value the other did not send — read before the other wrote, that was the OLD one, and
     * whichever landed second put it back: one change lost, both answered as made.
     */
    for (let round = 0; round < 8; round += 1) {
      const name = `sajang-${round}`;
      const word = `hunter-${round}`;
      await Promise.all([
        atOnce.replace(person, saved.id, { username: name }),
        atOnce.replace(person, saved.id, { password: word }),
      ]);
      expect(await atOnce.open(person, saved.id)).toMatchObject({
        username: name,
        password: word,
      });
      // And a new name for the login beside a new password: the label is not put back.
      await Promise.all([
        atOnce.replace(person, saved.id, { label: `가게 ${round}` }),
        atOnce.replace(person, saved.id, { password: `${word}!` }),
      ]);
      const opened = await atOnce.open(person, saved.id);
      expect([opened?.login.label, opened?.password]).toEqual([
        `가게 ${round}`,
        `${word}!`,
      ]);
    }

    // Ninety-nine saved, and two saves at once: counted and then written, both saw ninety-nine.
    await database.insert(lafSavedLogins).values(
      Array.from({ length: SAVED_LOGINS_MAX - 2 }, (_, n) => ({
        id: `login-race-${tag}-${n}`,
        userId: person,
        label: `자리 ${n}`,
        origins: ["https://full.example"],
        wrappedKey: "lv1.AAAA.AAAA",
        kekId: "0000000000000000",
        sealedUsername: "lv1.AAAA.AAAA",
        sealedPassword: "lv1.AAAA.AAAA",
      })),
    );
    const both = await Promise.allSettled([
      atOnce.save(person, NAVER),
      atOnce.save(person, NAVER),
    ]);
    expect(both.map((one) => one.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const refused = both.find((one) => one.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      code: "laf:logins_full",
    });
    expect(await atOnce.list(person)).toHaveLength(SAVED_LOGINS_MAX);

    await database.delete(users).where(eq(users.id, person));
    await wide.$client.close();
  });

  test("writes those rows on the change's own transaction when nobody says otherwise: they are in the trail's table, under the person", async () => {
    // As `main.ts` makes it: no `trailWithin`. The rows go where every row of the trail goes.
    //
    // THESE THREE ROWS ARE NOT CLEANED UP, and cannot be: the table refuses DELETE ("Audit events
    // are append-only"), which is the property `audit-append-only.integration.test.ts` exists to
    // hold. They are under a person only this run made, so no other file's reading meets them —
    // the same as `account-lifecycle.integration.test.ts` leaves its own.
    const person = `login-trail-${tag}`;
    await database
      .insert(users)
      .values({ id: person, email: `${person}@laf.test`, name: person });
    const asDeployed = createLoginVault({
      database,
      keyEncryptionKey: KEY,
    });
    const saved = await asDeployed.save(person, NAVER);
    await asDeployed.replace(person, saved.id, { password: "trail-CANARY" });
    await asDeployed.remove(person, saved.id);

    const written = (await database.execute(
      sql`select event_type as type, target_type as target, target_id as id, payload::text as payload from audit_events where actor_user_id = ${person} order by created_at, event_type`,
    )) as unknown as Array<{
      type: string;
      target: string;
      id: string;
      payload: string;
    }>;
    expect(written.map((row) => [row.type, row.target, row.id]).sort()).toEqual(
      [
        ["account.login_removed", "saved_login", saved.id],
        ["account.login_replaced", "saved_login", saved.id],
        ["account.login_saved", "saved_login", saved.id],
      ],
    );
    const trail = JSON.stringify(written);
    expect(holdsAValue(trail)).toBe(false);
    expect(trail).not.toContain("trail-CANARY");
    await database.delete(users).where(eq(users.id, person));
  });
});
