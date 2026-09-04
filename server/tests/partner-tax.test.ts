import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { lafPartnerConnections, users } from "../src/db/schema";
import { catalogueEntry } from "../src/plugins/catalogue";
import { createPartnerConnections } from "../src/plugins/partner-connections";
import {
  createTaxConnect,
  memberIdFor,
  mintMemberPassword,
} from "../src/plugins/tax/connect";
import {
  forgetPopbillTokens,
  linkhubToken,
  type PopbillSettings,
  popbillSettings,
} from "../src/plugins/tax/popbill";
import { createTaxTools } from "../src/plugins/tax/tools";
import { TEST_POOL } from "./support/database";

/**
 * 세금계산서, against a 팝빌 THAT IS NOT 팝빌 — and an auth server that checks the signature.
 *
 * WHY THE FAKE VERIFIES RATHER THAN ACCEPTS. A fake that answered 200 to anything would pass with a
 * canonical string in the wrong order, a secret used printable instead of decoded, or a date header
 * that disagrees with the date that was signed — every one of which produces a well-formed request
 * that the real auth server refuses with `-99010007`, and none of which is visible from a green
 * typecheck. So the fake below rebuilds the string and the HMAC itself and answers 401 when they
 * disagree, which makes this file a test OF THE PROTOCOL rather than of the plumbing around it.
 *
 * THE REAL VENDOR IS NEVER CONTACTED. Both hosts are 127.0.0.1 on ephemeral ports for the whole
 * file, and a 팝빌 issue reaches the 국세청, so a test that got this wrong would be a test that filed
 * somebody's tax document.
 *
 * WHAT IS DELIBERATELY NOT PINNED HERE: whether a business already joined under a DIFFERENT
 * partner's LinkID can be adopted, and what the certificate popup actually shows. Both need LAF's
 * own LinkID against the live service — see `POPBILL_UNVERIFIED`.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const testPrefix = `partner-tax-${randomUUID()}`;
const createdUserIds: string[] = [];

/** Values no real business has, so their absence from a record is a real absence. */
const BUSINESS_NUMBER = "1234567890";
const CONTACT_PHONE = "01055554444";
const CONTACT_EMAIL = "owner@misosanghoe.example.test";
/** LAF's own secret, base64 as 팝빌 issues it. Never in a row, a trail line or a tool result. */
const SECRET_KEY = btoa("a-fleet-secret-nobody-else-holds");
const LINK_ID = "LAFTESTER";

type Seen = {
  host: "auth" | "api";
  path: string;
  method: string;
  override: string;
  authorization: string;
  body: unknown;
};
let seen: Seen[] = [];

/** What the fake 팝빌 currently believes about this business. Bent per test. */
let isMember = false;
let certificateExpiration: string | null = null;
/** How many token requests the auth server has answered. The cache is asserted on this. */
let tokensIssued = 0;
/** How long a token lasts, so the expiry branch can be driven without waiting half an hour. */
let tokenLifetimeMs = 30 * 60_000;

let auth: ReturnType<typeof Bun.serve>;
let api: ReturnType<typeof Bun.serve>;
let authUrl = "";
let apiUrl = "";

const auditRows: AuditEventInput[] = [];
const auditStore: AuditStore = {
  insert: async (event) => {
    auditRows.push(event);
  },
};

const environment = () => ({
  POPBILL_LINK_ID: LINK_ID,
  POPBILL_SECRET_KEY: SECRET_KEY,
  POPBILL_TEST: "true",
  POPBILL_BASE_URL: apiUrl,
  POPBILL_AUTH_URL: authUrl,
});

const base64 = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** The settings, or a failure here rather than a null five frames down. */
function settingsFrom(
  overrides: Record<string, string | undefined> = {},
): PopbillSettings {
  const settings = popbillSettings({ ...environment(), ...overrides });
  if (!settings) throw new Error("the test environment names no 팝빌 partner");
  return settings;
}

/** The signature 팝빌's own auth server would compute for this request. */
async function expectedSignature(input: {
  body: string;
  date: string;
  forwarded: string;
  serviceId: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input.body),
  );
  const canonical = [
    "POST",
    base64(digest),
    input.date,
    input.forwarded,
    "2.0",
    `/${input.serviceId}/Token`,
  ].join("\n");
  const raw = Uint8Array.from(atob(SECRET_KEY), (character) =>
    character.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    raw as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)),
  );
}

beforeAll(() => {
  auth = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();
      seen.push({
        host: "auth",
        path: url.pathname,
        method: request.method,
        override: "",
        authorization: request.headers.get("authorization") ?? "",
        body: text ? JSON.parse(text) : null,
      });

      const serviceId = url.pathname.split("/")[1] ?? "";
      const date = request.headers.get("x-lh-date") ?? "";
      const forwarded = request.headers.get("x-lh-forwarded") ?? "";
      const header = request.headers.get("authorization") ?? "";
      const [scheme, linkId, signature] = header.split(" ");

      if (scheme !== "LINKHUB" || linkId !== LINK_ID) {
        return Response.json(
          { code: -99010007, message: "권한 정보의 서명이 일치하지 않습니다." },
          { status: 401 },
        );
      }
      if (request.headers.get("x-lh-version") !== "2.0") {
        return Response.json(
          { code: -99010005, message: "version" },
          { status: 400 },
        );
      }
      const wanted = await expectedSignature({
        body: text,
        date,
        forwarded,
        serviceId,
      });
      if (signature !== wanted) {
        return Response.json(
          { code: -99010007, message: "권한 정보의 서명이 일치하지 않습니다." },
          { status: 401 },
        );
      }

      tokensIssued += 1;
      return Response.json({
        session_token: `session-${tokensIssued}`,
        serviceID: serviceId,
        expiration: new Date(Date.now() + tokenLifetimeMs).toISOString(),
      });
    },
  });
  authUrl = `http://127.0.0.1:${auth.port}`;

  api = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();
      seen.push({
        host: "api",
        path: url.pathname,
        method: request.method,
        override: request.headers.get("x-http-method-override") ?? "",
        authorization: request.headers.get("authorization") ?? "",
        body: text ? JSON.parse(text) : null,
      });

      if (url.pathname === "/Join" && request.method === "GET") {
        return Response.json({ code: isMember ? 1 : 0, message: "" });
      }
      if (url.pathname === "/Join" && request.method === "POST") {
        isMember = true;
        return Response.json({ code: 1, message: "가입 완료" });
      }
      // Every authenticated route below needs the bearer the auth server issued.
      if (
        !request.headers.get("authorization")?.startsWith("Bearer session-")
      ) {
        return Response.json(
          { code: -10010006, message: "권한 정보가 없습니다." },
          { status: 401 },
        );
      }
      if (url.pathname === "/Taxinvoice" && url.searchParams.has("cfg")) {
        return certificateExpiration
          ? Response.json({ certificateExpiration })
          : Response.json(
              { code: -11000012, message: "인증서가 등록되어 있지 않습니다." },
              { status: 400 },
            );
      }
      if (url.pathname === "/Member") {
        return Response.json({
          url: `https://popbill.example.test/App/API?T=${url.searchParams.get("TG")}`,
        });
      }
      if (url.pathname === "/Taxinvoice" && request.method === "POST") {
        return Response.json({ code: 1, message: "등록 완료" });
      }
      if (/^\/Taxinvoice\/(SELL|BUY|TRUSTEE)$/.test(url.pathname)) {
        return Response.json({
          code: 1,
          total: 1,
          pageNum: 1,
          list: [
            {
              itemKey: "020101000001",
              invoicerMgtKey: "INV-0001",
              writeDate: "20260901",
              stateCode: 300,
              supplyCostTotal: "100000",
              taxTotal: "10000",
              invoiceeCorpName: "받는가게",
              invoiceeCorpNum: "2223334444",
              ntsconfirmNum: "20260901-nts",
            },
          ],
        });
      }
      if (/^\/Taxinvoice\/(SELL|BUY|TRUSTEE)\/[^/]+$/.test(url.pathname)) {
        if (request.headers.get("x-http-method-override") === "ISSUE") {
          return Response.json({
            code: 1,
            ntsConfirmNum: "20260904-issued",
            issueDT: "20260904151123",
          });
        }
        return Response.json({
          code: 1,
          itemKey: "020101000001",
          invoicerMgtKey: url.pathname.split("/").pop(),
          writeDate: "20260901",
          stateCode: 100,
          supplyCostTotal: "100000",
          taxTotal: "10000",
          invoiceeCorpName: "받는가게",
          invoiceeCorpNum: "2223334444",
          ntsconfirmNum: "",
        });
      }
      return Response.json(
        { code: -99999999, message: "no route" },
        { status: 404 },
      );
    },
  });
  apiUrl = `http://127.0.0.1:${api.port}`;
});

afterAll(async () => {
  auth.stop(true);
  api.stop(true);
  await database.$client.close();
});

beforeEach(() => {
  // A token cached by the previous test is a token this one did not ask for.
  forgetPopbillTokens();
  seen = [];
  auditRows.length = 0;
  isMember = false;
  certificateExpiration = null;
  tokensIssued = 0;
  tokenLifetimeMs = 30 * 60_000;
});

afterEach(async () => {
  for (const userId of createdUserIds.splice(0)) {
    await database
      .delete(lafPartnerConnections)
      .where(eq(lafPartnerConnections.userId, userId));
    await database.delete(users).where(eq(users.id, userId));
  }
});

async function createUser(): Promise<string> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Tax Test User",
    emailVerified: true,
  });
  createdUserIds.push(id);
  return id;
}

function connectors() {
  const partners = createPartnerConnections({ database, auditStore });
  return {
    partners,
    connect: createTaxConnect(
      { database, auditStore },
      partners,
      environment(),
    ),
    tools: createTaxTools(partners, environment()),
  };
}

const MEMBER = {
  businessNumber: "123-45-67890",
  corpName: "미소상회",
  ceoName: "김대표",
  contactName: "박담당",
  contactPhone: CONTACT_PHONE,
  contactEmail: CONTACT_EMAIL,
};

async function join(userId: string) {
  const { connect, tools, partners } = connectors();
  const status = await connect.join({ userId, ...MEMBER });
  return { status, connect, tools, partners };
}

describe("the Linkhub session token", () => {
  test("is signed the way the auth server would sign it, and is accepted", async () => {
    const token = await linkhubToken({
      settings: settingsFrom(),
      corpNum: BUSINESS_NUMBER,
    });
    expect(token).toBe("session-1");

    const call = seen.find((entry) => entry.host === "auth");
    // The test service is a PATH SEGMENT, not a host: there is no auth-test.linkhub.co.kr, and a
    // deployment that reached for one would be asking a machine that does not exist.
    expect(call?.path).toBe(`/${"POPBILL_TEST"}/Token`);
    expect(call?.authorization.startsWith(`LINKHUB ${LINK_ID} `)).toBe(true);
    // `access_id` is the member's 사업자등록번호, and the scope is 세금계산서's alone: a token that
    // could also send SMS is a permission nobody agreed to.
    expect(call?.body).toEqual({
      access_id: BUSINESS_NUMBER,
      scope: ["member", "110"],
    });
  });

  test("is cached per business rather than fetched on every call", async () => {
    const userId = await createUser();
    isMember = true;
    const { tools } = await join(userId);
    const before = tokensIssued;

    await tools.callTool(
      { url: apiUrl, actorId: userId, botId: "bot-1" },
      "taxinvoice_list",
      { from: "20260801", to: "20260901" },
    );
    await tools.callTool(
      { url: apiUrl, actorId: userId, botId: "bot-1" },
      "taxinvoice_list",
      { from: "20260801", to: "20260901" },
    );

    // Two calls, no new token: a round trip to the auth server per request is a round trip a
    // person waits for, and 팝빌 gives the token half an hour.
    expect(tokensIssued).toBe(before);
  });

  test("is fetched again once it is close to expiring", async () => {
    const settings = settingsFrom();

    // A token whose whole life is inside the safety margin. 팝빌's own SDK refreshes only AFTER
    // expiry, with no margin, which is a race a long call loses: valid at the check, dead on the
    // wire. This asserts the margin exists.
    tokenLifetimeMs = 60_000;
    expect(await linkhubToken({ settings, corpNum: BUSINESS_NUMBER })).toBe(
      "session-1",
    );
    expect(await linkhubToken({ settings, corpNum: BUSINESS_NUMBER })).toBe(
      "session-2",
    );
    expect(tokensIssued).toBe(2);
  });

  test("a signature the server does not recognise is refused, not retried forever", async () => {
    const wrong = settingsFrom({
      POPBILL_SECRET_KEY: btoa("somebody-else's-secret"),
    });
    const refused = await linkhubToken({
      settings: wrong,
      corpNum: BUSINESS_NUMBER,
    })
      .then(() => null)
      .catch((error: unknown) => error as { code: number | null });

    expect(refused?.code).toBe(-99010007);
  });
});

describe("joining as a 연동회원", () => {
  test("sends what a business would type, under LAF's LinkID and a derived id", async () => {
    const userId = await createUser();
    await join(userId);

    const posted = seen.find(
      (call) => call.path === "/Join" && call.method === "POST",
    );
    const body = posted?.body as Record<string, string>;

    expect(body.LinkID).toBe(LINK_ID);
    expect(body.CorpNum).toBe(BUSINESS_NUMBER);
    expect(body.CorpName).toBe("미소상회");
    expect(body.CEOName).toBe("김대표");
    expect(body.ContactName).toBe("박담당");
    // `ContactTEL`, capitalised exactly so. There is no `ContactHP` in the REST body, and a
    // 담당자 휴대폰 sent under the wrong field name is a member 팝빌 cannot reach.
    expect(body.ContactTEL).toBe(CONTACT_PHONE);
    expect(body.ContactEmail).toBe(CONTACT_EMAIL);
    // Derived rather than chosen: asking a shop owner to invent a second set of credentials for a
    // site they will never visit is asking them to write it on a sticky note.
    expect(body.ID).toBe(memberIdFor(BUSINESS_NUMBER));
  });

  test("asks whether the business is already a member before joining it again", async () => {
    const userId = await createUser();
    isMember = true;
    await join(userId);

    // A second join is refused at 팝빌 with a code that reads to a shop owner as their own business
    // being at fault, so the question is asked first and an existing member is adopted.
    expect(
      seen.some((call) => call.path === "/Join" && call.method === "GET"),
    ).toBe(true);
    expect(
      seen.some((call) => call.path === "/Join" && call.method === "POST"),
    ).toBe(false);
    expect(
      auditRows.find((row) => row.payload?.change === "tax_member_joined")
        ?.payload?.adopted,
    ).toBe(true);
  });

  test("a business number that is not ten digits never reaches the vendor", async () => {
    const userId = await createUser();
    const { connect } = connectors();
    const refused = await connect
      .join({ userId, ...MEMBER, businessNumber: "12345" })
      .then(() => null)
      .catch((error: unknown) => error as { fact: string });

    expect(refused?.fact).toBe("laf:tax_business_number_invalid");
    expect(seen).toHaveLength(0);
  });

  test("the minted password satisfies 팝빌's rule by construction", () => {
    /*
     * Built rather than generated-and-tested, so it cannot loop and cannot occasionally produce one
     * the vendor refuses — a join that failed on a password nobody will ever type would be the most
     * confusing failure in this flow. Walked a hundred times because the interesting failure is a
     * rare draw, not a typical one.
     */
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const password = mintMemberPassword();
      expect(password.length).toBeGreaterThanOrEqual(8);
      expect(password.length).toBeLessThanOrEqual(20);
      expect(password).toMatch(/[A-Za-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[~!@#$%^&*()_+]/);
    }
  });
});

describe("the certificate", () => {
  test("is 팝빌's own popup, handed over and never stored", async () => {
    const userId = await createUser();
    const { connect } = await join(userId);
    seen = [];

    const { url } = await connect.certificateUrl({
      userId,
      kind: "certificate",
    });
    expect(url).toBe("https://popbill.example.test/App/API?T=CERT");
    expect(seen.find((call) => call.path === "/Member")?.path).toBe("/Member");

    // The URL carries a live session and 팝빌 gives it thirty seconds. Written into a row or a
    // trail line it would be a credential at rest with nothing watching it expire.
    const [row] = await database
      .select()
      .from(lafPartnerConnections)
      .where(eq(lafPartnerConnections.userId, userId));
    expect(JSON.stringify(row)).not.toContain("App/API");
    expect(JSON.stringify(auditRows)).not.toContain("App/API");
  });

  test("an unregistered certificate is an answer, not a failure", async () => {
    const userId = await createUser();
    const { status } = await join(userId);

    // 팝빌 answers the cert query with an error code for a member that has none. Read as a failure
    // it would break the connect; read as the answer it is what the card is for.
    expect(status.connected).toBe(true);
    expect(status.certificate.registered).toBe(false);
  });

  test("a registered one is read back with its expiry", async () => {
    const userId = await createUser();
    certificateExpiration = "20270706145209";
    const { status } = await join(userId);

    expect(status.certificate.registered).toBe(true);
    expect(status.certificate.expiresAt).toBe(
      new Date("2027-07-06T14:52:09+09:00").toISOString(),
    );
  });
});

describe("what a Bot may do with the invoices", () => {
  test("lists them, mapping the vendor's state codes into words", async () => {
    const userId = await createUser();
    const { tools } = await join(userId);

    const result = await tools.callTool(
      { url: apiUrl, actorId: userId, botId: "bot-1" },
      "taxinvoice_list",
      { from: "2026-08-01", to: "2026-09-01" },
    );
    const answered = JSON.parse(result.text) as {
      invoices: { state: string; mgtKey: string; ntsConfirmNum: string }[];
    };

    expect(answered.invoices[0]?.state).toBe("발행완료");
    expect(answered.invoices[0]?.mgtKey).toBe("INV-0001");
    // `ntsconfirmNum` in a listing and `ntsConfirmNum` on an issue: 팝빌 really does use both, and
    // reading only one leaves the approval number blank on whichever half is looked at second.
    expect(answered.invoices[0]?.ntsConfirmNum).toBe("20260901-nts");
  });

  test("refuses a search window wider than the vendor allows, before asking it", async () => {
    const userId = await createUser();
    const { tools } = await join(userId);
    seen = [];

    const refused = await tools
      .callTool(
        { url: apiUrl, actorId: userId, botId: "bot-1" },
        "taxinvoice_list",
        { from: "20250101", to: "20261231" },
      )
      .then(() => null)
      .catch((error: unknown) => error as { message: string });

    // Refused here so the answer names the actual problem: a model asking for "this year" is told
    // to narrow it rather than told the connector failed.
    expect(refused?.message).toBe("laf:tax_window_too_wide");
    expect(seen.some((call) => call.host === "api")).toBe(false);
  });

  test("a draft is registered without the override that would issue it", async () => {
    const userId = await createUser();
    const { tools } = await join(userId);
    seen = [];

    const result = await tools.callTool(
      { url: apiUrl, actorId: userId, botId: "bot-1" },
      "taxinvoice_draft",
      {
        mgtKey: "INV-0002",
        writeDate: "20260904",
        buyerBusinessNumber: "222-33-34444",
        buyerName: "받는가게",
        buyerCeoName: "이대표",
        items: [
          { name: "케이크", supplyCost: "100000", tax: "10000" },
          { name: "포장", supplyCost: "5000", tax: "500" },
        ],
      },
    );

    const posted = seen.find(
      (call) => call.path === "/Taxinvoice" && call.method === "POST",
    );
    // `POST /Taxinvoice` with NO override is 임시저장; the same URL with `ISSUE` is 즉시발행. One
    // header is the difference between a draft and a document filed with the 국세청.
    expect(posted?.override).toBe("");
    const body = posted?.body as Record<string, string>;
    /*
     * The totals are summed HERE and not taken from the model. 팝빌 requires all three and derives
     * none, and a model that filled them by hand gets one wrong eventually — which is an invoice
     * whose total does not match its own lines, reported to the 국세청.
     */
    expect(body.supplyCostTotal).toBe("105000");
    expect(body.taxTotal).toBe("10500");
    expect(body.totalAmount).toBe("115500");
    expect(body.invoicerCorpNum).toBe(BUSINESS_NUMBER);
    expect(body.invoiceeCorpNum).toBe("2223334444");
    expect(JSON.parse(result.text).mgtKey).toBe("INV-0002");
  });

  test("will not issue while the business has no certificate registered", async () => {
    const userId = await createUser();
    const { tools } = await join(userId);
    seen = [];

    const refused = await tools
      .callTool(
        { url: apiUrl, actorId: userId, botId: "bot-1" },
        "taxinvoice_issue",
        { mgtKey: "INV-0002" },
      )
      .then(() => null)
      .catch((error: unknown) => error as { message: string });

    // 팝빌 refuses this too, with a code that reads as a problem with the invoice. This is the one
    // thing about the connector a person has to do themselves, so the refusal names it.
    expect(refused?.message).toBe("laf:tax_certificate_missing");
    expect(seen.some((call) => call.override === "ISSUE")).toBe(false);
  });

  test("issues with the ISSUE override once the certificate is there", async () => {
    const userId = await createUser();
    certificateExpiration = "20270706145209";
    const { tools } = await join(userId);
    seen = [];

    const result = await tools.callTool(
      { url: apiUrl, actorId: userId, botId: "bot-1" },
      "taxinvoice_issue",
      { mgtKey: "INV-0002" },
    );

    expect(seen.find((call) => call.override === "ISSUE")?.path).toBe(
      "/Taxinvoice/SELL/INV-0002",
    );
    const answered = JSON.parse(result.text);
    expect(answered.ntsConfirmNum).toBe("20260904-issued");
    // Said in the result, because a Bot reporting "발행했습니다" from a practice deployment would be
    // telling somebody an invoice reached the 국세청 when it reached nobody.
    expect(answered.service).toBe("test");
  });

  test("issuing is the one call in this repository the boundary floors at `money`", () => {
    // A curated entry's floor is the reviewed catalogue's word (`call.ts` reads it from here and
    // ignores the tool's own annotations), so this is the assertion that the floor exists at all.
    expect(catalogueEntry("tax-invoice")?.guardedTools?.taxinvoice_issue).toBe(
      "money",
    );
    expect(catalogueEntry("tax-invoice")?.writeTools).toContain(
      "taxinvoice_issue",
    );
  });

  test("a document number 팝빌 would refuse never reaches it", async () => {
    const userId = await createUser();
    const { tools } = await join(userId);
    seen = [];

    const refused = await tools
      .callTool(
        { url: apiUrl, actorId: userId, botId: "bot-1" },
        "taxinvoice_detail",
        { mgtKey: "INV/0002 안 됨" },
      )
      .then(() => null)
      .catch((error: unknown) => error as { message: string });

    expect(refused?.message).toBe("laf:tax_mgt_key_invalid");
    expect(seen.some((call) => call.host === "api")).toBe(false);
  });

  test("somebody else's business is not this person's to invoice from", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    await join(owner);
    const { tools } = connectors();

    const refused = await tools
      .callTool(
        { url: apiUrl, actorId: stranger, botId: "bot-1" },
        "taxinvoice_list",
        { from: "20260801", to: "20260901" },
      )
      .then(() => null)
      .catch((error: unknown) => error as { message: string });

    expect(refused?.message).toBe("laf:tax_not_connected");
  });
});

describe("disconnecting", () => {
  test("drops the registration and says nothing was withdrawn at 팝빌", async () => {
    const userId = await createUser();
    const { connect } = await join(userId);
    auditRows.length = 0;

    expect(await connect.disconnect(userId)).toEqual({ disconnected: true });
    const rows = await database
      .select()
      .from(lafPartnerConnections)
      .where(eq(lafPartnerConnections.userId, userId));
    expect(rows).toHaveLength(0);
    expect(
      auditRows.find((row) => row.eventType === "mcp.account_disconnected")
        ?.payload?.vendorRevoked,
    ).toBe(false);
  });
});

describe("what is written down", () => {
  test("LAF's secret and the member password reach no row, no trail line and no tool result", async () => {
    const userId = await createUser();
    certificateExpiration = "20270706145209";
    const { status, tools } = await join(userId);
    const listed = await tools.callTool(
      { url: apiUrl, actorId: userId, botId: "bot-1" },
      "taxinvoice_list",
      { from: "20260801", to: "20260901" },
    );

    const rows = await database
      .select()
      .from(lafPartnerConnections)
      .where(eq(lafPartnerConnections.userId, userId));
    const everything = JSON.stringify({
      rows,
      trail: auditRows,
      status,
      listed: JSON.parse(listed.text),
    });

    // The fleet's own secret, which is the one value here that could be spent by anybody who read it.
    expect(everything).not.toContain(SECRET_KEY);
    // And the password 팝빌 required at join time, which is minted inside one request and forgotten.
    const joinCall = seen.find(
      (call) => call.path === "/Join" && call.method === "POST",
    );
    const password = (joinCall?.body as Record<string, string> | undefined)
      ?.Password;
    expect(password).toBeTruthy();
    expect(everything).not.toContain(password);
  });

  test("the trail names the connector and which service, never the business number", async () => {
    const userId = await createUser();
    await join(userId);

    const joined = auditRows.find(
      (row) => row.payload?.change === "tax_member_joined",
    );
    expect(joined?.payload?.server).toBe("tax-invoice");
    // Said out loud rather than left to be assumed: an invoice issued from here reaches nobody.
    expect(joined?.payload?.service).toBe("test");
    expect(JSON.stringify(auditRows)).not.toContain(BUSINESS_NUMBER);
    expect(JSON.stringify(auditRows)).not.toContain(CONTACT_PHONE);
  });

  test("the person's own card shows their own business number, and the card only", async () => {
    const userId = await createUser();
    const { status, tools } = await join(userId);
    const listed = await tools.callTool(
      { url: apiUrl, actorId: userId, botId: "bot-1" },
      "taxinvoice_list",
      { from: "20260801", to: "20260901" },
    );

    // It is theirs, they typed it, and it is on every invoice they have ever issued — so the card
    // shows it. A tool result is read into a model's context and then into a transcript, so that
    // does not.
    expect(status.businessNumber).toBe(BUSINESS_NUMBER);
    expect(listed.text).not.toContain(CONTACT_EMAIL);
    expect(listed.text).not.toContain(CONTACT_PHONE);
  });
});
