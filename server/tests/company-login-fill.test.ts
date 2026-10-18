import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  type ComputerClient,
  ComputerUnavailableError,
} from "../src/computer/client";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import type { HubAnswer, HubHttp, HubRequest } from "../src/hub/http";
import { companyLoginResult, createCompanyVault } from "../src/hub/vault";
import { recentLines } from "../src/log";
import { createShownGuard } from "../src/logins/shown";
import type { SavedLogin } from "../src/logins/store";

/**
 * A COMPANY LOGIN GOES INTO A SIGN-IN THE SAME WAY THE PERSON'S OWN DOES (hub design §9.3): the
 * Bot asks for the boxes with `computer_request_secret`, the gateway finds the company's login
 * for the site on the hub, leases it, judges the fill as `fill_login`, opens it once and puts it
 * in. Pinned here: the values reach the page and nothing else — no row, no answer, no tool result,
 * no log line, no request a hub keeps; the lease is given back on every way out and held, renewed,
 * for a run that signed in; a login another member's VM holds is said as that; a hub that cannot
 * hand it over is a fact and is never tried again later.
 *
 * The hub is a script in this process (the real one is #258, `hub/src/vault.ts`): each route
 * answers as that code answers, and every request is recorded.
 */

const WHO = "company-user-CANARY-7731";
const PASSWORD = "C0mpany!Pass-CANARY-9054";
const ORIGIN = "https://seller.example";
const LOGIN_ID = "smartstore";
const LABEL = "스마트스토어 공용";

const ACTOR = { id: "owner-1", userId: "owner-1", threadId: "thread-a" };
const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

const LOGIN_PAGE: SnapshotResult = {
  snapshotId: 3,
  url: `${ORIGIN}/login`,
  title: "Login",
  truncated: false,
  elements: [
    { ref: "e1", role: "textbox", name: "아이디" },
    { ref: "e2", role: "textbox", name: "비밀번호", type: "password" },
    { ref: "e4", role: "button", name: "로그인" },
  ],
};

/** The page after a sign-in: the same site, and no box a password goes into. */
const SIGNED_IN: SnapshotResult = {
  snapshotId: 4,
  url: `${ORIGIN}/orders`,
  title: "Orders",
  truncated: false,
  elements: [{ ref: "f1", role: "link", name: "주문 관리" }],
};

type HubLogin = {
  id: string;
  label: string;
  site: string | null;
  origins: string[];
  canUse: boolean;
  concurrent: boolean;
  busy?: { member: string; until: string };
};

/**
 * The hub's vault routes, scripted the way #258 answers them. `down` answers nothing at all, as
 * a hub that is not there; `vaultUnset` answers 503 as a hub with no key does.
 */
function scriptedHub(
  options: {
    logins?: HubLogin[];
    /** Another member's VM holds the login when the lease is asked for. */
    leaseBusy?: boolean;
    down?: "all" | "open" | "lease";
    vaultUnset?: boolean;
  } = {},
) {
  const requests: HubRequest[] = [];
  const leases = new Map<string, { login: string; opened: boolean }>();
  let leaseCount = 0;
  const logins = options.logins ?? [
    {
      id: LOGIN_ID,
      label: LABEL,
      site: "smartstore",
      origins: [ORIGIN],
      canUse: true,
      concurrent: false,
    },
  ];
  const state = { down: options.down };
  const answer = (request: HubRequest): HubAnswer<unknown> => {
    const fail = (status: number | null, code: string) => ({
      ok: false as const,
      status,
      code,
    });
    if (state.down === "all") return fail(null, "laf:hub_unreachable");
    if (options.vaultUnset) return fail(503, "laf:hub_unreachable");
    const body = (request.body ?? {}) as Record<string, string>;
    const [, , id, action] = request.path.split("/");
    if (request.path === "/vault") {
      return { ok: true, status: 200, body: { ok: true, logins } };
    }
    if (request.path === "/members") {
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          members: [{ id: "m-kim", name: "김지원", role: "member" }],
        },
      };
    }
    if (action === "lease") {
      if (state.down === "lease") return fail(null, "laf:hub_unreachable");
      if (body.lease) {
        return leases.has(body.lease)
          ? {
              ok: true,
              status: 200,
              body: {
                ok: true,
                lease: body.lease,
                until: new Date(Date.now() + 600_000).toISOString(),
                concurrent: false,
              },
            }
          : fail(409, "laf:vault_lease_invalid");
      }
      if (options.leaseBusy) return fail(409, "laf:vault_busy");
      leaseCount += 1;
      const lease = `${"a".repeat(63)}${leaseCount}`;
      const login = logins.find((one) => one.id === id);
      // The caller's own earlier lease gives way to its new one, as #258's hub does: it leases by
      // member, and this script is one member's hub.
      if (!login?.concurrent) {
        for (const [earlier, held] of leases) {
          if (held.login === id) leases.delete(earlier);
        }
      }
      leases.set(lease, { login: id ?? "", opened: false });
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          lease,
          until: new Date(Date.now() + 600_000).toISOString(),
          concurrent: login?.concurrent === true,
        },
      };
    }
    if (action === "open") {
      if (state.down === "open") return fail(null, "laf:hub_unreachable");
      const held = leases.get(body.lease ?? "");
      if (!held || held.opened) return fail(409, "laf:vault_lease_invalid");
      held.opened = true;
      return {
        ok: true,
        status: 200,
        body: { ok: true, username: WHO, password: PASSWORD },
      };
    }
    if (action === "release") {
      leases.delete(body.lease ?? "");
      return { ok: true, status: 200, body: { ok: true } };
    }
    if (action === "verified") {
      return { ok: true, status: 200, body: { ok: true } };
    }
    return fail(404, "laf:hub_not_found");
  };
  const http: HubHttp = {
    request: async <T>(request: HubRequest) => {
      requests.push(request);
      return answer(request) as HubAnswer<T>;
    },
    socket: () => ({ url: "ws://hub.invalid/events", headers: {} }),
  };
  const sent = (action: string) =>
    requests.filter((request) => request.path.endsWith(`/${action}`));
  return { http, requests, leases, sent, state };
}

const savedLogin = (id: string, label: string): SavedLogin => ({
  id,
  label,
  site: null,
  origins: [ORIGIN],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  lastUsedAt: null,
});

function stack(
  options: {
    hub?: ReturnType<typeof scriptedHub>;
    personal?: SavedLogin[];
    policy?: ActionPolicy;
    fillFails?: boolean;
    /** Runs before the computer is handed the values: where a case stops the run mid-fill. */
    beforeFill?: () => void;
  } = {},
) {
  const hub = options.hub ?? scriptedHub();
  const calls: string[] = [];
  /** What the page was given: the one place the values may arrive. */
  const filled: { ref: string; value: string }[][] = [];
  const timers: { ms: number; run: () => void; cancelled: boolean }[] = [];
  /** The origins kept for leaving the company (`hub_vault_origins`). */
  const noted: string[][] = [];
  let page = LOGIN_PAGE;
  const client = {
    snapshot: async () => page,
    control: async () => ({
      holder: "bot",
      since: "2026-10-16T00:00:00.000Z",
      requested: false,
    }),
    requestSecret: async (input: { fields: { label: string }[] }) => {
      calls.push("requestSecret");
      return {
        holder: "bot",
        since: "2026-10-16T00:00:00.000Z",
        requested: false,
        secretWanted: input.fields.map((field) => field.label).join(", "),
      };
    },
    whereFields: async (refs: string[]) => ({
      fields: refs.map((ref) => ({
        ref,
        origin: ORIGIN,
        kind: ref === "e2" ? ("password" as const) : ("text" as const),
      })),
    }),
    fillLogin: async (fields: { ref: string; value: string }[]) => {
      calls.push("fillLogin");
      options.beforeFill?.();
      if (options.fillFails) {
        throw new ComputerUnavailableError("laf:computer_unavailable");
      }
      filled.push(fields.map(({ ref, value }) => ({ ref, value })));
      return { filled: true, fields: fields.length, url: page.url };
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
  const personal = options.personal ?? [];
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => options.policy ?? PERMISSIVE,
    logins: {
      forOrigin: async () => personal,
      open: async (_userId: string, id: string) => {
        const login = personal.find((one) => one.id === id);
        return login
          ? { login, username: "own-user", password: "own-pass" }
          : null;
      },
      used: async () => undefined,
    },
    companyLogins: {
      vault: createCompanyVault({ http: hub.http }),
      noteOrigins: async (origins) => void noted.push([...origins]),
      // The renewal clock, by hand: a case fires a timer when it means the lease is near its end.
      schedule: (ms, run) => {
        const timer = { ms, run, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  });
  const ask = async (
    more: { login?: string; signal?: AbortSignal; actor?: typeof ACTOR } = {},
  ) => {
    page = LOGIN_PAGE;
    await gateway.snapshot("bot-1");
    return gateway.requestSecret(
      "bot-1",
      "bot-1",
      more.actor ?? ACTOR,
      {
        fields: [
          { ref: "e1", label: "아이디" },
          { ref: "e2", label: "비밀번호" },
        ],
        snapshotId: 3,
        ...(more.login ? { login: more.login } : {}),
      },
      undefined,
      more.signal,
    );
  };
  /** The Bot pressed 로그인 and looked again: the page it is on now. */
  const lookAt = async (next: SnapshotResult) => {
    page = next;
    await gateway.snapshot("bot-1");
  };
  return { gateway, hub, calls, filled, rows, ask, lookAt, timers, noted };
}

/** Everything a value must never be in, after a case: serialised whole. */
function everywhereButThePage(
  made: ReturnType<typeof stack>,
  extra: unknown[],
  logsFrom: number,
): string {
  // Every request the VM made to the hub, as sent: none of them may carry a value either.
  return JSON.stringify([
    made.rows,
    made.hub.requests,
    recentLines.lines().slice(logsFrom),
    ...extra,
  ]);
}

const fillRows = (rows: AuditEventInput[]) =>
  rows.filter((row) => row.payload.action === "computer_fill_login");

describe("a company login granted to the person, on a site's sign-in", () => {
  test("goes into the boxes through the same fill: leased, judged, opened once, filled — and the values are in the page and nowhere else", async () => {
    const logsFrom = recentLines.lines().length;
    const made = stack();
    const answer = await made.ask();
    expect(answer.loginFilled).toEqual({
      id: `company:${LOGIN_ID}`,
      site: "smartstore",
      fields: 2,
      company: true,
    });
    // The page saw both values, each in its own box.
    expect(made.filled).toEqual([
      [
        { ref: "e1", value: WHO },
        { ref: "e2", value: PASSWORD },
      ],
    ]);
    // Nobody was asked; one lease, one open.
    expect(made.calls).toEqual(["fillLogin"]);
    expect(made.hub.sent("lease")).toHaveLength(1);
    expect(made.hub.sent("open")).toHaveLength(1);
    // The act's own row, as the person's own login leaves: the login by its shown id, no value.
    const [row, ...others] = fillRows(made.rows);
    expect(others).toEqual([]);
    expect(row?.eventType).toBe("computer.action_allowed");
    expect(row?.payload).toMatchObject({
      action: "computer_fill_login",
      login: { id: `company:${LOGIN_ID}`, site: "smartstore" },
    });
    // What the Bot is told, and what the transcript keeps of it.
    const result = companyLoginResult(answer);
    expect(result).toMatchObject({
      ok: true,
      code: "laf:company_login_filled",
    });
    const toolMessage = {
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify(result),
    };
    const written = everywhereButThePage(
      made,
      [answer, result, toolMessage],
      logsFrom,
    );
    for (const secret of [WHO, PASSWORD]) {
      expect(written).not.toContain(secret);
    }
    // The canary is real: the page did get it, so its absence above is not an empty record.
    expect(JSON.stringify(made.filled)).toContain(PASSWORD);
    // Held for the run, and the boxes read as secret from here on.
    expect(made.gateway.companyLeases("bot-1")).toEqual([
      { run: "thread-a", login: LOGIN_ID },
    ]);
    expect(made.gateway.holdsValues("bot-1")).toBe(true);
    // The login's origins are kept for leaving the company — origins, and nothing else.
    expect(made.noted).toEqual([[ORIGIN]]);
  });

  test("is opened only once the fill is allowed: a rule that asks opens nothing and gives the lease back", async () => {
    const made = stack({
      policy: { deny: [], ask: ['intent == "fill_login"'], allow: ["true"] },
    });
    await expect(made.ask()).rejects.toThrow();
    expect(made.hub.sent("open")).toEqual([]);
    expect(made.filled).toEqual([]);
    expect(made.hub.sent("release")).toHaveLength(1);
    expect(made.gateway.companyLeases("bot-1")).toEqual([]);
  });

  test("a rule that refuses it gives the lease back and the person is asked, as for their own login", async () => {
    const made = stack({
      policy: { deny: ['intent == "fill_login"'], ask: [], allow: ["true"] },
    });
    const answer = await made.ask();
    expect(answer.secretWanted).toBeDefined();
    expect(made.calls).toEqual(["requestSecret"]);
    expect(made.hub.sent("open")).toEqual([]);
    expect(made.hub.sent("release")).toHaveLength(1);
  });
});

describe("a company login another member's VM holds", () => {
  test("listed as busy: nothing is leased, opened or put in, and the Bot is told whose and until when", async () => {
    const until = "2026-10-16T05:20:00.000Z";
    const hub = scriptedHub({
      logins: [
        {
          id: LOGIN_ID,
          label: LABEL,
          site: "smartstore",
          origins: [ORIGIN],
          canUse: true,
          concurrent: false,
          busy: { member: "m-kim", until },
        },
      ],
    });
    const made = stack({ hub });
    const answer = await made.ask();
    expect(answer.loginBusy).toEqual({
      id: `company:${LOGIN_ID}`,
      label: LABEL,
      site: "smartstore",
      by: "김지원",
      until,
    });
    expect(hub.sent("lease")).toEqual([]);
    expect(hub.sent("open")).toEqual([]);
    expect(made.filled).toEqual([]);
    expect(made.calls).toEqual([]);
    // Nothing went in, so there is no site to sign out of.
    expect(made.noted).toEqual([]);
    expect(companyLoginResult(answer)).toMatchObject({
      ok: false,
      code: "laf:vault_busy",
      busy: { by: "김지원", until },
    });
  });

  test("busy only when the lease is asked for: the same answer, and nothing opened", async () => {
    const hub = scriptedHub({ leaseBusy: true });
    const made = stack({ hub });
    const answer = await made.ask();
    expect(answer.loginBusy?.id).toBe(`company:${LOGIN_ID}`);
    expect(hub.sent("lease")).toHaveLength(1);
    expect(hub.sent("open")).toEqual([]);
    expect(made.filled).toEqual([]);
  });
});

describe("the lease is given back", () => {
  test("when the run ends — and a first sign-in on this VM is told to the hub as a verified device, once", async () => {
    const made = stack();
    await made.ask();
    await made.lookAt(SIGNED_IN);
    await made.gateway.runEnded("bot-1", "thread-a");
    expect(made.hub.sent("release")).toHaveLength(1);
    expect(made.hub.sent("verified").map((one) => one.path)).toEqual([
      `/vault/${LOGIN_ID}/verified`,
    ]);
    expect(made.gateway.companyLeases("bot-1")).toEqual([]);
    // The next run signs in again: the hub already counts this VM, and is not told twice.
    await made.ask();
    await made.lookAt(SIGNED_IN);
    await made.gateway.runEnded("bot-1", "thread-a");
    expect(made.hub.sent("verified")).toHaveLength(1);
  });

  test("a run that ends still on the sign-in form is not a verified device", async () => {
    const made = stack();
    await made.ask();
    // Pressed 로그인 and the form came back (a wrong password): a password box is still there.
    await made.lookAt({ ...LOGIN_PAGE, snapshotId: 5 });
    await made.gateway.runEnded("bot-1", "thread-a");
    expect(made.hub.sent("verified")).toEqual([]);
    expect(made.hub.sent("release")).toHaveLength(1);
  });

  test("when the run is stopped while the values are on their way: given back, and not held", async () => {
    const stop = new AbortController();
    const made = stack({ beforeFill: () => stop.abort() });
    await made.ask({ signal: stop.signal }).catch(() => undefined);
    expect(made.hub.sent("release")).toHaveLength(1);
    expect(made.gateway.companyLeases("bot-1")).toEqual([]);
  });

  test("when the fill fails, and when the hub will not open it — the second said as the plain fact", async () => {
    const failed = stack({ fillFails: true });
    await expect(failed.ask()).rejects.toThrow();
    expect(failed.hub.sent("release")).toHaveLength(1);
    expect(failed.gateway.companyLeases("bot-1")).toEqual([]);

    const hub = scriptedHub({ down: "open" });
    const unopened = stack({ hub });
    const answer = await unopened.ask();
    expect(answer.companyLoginUnavailable).toBe(true);
    expect(unopened.filled).toEqual([]);
    expect(hub.sent("release")).toHaveLength(1);
    expect(companyLoginResult(answer)).toMatchObject({
      ok: false,
      code: "laf:company_login_unavailable",
    });
  });
});

describe("a run that goes on past the lease", () => {
  test("renews it a little before its end, and lets the note go when the hub will not renew it", async () => {
    const made = stack();
    await made.ask();
    const [first] = made.timers;
    // Ten minutes, renewed two before the end.
    expect(first?.ms).toBeGreaterThan(7 * 60_000);
    expect(first?.ms).toBeLessThanOrEqual(8 * 60_000);
    first?.run();
    await Bun.sleep(0);
    const renewals = made.hub.sent("lease").slice(1);
    expect(renewals).toHaveLength(1);
    expect(
      (renewals[0]?.body as { lease?: string } | undefined)?.lease,
    ).toMatch(/^a+1$/);
    // Renewed: still held, and armed again.
    expect(made.gateway.companyLeases("bot-1")).toHaveLength(1);
    expect(made.timers).toHaveLength(2);
    // The hub stops answering: the next renewal fails and the note goes — the lease lapses on
    // the hub's clock, and there is nothing left for the run's end to give back.
    made.hub.state.down = "lease";
    made.timers[1]?.run();
    await Bun.sleep(0);
    expect(made.gateway.companyLeases("bot-1")).toEqual([]);
    await made.gateway.runEnded("bot-1", "thread-a");
    expect(made.hub.sent("release")).toEqual([]);
  });

  test("a run's end cancels the renewal", async () => {
    const made = stack();
    await made.ask();
    await made.gateway.runEnded("bot-1", "thread-a");
    expect(made.timers[0]?.cancelled).toBe(true);
  });
});

describe("a login many may use at once (`concurrent`)", () => {
  test("is never held for the run: its lease is the ticket for the one open, and it goes back as soon as the values are in", async () => {
    const hub = scriptedHub({
      logins: [
        {
          id: LOGIN_ID,
          label: LABEL,
          site: null,
          origins: [ORIGIN],
          canUse: true,
          concurrent: true,
        },
      ],
    });
    const made = stack({ hub });
    const answer = await made.ask();
    expect(answer.loginFilled?.company).toBe(true);
    expect(hub.sent("release")).toHaveLength(1);
    expect(made.gateway.companyLeases("bot-1")).toEqual([]);
    // Its end has nothing to give back.
    await made.gateway.runEnded("bot-1", "thread-a");
    expect(hub.sent("release")).toHaveLength(1);
  });
});

describe("a hub that cannot hand the login over", () => {
  test("with a company login known for the site, an unnamed sign-in goes on as if there were none — the person's own login, or the person asked — and nothing is sent again later", async () => {
    const hub = scriptedHub();
    const made = stack({ hub, personal: [savedLogin("login-1", "내 계정")] });
    // The hub answered once, so this VM knows the site has a company login: both are offered.
    expect((await made.ask()).loginChoice?.map((one) => one.id)).toEqual([
      "login-1",
      `company:${LOGIN_ID}`,
    ]);
    hub.state.down = "all";
    // The hub is down: the person's own goes in, as on a VM with no company.
    const own = await made.ask();
    expect(own.loginFilled).toEqual({ id: "login-1", fields: 2 });
    expect(own.companyLoginUnavailable).toBeUndefined();
    expect(made.filled).toEqual([
      [
        { ref: "e1", value: "own-user" },
        { ref: "e2", value: "own-pass" },
      ],
    ]);
    expect(hub.sent("lease")).toEqual([]);

    // With nothing of the person's own saved, the person is asked.
    const alone = scriptedHub();
    const asked = stack({ hub: alone });
    await asked.ask();
    await asked.gateway.runEnded("bot-1", "thread-a");
    const before = alone.requests.length;
    alone.state.down = "all";
    const answer = await asked.ask();
    expect(answer.companyLoginUnavailable).toBeUndefined();
    expect(answer.secretWanted).toBeDefined();
    expect(asked.calls).toEqual(["fillLogin", "requestSecret"]);
    // One attempt each, and never a write the outbox would keep and offer again: no request to
    // the vault carries the outbox's idempotency key, and none is retried by the caller.
    expect(alone.requests.length - before).toBe(1);
    for (const request of alone.requests) {
      expect(request.retry).toBe(false);
      expect(request.idempotencyKey).toBeUndefined();
    }
  });

  test("with no company login known for the site, the sign-in goes on as on a VM with no company: the person is asked", async () => {
    const made = stack({ hub: scriptedHub({ down: "all" }) });
    const answer = await made.ask();
    expect(answer.companyLoginUnavailable).toBeUndefined();
    expect(answer.secretWanted).toBeDefined();
    expect(made.calls).toEqual(["requestSecret"]);
  });

  test("a company id the Bot names is the same: a plain fact only where a company login is known for the site, refused as not this site's elsewhere", async () => {
    // Known here from an earlier answer: the named login cannot be had now.
    const known = scriptedHub();
    const there = stack({ hub: known });
    await there.ask();
    await there.gateway.runEnded("bot-1", "thread-a");
    known.state.down = "all";
    const answer = await there.ask({ login: `company:${LOGIN_ID}` });
    expect(answer.companyLoginUnavailable).toBe(true);
    // Never known here (an id carried over from another site): the same refusal as with the hub
    // up, so the Bot asks again without it and the person's own login or card follows.
    const made = stack({
      hub: scriptedHub({ down: "all" }),
      personal: [savedLogin("login-1", "내 계정")],
    });
    await expect(made.ask({ login: `company:${LOGIN_ID}` })).rejects.toThrow(
      "laf:login_not_for_this_site",
    );
    const own = await made.ask();
    expect(own.loginFilled).toEqual({ id: "login-1", fields: 2 });
    expect(made.hub.sent("lease")).toEqual([]);
  });

  test("a hub whose vault has no key is the same: 503 is not a login", async () => {
    const made = stack({ hub: scriptedHub({ vaultUnset: true }) });
    const answer = await made.ask();
    expect(answer.secretWanted).toBeDefined();
  });
});

describe("the person's own login and the company's, for one site", () => {
  test("both are named back to choose by — the company's marked and its holder said — and the named one is used", async () => {
    const until = "2026-10-16T05:20:00.000Z";
    const hub = scriptedHub({
      logins: [
        {
          id: LOGIN_ID,
          label: LABEL,
          site: "smartstore",
          origins: [ORIGIN],
          canUse: true,
          concurrent: false,
          busy: { member: "m-kim", until },
        },
        {
          id: "not-mine",
          label: "권한 없는 것",
          site: null,
          origins: [ORIGIN],
          canUse: false,
          concurrent: false,
        },
        {
          id: "elsewhere",
          label: "다른 사이트",
          site: null,
          origins: ["https://other.example"],
          canUse: true,
          concurrent: false,
        },
      ],
    });
    const made = stack({ hub, personal: [savedLogin("login-1", "내 계정")] });
    const answer = await made.ask();
    expect(answer.loginChoice).toEqual([
      { id: "login-1", label: "내 계정" },
      {
        id: `company:${LOGIN_ID}`,
        label: LABEL,
        site: "smartstore",
        company: true,
        busy: { by: "김지원", until },
      },
    ]);
    expect(made.filled).toEqual([]);
    // The Bot names the person's own: it goes in, and the hub is asked for no lease.
    const own = await made.ask({ login: "login-1" });
    expect(own.loginFilled).toEqual({ id: "login-1", fields: 2 });
    expect(hub.sent("lease")).toEqual([]);
  });

  test("a company id that is not one this member may use here is refused before anything is leased", async () => {
    const made = stack({ personal: [savedLogin("login-1", "내 계정")] });
    await expect(made.ask({ login: "company:not-granted" })).rejects.toThrow(
      "laf:login_not_for_this_site",
    );
    expect(made.hub.sent("lease")).toEqual([]);
  });
});

/*
 * TWO RUNS OF ONE VM — a conversation and a routine — AND ONE EXCLUSIVE LOGIN. The hub leases by
 * member, and a member's new lease replaces its earlier one, so the hub cannot keep this VM's own
 * runs apart: the VM keeps them to one at a time itself.
 */
describe("an exclusive company login, among this VM's own runs", () => {
  const ROUTINE = { ...ACTOR, runKey: "routine:r1" };

  test("a second run is told another run of this person's has it: nothing leased, opened or put in, until the first ends", async () => {
    const made = stack();
    expect((await made.ask()).loginFilled?.company).toBe(true);
    const second = await made.ask({ actor: ROUTINE });
    expect(second.loginBusy).toEqual({
      id: `company:${LOGIN_ID}`,
      label: LABEL,
      site: "smartstore",
      otherRun: true,
    });
    expect(companyLoginResult(second)).toMatchObject({
      ok: false,
      code: "laf:vault_busy",
      busy: { otherRun: true },
    });
    expect(made.hub.sent("lease")).toHaveLength(1);
    expect(made.hub.sent("open")).toHaveLength(1);
    expect(made.filled).toHaveLength(1);
    // The hub still holds the conversation's lease, the one its renewal names.
    expect(made.hub.leases.size).toBe(1);
    expect(made.gateway.companyLeases("bot-1")).toEqual([
      { run: "thread-a", login: LOGIN_ID },
    ]);
    // The conversation ends and gives it back: the routine signs in.
    await made.gateway.runEnded("bot-1", "thread-a");
    expect((await made.ask({ actor: ROUTINE })).loginFilled?.company).toBe(
      true,
    );
    expect(made.gateway.companyLeases("bot-1")).toEqual([
      { run: "routine:r1", login: LOGIN_ID },
    ]);
  });

  test("named back in a choice, it is marked as in use by another run of this person's", async () => {
    const made = stack({ personal: [savedLogin("login-1", "내 계정")] });
    await made.ask({ login: `company:${LOGIN_ID}` });
    const choice = await made.ask({ actor: ROUTINE });
    expect(choice.loginChoice).toEqual([
      { id: "login-1", label: "내 계정" },
      {
        id: `company:${LOGIN_ID}`,
        label: LABEL,
        site: "smartstore",
        company: true,
        busy: { otherRun: true },
      },
    ]);
  });

  test("a run signing in again whose second fill fails keeps the login held on the hub: the new lease stands in for the one it replaced", async () => {
    const options: Parameters<typeof stack>[0] = {};
    const made = stack(options);
    await made.ask();
    options.fillFails = true;
    await expect(made.ask()).rejects.toThrow();
    // The hub let the first lease go for the second; the second is not given back.
    expect(made.hub.sent("release")).toEqual([]);
    expect(made.hub.leases.size).toBe(1);
    expect(made.gateway.companyLeases("bot-1")).toEqual([
      { run: "thread-a", login: LOGIN_ID },
    ]);
    // Its renewal names the lease the hub holds, and the run's end gives that one back.
    made.timers.at(-1)?.run();
    await Bun.sleep(0);
    expect(made.gateway.companyLeases("bot-1")).toHaveLength(1);
    await made.gateway.runEnded("bot-1", "thread-a");
    expect(made.hub.leases.size).toBe(0);
  });

  test("a fill for no conversation is given back at the end of the next run of the Bot's", async () => {
    const made = stack();
    const { threadId: _none, ...unthreaded } = ACTOR;
    expect(
      (await made.ask({ actor: unthreaded as typeof ACTOR })).loginFilled
        ?.company,
    ).toBe(true);
    expect(made.gateway.companyLeases("bot-1")).toEqual([
      { run: "", login: LOGIN_ID },
    ]);
    await made.gateway.runEnded("bot-1", "thread-x");
    expect(made.hub.sent("release")).toHaveLength(1);
    expect(made.hub.leases.size).toBe(0);
    expect(made.gateway.companyLeases("bot-1")).toEqual([]);
    // And the next run may have it.
    expect((await made.ask()).loginFilled?.company).toBe(true);
  });

  test("a hold the hub no longer knows is said in the log — why, whose run, no value — not let go of silently", async () => {
    const logsFrom = recentLines.lines().length;
    const made = stack();
    await made.ask();
    // The lease is gone on the hub (taken back, or lapsed): the renewal is refused.
    made.hub.leases.clear();
    made.timers[0]?.run();
    await Bun.sleep(0);
    expect(made.gateway.companyLeases("bot-1")).toEqual([]);
    const said = recentLines
      .lines()
      .slice(logsFrom)
      .filter((line) => line.includes("company_login_hold_lost"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("laf:vault_lease_invalid");
    expect(said[0]).toContain("thread-a");
    for (const secret of [WHO, PASSWORD]) {
      expect(JSON.stringify(said)).not.toContain(secret);
    }
    // Let go of here, so another run of this VM's may sign in.
    expect((await made.ask({ actor: ROUTINE })).loginFilled?.company).toBe(
      true,
    );
  });
});

describe("a company password a site writes back in a later run", () => {
  test("is taken out of what a model is handed on the login's site, and the call told as a hit — on no other site", async () => {
    const made = stack();
    await made.ask();
    await made.lookAt(SIGNED_IN);
    // The run is over; the computer has forgotten the value. The site has not.
    await made.gateway.runEnded("bot-1", "thread-a");
    const seen: boolean[] = [];
    const guard = createShownGuard({
      company: made.gateway.companyPasswordsAt,
      seen: (_run, hidden) => void seen.push(hidden),
    });
    const run = { userId: "owner-1", botId: "bot-1", threadId: "thread-b" };
    const here = await guard(run, {
      url: `${ORIGIN}/account`,
      text: `비밀번호: ${PASSWORD}`,
    });
    expect(here.text).toBe("비밀번호: [•••]");
    const elsewhere = await guard(run, {
      url: "https://other.example/page",
      text: `비밀번호: ${PASSWORD}`,
    });
    expect(elsewhere.text).toBe(`비밀번호: ${PASSWORD}`);
    expect(seen).toEqual([true, false]);
  });
});
