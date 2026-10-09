import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import {
  type ComputerClient,
  ComputerUnavailableError,
  type FieldWhere,
  LoginNotForPageError,
} from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import { LoginSealError } from "../src/logins/crypto";
import type { SavedLogin } from "../src/logins/store";

/**
 * A LOGIN A PERSON SAVED FOR A SITE ANSWERS A REQUEST FOR ITS SIGN-IN'S VALUES (2026-10-10, record
 * §6, piece 2-4).
 *
 * The Bot asks the way it always has — `computer_request_secret`, these boxes — and who holds the
 * values is this server's to settle: the vault, where the person saved a login for the origin the
 * boxes are in; the person otherwise. Pinned here: when the vault answers and when it does not,
 * that the fill is judged as an act of its own, which value goes into which box, and that no row
 * and no answer holds a value.
 */

const WHO = "sajang-saved";
const PASSWORD = "S4ved!Password-CANARY";
const ORIGIN = "https://example.com";

const ACTOR = { id: "owner-1", userId: "owner-1", threadId: "thread-a" };
const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

const LOGIN_PAGE: SnapshotResult = {
  snapshotId: 3,
  url: "https://example.com/login?next=%2Forders",
  title: "Login",
  truncated: false,
  elements: [
    { ref: "e1", role: "textbox", name: "아이디" },
    { ref: "e2", role: "textbox", name: "비밀번호", type: "password" },
    { ref: "e3", role: "textbox", name: "인증번호", type: "password" },
    { ref: "e4", role: "button", name: "로그인" },
  ],
};

const saved = (id: string, label: string, site?: string): SavedLogin => ({
  id,
  label,
  site: site ?? null,
  origins: [ORIGIN],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  lastUsedAt: null,
});

/** What the computer says of each box unless a case says otherwise: a sign-in, on the site. */
const SIGN_IN: Record<string, Omit<FieldWhere, "ref">> = {
  e1: { origin: ORIGIN, kind: "text" },
  e2: { origin: ORIGIN, kind: "password" },
  e3: { origin: ORIGIN, kind: "other" },
};

function stack(
  options: {
    logins?: SavedLogin[];
    policy?: ActionPolicy;
    where?: Record<string, Omit<FieldWhere, "ref">>;
    /** Replaces a call on the computer, where a case is about it failing. */
    computer?: Partial<Record<"whereFields" | "fillLogin", () => never>>;
    open?: () => never;
    vault?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const filled: unknown[] = [];
  const opened: string[] = [];
  const used: string[] = [];
  const where = options.where ?? SIGN_IN;
  const client = {
    snapshot: async () => LOGIN_PAGE,
    control: async () => ({
      holder: "bot",
      since: "2026-10-10T00:00:00.000Z",
      requested: false,
    }),
    requestSecret: async (input: {
      fields: { label: string; ref: string }[];
    }) => {
      calls.push("requestSecret");
      return {
        holder: "bot",
        since: "2026-10-10T00:00:00.000Z",
        requested: false,
        secretWanted: input.fields.map((field) => field.label).join(", "),
        secretRef: input.fields[0]?.ref,
        secretFields: input.fields,
      };
    },
    whereFields: async (refs: string[]) => {
      calls.push("whereFields");
      options.computer?.whereFields?.();
      return {
        fields: refs.map((ref) => ({
          ref,
          ...(where[ref] ?? { origin: "", kind: "other" as const }),
        })),
      };
    },
    fillLogin: async (fields: unknown, into: unknown) => {
      calls.push("fillLogin");
      options.computer?.fillLogin?.();
      filled.push({ fields, into });
      return {
        filled: true,
        fields: (fields as unknown[]).length,
        url: LOGIN_PAGE.url,
      };
    },
    runEnded: async () => ({ ended: true, closed: 1 }),
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const approvals = createApprovalRegistry();
  const logins = options.logins ?? [saved("login-1", "회사 계정", "naver")];
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => options.policy ?? PERMISSIVE,
    approvals,
    ...(options.vault === false
      ? {}
      : {
          logins: {
            forOrigin: async (userId: string, address: string) =>
              userId === ACTOR.id && address === ORIGIN ? logins : [],
            open: async (userId: string, id: string) => {
              opened.push(id);
              options.open?.();
              const login = logins.find((one) => one.id === id);
              return userId === ACTOR.id && login
                ? { login, username: WHO, password: PASSWORD }
                : null;
            },
            used: async (_userId: string, id: string) => void used.push(id),
          },
        }),
  });
  /** The Bot asking for the sign-in's two boxes, name first — or whatever a case names. */
  const ask = async (
    fields: { ref: string; label: string }[] = [
      { ref: "e1", label: "아이디" },
      { ref: "e2", label: "비밀번호" },
    ],
    more: { login?: string; approvalId?: string } = {},
  ) => {
    await gateway.snapshot("bot-1");
    return gateway.requestSecret(
      "bot-1",
      "bot-1",
      ACTOR,
      {
        fields,
        snapshotId: 3,
        ...(more.login ? { login: more.login } : {}),
      },
      more.approvalId,
    );
  };
  return { gateway, approvals, calls, filled, opened, used, rows, ask };
}

const fillRows = (rows: AuditEventInput[]) =>
  rows.filter((row) => row.payload.action === "computer_fill_login");

describe("a request for a sign-in's values, on a site the person saved a login for", () => {
  test("is answered from the vault: each value into its own box, nobody asked, one row that names the login and no value", async () => {
    const { gateway, calls, filled, used, rows, ask } = stack();
    const answer = await ask();
    expect(answer.loginFilled).toEqual({
      id: "login-1",
      site: "naver",
      fields: 2,
    });
    // No card was opened on the computer: the person is not waited for.
    expect(calls).toEqual(["whereFields", "fillLogin"]);
    expect(answer.secretWanted).toBeUndefined();
    expect(filled).toEqual([
      {
        fields: [
          {
            ref: "e1",
            element: { role: "textbox", name: "아이디" },
            value: WHO,
          },
          {
            ref: "e2",
            element: { role: "textbox", name: "비밀번호" },
            value: PASSWORD,
          },
        ],
        // The origins it was saved for go with the values: the computer holds each box to them.
        into: { snapshotId: 3, origins: [ORIGIN] },
      },
    ]);
    expect(used).toEqual(["login-1"]);
    // The act's own row: what was done, to which boxes, on which site, with which login.
    const [row, ...others] = fillRows(rows);
    expect(others).toEqual([]);
    expect(row?.eventType).toBe("computer.action_allowed");
    expect(row?.payload).toMatchObject({
      action: "computer_fill_login",
      login: { id: "login-1", site: "naver" },
      page: "https://example.com/login",
      fields: [
        { ref: "e1", role: "textbox", name: "아이디" },
        { ref: "e2", role: "textbox", name: "비밀번호" },
      ],
    });
    // Nothing a person called it, and nothing of what it holds, in any row or in the answer.
    const written = JSON.stringify([rows, answer]);
    for (const secret of [WHO, PASSWORD, "회사 계정"]) {
      expect(written).not.toContain(secret);
    }
    // Held for the run like a value a person typed, and the boxes read as secret from here on.
    expect(gateway.holdsValues("bot-1")).toBe(true);
    const after = await gateway.snapshot("bot-1");
    expect(after.elements.find((one) => one.ref === "e1")).toMatchObject({
      type: "password",
    });
  });

  test("puts the password into the password box whichever order the card names them in, and into a lone password box", async () => {
    const swapped = stack();
    await swapped.ask([
      { ref: "e2", label: "비밀번호" },
      { ref: "e1", label: "아이디" },
    ]);
    expect(
      (
        swapped.filled[0] as { fields: { ref: string; value: string }[] }
      ).fields.map(({ ref, value }) => [ref, value]),
    ).toEqual([
      ["e2", PASSWORD],
      ["e1", WHO],
    ]);

    const alone = stack();
    const answer = await alone.ask([{ ref: "e2", label: "비밀번호" }]);
    expect(answer.loginFilled?.fields).toBe(1);
    expect(
      (
        alone.filled[0] as { fields: { ref: string; value: string }[] }
      ).fields.map(({ ref, value }) => [ref, value]),
    ).toEqual([["e2", PASSWORD]]);
  });

  /*
   * "SECRET" IS NOT "THE PASSWORD". A look marks a texted code as secret exactly as it marks a
   * password (`e3` above reads `type: "password"`), so which box is which is the computer's to
   * say, off the box's own markup. A card the vault cannot be sure of is a card a person answers.
   */
  test("only a sign-in: a code's box, a name with no password, two passwords or a third box — and the person is asked, with nothing opened", async () => {
    for (const fields of [
      [{ ref: "e3", label: "문자로 온 인증번호" }],
      [{ ref: "e1", label: "아이디" }],
      [
        { ref: "e1", label: "아이디" },
        { ref: "e2", label: "비밀번호" },
        { ref: "e3", label: "인증번호" },
      ],
    ]) {
      const { calls, opened, ask } = stack();
      const answer = await ask(fields);
      expect(answer.loginFilled).toBeUndefined();
      expect(answer.secretWanted).toBeDefined();
      expect(calls).toEqual(["whereFields", "requestSecret"]);
      expect(opened).toEqual([]);
    }
    const two = stack({
      where: {
        e1: { origin: ORIGIN, kind: "password" },
        e2: { origin: ORIGIN, kind: "password" },
      },
    });
    expect((await two.ask()).loginFilled).toBeUndefined();
    expect(two.opened).toEqual([]);
  });

  test("only where every box is in one document of a saved origin: two origins, none, or another site's — and the person is asked", async () => {
    for (const where of [
      {
        // The name's box on the site, and the password's in somebody else's frame.
        e1: { origin: ORIGIN, kind: "text" as const },
        e2: { origin: "https://ads.example", kind: "password" as const },
      },
      {
        e1: { origin: "", kind: "text" as const },
        e2: { origin: "", kind: "password" as const },
      },
      {
        e1: { origin: "https://evil.example", kind: "text" as const },
        e2: { origin: "https://evil.example", kind: "password" as const },
      },
    ]) {
      const { calls, opened, ask } = stack({ where });
      const answer = await ask();
      expect(answer.loginFilled).toBeUndefined();
      expect(calls).toEqual(["whereFields", "requestSecret"]);
      expect(opened).toEqual([]);
    }
  });

  test("is asked of the person where nothing was saved, where there is no vault, and where the computer cannot say where a box is", async () => {
    const nothing = stack({ logins: [] });
    expect((await nothing.ask()).secretWanted).toBeDefined();
    expect(nothing.calls).toEqual(["whereFields", "requestSecret"]);

    // No vault: nothing is even asked of the computer beyond what it always was.
    const none = stack({ vault: false });
    expect((await none.ask()).secretWanted).toBeDefined();
    expect(none.calls).toEqual(["requestSecret"]);

    // An image from before the computer could say: for the length of a rollout.
    const older = stack({
      computer: {
        whereFields: () => {
          throw new ComputerUnavailableError("laf:computer_route_unknown");
        },
      },
    });
    expect((await older.ask()).secretWanted).toBeDefined();
    expect(older.calls).toEqual(["whereFields", "requestSecret"]);
    expect(older.opened).toEqual([]);
  });

  test("a login whose seal does not open is not used, and the person is asked this once", async () => {
    const { calls, ask } = stack({
      open: () => {
        throw new LoginSealError();
      },
    });
    expect((await ask()).secretWanted).toBeDefined();
    expect(calls).toEqual(["whereFields", "requestSecret"]);
  });
});

describe("a site with several saved logins", () => {
  const TWO = [
    saved("login-1", "회사 계정", "naver"),
    saved("login-2", "개인 계정"),
  ];

  test("names them back — what each is called, nothing of what one holds — and puts nothing in until the Bot says which", async () => {
    const { calls, opened, rows, ask } = stack({ logins: TWO });
    const answer = await ask();
    expect(answer.loginChoice).toEqual([
      { id: "login-1", label: "회사 계정", site: "naver" },
      { id: "login-2", label: "개인 계정" },
    ]);
    expect(answer.loginFilled).toBeUndefined();
    // Nobody was asked, nothing was opened, and no act happened to write a row about.
    expect(calls).toEqual(["whereFields"]);
    expect(opened).toEqual([]);
    expect(fillRows(rows)).toEqual([]);

    const chosen = stack({ logins: TWO });
    const filled = await chosen.ask(undefined, { login: "login-2" });
    expect(filled.loginFilled).toEqual({ id: "login-2", fields: 2 });
    expect(chosen.opened).toEqual(["login-2"]);
  });

  test("a login that is not one of this site's is refused before anything is opened, with a row — a page can tell a Bot which to ask for", async () => {
    const { calls, opened, rows, ask } = stack({ logins: TWO });
    const refused = await ask(undefined, {
      login: "login-of-another-site",
    }).catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(ActionRefusedError);
    expect((refused as ActionRefusedError).code).toBe(
      "laf:login_not_for_this_site",
    );
    expect(calls).toEqual(["whereFields"]);
    expect(opened).toEqual([]);
    const [row] = fillRows(rows);
    expect(row?.eventType).toBe("computer.action_refused");
    expect(JSON.stringify(row)).toContain("laf:login_not_for_this_site");
  });
});

describe("the fill is the Bot's act, judged as it happens", () => {
  test("a rule that asks about a saved login asks about that — and a yes puts it in", async () => {
    const { approvals, calls, ask } = stack({
      policy: { deny: [], ask: ['intent == "fill_login"'], allow: ["true"] },
    });
    const asked = (await ask().catch(
      (caught: unknown) => caught,
    )) as ActionNeedsApprovalError;
    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(asked.subject).toMatchObject({
      kind: "browser",
      intent: "fill_login",
      host: "example.com",
      element: { role: "textbox", name: "아이디, 비밀번호" },
    });
    expect(calls).toEqual(["whereFields"]);
    await approvals.answer(asked.approvalId, "bot-1", ACTOR.id, true);
    const answer = await ask(undefined, { approvalId: asked.approvalId });
    expect(answer.loginFilled?.id).toBe("login-1");
  });

  test("a rule that refuses the saved login does not refuse the person: the refusal has its row, and then they are asked", async () => {
    const { calls, filled, rows, ask } = stack({
      policy: {
        deny: ['intent == "fill_login" && page.host == "example.com"'],
        ask: [],
        allow: ["true"],
      },
    });
    const answer = await ask();
    expect(answer.loginFilled).toBeUndefined();
    expect(answer.secretWanted).toBeDefined();
    expect(calls).toEqual(["whereFields", "requestSecret"]);
    expect(filled).toEqual([]);
    expect(fillRows(rows).map((row) => row.eventType)).toEqual([
      "computer.action_refused",
    ]);
    // And the asking is decided on its own: a rule about a saved login said nothing about it.
    expect(
      rows.find(
        (row) =>
          row.payload.action === "computer_request_secret" &&
          row.eventType === "computer.action_allowed",
      ),
    ).toBeDefined();
  });

  test("a person's no to their saved login being used is a no: nothing is put in, and they are not then shown a box to type it into", async () => {
    const { approvals, calls, filled, ask } = stack({
      policy: { deny: [], ask: ['intent == "fill_login"'], allow: ["true"] },
    });
    const asked = (await ask().catch(
      (caught: unknown) => caught,
    )) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, "bot-1", ACTOR.id, false);
    const declined = await ask(undefined, {
      approvalId: asked.approvalId,
    }).catch((caught: unknown) => caught);
    expect(declined).toBeInstanceOf(ActionRefusedError);
    expect(filled).toEqual([]);
    expect(calls).not.toContain("requestSecret");
  });

  test("a rule about asking a person is not a rule about a saved login", async () => {
    const { calls, ask } = stack({
      policy: { deny: ['intent == "fill_secret"'], ask: [], allow: ["true"] },
    });
    expect((await ask()).loginFilled?.id).toBe("login-1");
    expect(calls).toEqual(["whereFields", "fillLogin"]);
  });

  test("a box the computer finds elsewhere when the values arrive gets nothing, the act is written as failed, and the run still ends", async () => {
    const { gateway, rows, ask } = stack({
      computer: {
        fillLogin: () => {
          throw new LoginNotForPageError();
        },
      },
    });
    const failure = await ask().catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(LoginNotForPageError);
    // Decided, then written, then done: the yes has its row, and what became of it has another.
    const [allowed, failed, ...others] = fillRows(rows);
    expect(others).toEqual([]);
    expect(allowed?.eventType).toBe("computer.action_allowed");
    expect(failed?.eventType).toBe("computer.action_failed");
    expect(JSON.stringify(failed)).toContain("laf:login_origin_mismatch");
    expect(failed?.payload).toMatchObject({ login: { id: "login-1" } });
    // Noted before the values left: whatever did go in is the computer's to let go of.
    expect(gateway.holdsValues("bot-1")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });
});
