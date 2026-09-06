import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import {
  lafAlimtalkTemplates,
  lafPartnerConnections,
  users,
} from "../src/db/schema";
import { createAlimtalkConnect } from "../src/plugins/alimtalk/connect";
import { solapiAuthorization } from "../src/plugins/alimtalk/solapi";
import { STANDARD_TEMPLATES } from "../src/plugins/alimtalk/templates";
import {
  ALIMTALK_TOOLS,
  createAlimtalkTools,
} from "../src/plugins/alimtalk/tools";
import { catalogueEntry } from "../src/plugins/catalogue";
import { createPartnerConnections } from "../src/plugins/partner-connections";
import { TEST_POOL } from "./support/database";

/**
 * 알림톡, against a 솔라피 THAT IS NOT 솔라피.
 *
 * WHY A FAKE VENDOR ON A REAL SOCKET rather than a stubbed `fetch`. The properties worth pinning
 * here are all about bytes: the shape of the HMAC header, the field names in a channel registration,
 * whether a variable arrives spelled `#{내용}` or `내용`. A stub that intercepts `fetch` asserts what
 * this code MEANT to send; a server on a port asserts what actually left, headers and all, and it is
 * the only way to be sure `AbortSignal.timeout` and the JSON handling are in the path too.
 *
 * AND THE REAL VENDOR IS NEVER CONTACTED. `LAF_ALIMTALK_BASE_URL` points at 127.0.0.1 on an
 * ephemeral port for the whole file. A test that reached api.solapi.com would need a key, would cost
 * money, and would send a message to somebody.
 *
 * THE LAST TEST IS THE ONE THAT MATTERS MOST. Everything a connect touches — the row, the trail, the
 * status a screen draws, the answer a Bot reads — is serialised whole and searched for the phone
 * number and the 인증번호. The same rule the demonstration recorder and the audit fingerprint keep:
 * record that something happened, never the value somebody typed.
 */

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const testPrefix = `partner-alimtalk-${randomUUID()}`;
const createdUserIds: string[] = [];

/** Values no real business has, so their absence from a record is a real absence. */
const MANAGER_PHONE = "01098765432";
const VERIFICATION_CODE = "778899";
const SENDER_KEY = "KA01PF-not-a-real-sender-key";

/** What the fake vendor was asked, in the order it was asked. */
type Seen = {
  path: string;
  method: string;
  authorization: string;
  body: Record<string, unknown> | null;
};
let seen: Seen[] = [];
/** Per-path answers a test can bend without restarting the server. */
let templateStatus = "PENDING";

let vendor: ReturnType<typeof Bun.serve>;
let baseUrl = "";

const auditRows: AuditEventInput[] = [];
const auditStore: AuditStore = {
  insert: async (event) => {
    auditRows.push(event);
  },
};

const environment = () => ({
  LAF_ALIMTALK_API_KEY: "TESTKEY01:TESTSECRET02",
  LAF_ALIMTALK_BASE_URL: baseUrl,
});

beforeAll(() => {
  vendor = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const body =
        request.method === "POST"
          ? ((await request.json().catch(() => null)) as Record<
              string,
              unknown
            > | null)
          : null;
      seen.push({
        path: url.pathname,
        method: request.method,
        authorization: request.headers.get("authorization") ?? "",
        body,
      });

      if (url.pathname === "/kakao/v1/channels/token") {
        return Response.json({ ok: true });
      }
      if (url.pathname === "/kakao/v1/channels") {
        if (body?.token !== VERIFICATION_CODE) {
          return Response.json(
            { errorCode: "ValidationError", errorMessage: "bad code" },
            { status: 400 },
          );
        }
        return Response.json({
          channelId: SENDER_KEY,
          searchId: body?.searchId,
        });
      }
      if (url.pathname === "/kakao/v1/templates" && request.method === "POST") {
        return Response.json({
          templateId: `tpl-${String(body?.name ?? "")}`,
          status: templateStatus,
        });
      }
      if (url.pathname.startsWith("/kakao/v1/templates/")) {
        return Response.json({
          templateId: decodeURIComponent(
            url.pathname.replace("/kakao/v1/templates/", ""),
          ),
          status: templateStatus,
        });
      }
      if (url.pathname === "/messages/v4/send") {
        return Response.json({ statusCode: "2000", messageId: "msg-1" });
      }
      return Response.json({ errorMessage: "no such route" }, { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${vendor.port}`;
});

afterAll(async () => {
  vendor.stop(true);
  await database.$client.close();
});

afterEach(async () => {
  seen = [];
  auditRows.length = 0;
  templateStatus = "PENDING";
  for (const userId of createdUserIds.splice(0)) {
    await database
      .delete(lafAlimtalkTemplates)
      .where(eq(lafAlimtalkTemplates.userId, userId));
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
    name: "AlimTalk Test User",
    emailVerified: true,
  });
  createdUserIds.push(id);
  return id;
}

function connectors() {
  const partners = createPartnerConnections({ database, auditStore });
  return {
    partners,
    connect: createAlimtalkConnect(
      { database, auditStore },
      partners,
      environment(),
    ),
    tools: createAlimtalkTools(partners, environment()),
  };
}

/** A connected channel with every template approved, which is the state a send needs. */
async function connectApproved(userId: string) {
  templateStatus = "APPROVED";
  const { connect, tools, partners } = connectors();
  await connect.requestCode({
    userId,
    searchId: "미소상회",
    phone: MANAGER_PHONE,
  });
  const status = await connect.confirmCode({
    userId,
    searchId: "미소상회",
    phone: MANAGER_PHONE,
    code: VERIFICATION_CODE,
  });
  return { status, tools, partners, connect };
}

describe("the 솔라피 wire", () => {
  test("signs every call with a fresh HMAC over the date and the salt", async () => {
    const userId = await createUser();
    const { connect } = connectors();
    await connect.requestCode({
      userId,
      searchId: "@미소상회",
      phone: MANAGER_PHONE,
    });

    const header = seen[0]?.authorization ?? "";
    // The scheme, and the four named parts. Pinned as a shape rather than a string because three of
    // the four are different on every call — which is what makes a captured header useless later.
    expect(header).toMatch(
      /^HMAC-SHA256 apiKey=TESTKEY01, date=\S+, salt=[0-9a-f]{32}, signature=[0-9a-f]{64}$/,
    );

    // And it is the signature the same inputs produce, so a rewrite of the canonical string that
    // still produced a well-formed header would fail here rather than at the vendor.
    const date = /date=([^,]+)/.exec(header)?.[1] ?? "";
    const salt = /salt=([^,]+)/.exec(header)?.[1] ?? "";
    const rebuilt = await solapiAuthorization(
      {
        apiKey: "TESTKEY01",
        apiSecret: "TESTSECRET02",
        baseUrl,
      },
      () => new Date(date),
      () => salt,
    );
    expect(rebuilt).toBe(header);
  });

  test("asks for the code with the search id the person typed, @ added", async () => {
    const userId = await createUser();
    const { connect } = connectors();
    // Typed without the leading mark, which about half of people do and which is unambiguous to add.
    const { searchId } = await connect.requestCode({
      userId,
      searchId: "미소상회",
      phone: MANAGER_PHONE,
    });

    expect(searchId).toBe("@미소상회");
    expect(seen[0]?.path).toBe("/kakao/v1/channels/token");
    expect(seen[0]?.body).toEqual({
      searchId: "@미소상회",
      phoneNumber: MANAGER_PHONE,
    });
  });

  test("registers the channel with the code, and reads the sender key back", async () => {
    const userId = await createUser();
    const { connect, partners } = connectors();
    await connect.confirmCode({
      userId,
      searchId: "@미소상회",
      phone: MANAGER_PHONE,
      code: VERIFICATION_CODE,
    });

    const registration = seen.find(
      (call) => call.path === "/kakao/v1/channels",
    );
    expect(registration?.body).toEqual({
      searchId: "@미소상회",
      phoneNumber: MANAGER_PHONE,
      token: VERIFICATION_CODE,
    });

    // The sender key is what every send is addressed with, and reading it from the wrong field
    // would leave a connection that looks finished and can send nothing.
    const held = await partners.find("kakao-alimtalk", userId);
    expect(held?.account).toBe(SENDER_KEY);
  });

  test("a wrong code is the person mistyping, not an outage", async () => {
    const userId = await createUser();
    const { connect } = connectors();
    const refused = await connect
      .confirmCode({
        userId,
        searchId: "@미소상회",
        phone: MANAGER_PHONE,
        code: "000000",
      })
      .catch((error: unknown) => error);

    // 400 and a code of its own: a person who can retype the number must not be shown the sentence
    // for a vendor that is down.
    expect((refused as { fact: string; status: number }).fact).toBe(
      "laf:alimtalk_code_refused",
    );
    expect((refused as { status: number }).status).toBe(400);
    // And nothing was written: a channel nobody proved they manage is not this person's.
    const [row] = await database
      .select()
      .from(lafPartnerConnections)
      .where(eq(lafPartnerConnections.userId, userId));
    expect(row).toBeUndefined();
  });

  test("registers LAF's four templates and reports them as still being inspected", async () => {
    const userId = await createUser();
    const { connect } = connectors();
    const status = await connect.confirmCode({
      userId,
      searchId: "@미소상회",
      phone: MANAGER_PHONE,
      code: VERIFICATION_CODE,
    });

    const registered = seen.filter(
      (call) => call.path === "/kakao/v1/templates" && call.method === "POST",
    );
    expect(registered).toHaveLength(STANDARD_TEMPLATES.length);
    // The body is the contract: 카카오 compares a send against the approved text, so what goes up
    // has to be the template's own string rather than anything assembled at send time.
    expect(registered[0]?.body?.content).toBe(STANDARD_TEMPLATES[0]?.content);
    expect(registered[0]?.body?.channelId).toBe(SENDER_KEY);

    // Registration is not approval, and the card must not say 사용 가능 for a template 카카오 has
    // not looked at yet.
    expect(status.connected).toBe(true);
    expect(status.templates.every((row) => row.status === "pending")).toBe(
      true,
    );
  });
});

describe("what a Bot may send", () => {
  test("the send tool names every blank of every customer template, so a model need not guess", () => {
    const send = ALIMTALK_TOOLS.find((tool) => tool.name === "alimtalk_send");
    const schema = send?.inputSchema as {
      properties: { variables: { description: string } };
    };
    const description = schema.properties.variables.description;
    // Measured 2026-09-06: without the names the model invented 예약일·예약시간·요청사항 for a
    // template whose blanks are 상호·고객명·일시·인원, and two approvals were spent on nothing.
    for (const entry of STANDARD_TEMPLATES) {
      if (entry.audience !== "customer") continue;
      expect(description).toContain(entry.code);
      for (const name of entry.variables) {
        // Bare, the way a model is asked to key them; `#{}` is the vendor's spelling, not the schema's.
        expect(description).toContain(name.replace(/^#\{(.*)\}$/, "$1"));
        expect(description).not.toContain(name);
      }
    }
  });

  test("refuses a send while the template is still being inspected", async () => {
    const userId = await createUser();
    const { connect } = connectors();
    await connect.confirmCode({
      userId,
      searchId: "@미소상회",
      phone: MANAGER_PHONE,
      code: VERIFICATION_CODE,
    });
    const { tools } = connectors();

    const refused = await tools
      .callTool(
        { url: baseUrl, actorId: userId, botId: "bot-1" },
        "alimtalk_send",
        {
          to: "010-1111-2222",
          template: "laf_reservation",
          variables: {
            상호: "미소상회",
            고객명: "김손님",
            일시: "3시",
            인원: "2",
          },
        },
      )
      .catch((error: unknown) => error);

    expect((refused as { message: string }).message).toBe(
      "laf:alimtalk_template_pending",
    );
    // And nothing left the building: the refusal is ours, before the vendor is asked.
    expect(seen.some((call) => call.path === "/messages/v4/send")).toBe(false);
  });

  test("sends an approved template with the variables spelled the way 카카오 wants", async () => {
    const userId = await createUser();
    const { tools } = await connectApproved(userId);
    seen = [];

    const result = await tools.callTool(
      { url: baseUrl, actorId: userId, botId: "bot-1" },
      "alimtalk_send",
      {
        to: "010-1111-2222",
        template: "laf_reservation",
        // The model is asked for plain names, because a schema full of `#{}` is one it fills in
        // wrongly half the time. Both spellings go in and exactly one goes out.
        variables: {
          상호: "미소상회",
          고객명: "김손님",
          일시: "3시",
          인원: "2",
        },
      },
    );

    const sent = seen.find((call) => call.path === "/messages/v4/send");
    const message = (sent?.body as { message?: Record<string, unknown> })
      ?.message;
    const kakao = message?.kakaoOptions as Record<string, unknown>;
    expect(kakao.variables).toEqual({
      "#{상호}": "미소상회",
      "#{고객명}": "김손님",
      "#{일시}": "3시",
      "#{인원}": "2",
    });
    expect(kakao.pfId).toBe(SENDER_KEY);
    // Hyphens dropped: every phone in the country is written with them somewhere.
    expect(message?.to).toBe("01011112222");
    // The SMS fallback is off. It would arrive as an ordinary text from a number the customer does
    // not recognise, and it costs money per message.
    expect(kakao.disableSms).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ sent: true, messageId: "msg-1" });
  });

  test("refuses a send that is missing one of the template's blanks", async () => {
    const userId = await createUser();
    const { tools } = await connectApproved(userId);
    seen = [];

    const refused = await tools
      .callTool(
        { url: baseUrl, actorId: userId, botId: "bot-1" },
        "alimtalk_send",
        {
          to: "01011112222",
          template: "laf_reservation",
          variables: { 상호: "미소상회", 고객명: "김손님" },
        },
      )
      .catch((error: unknown) => error);

    // Checked here rather than at the vendor: 카카오 answers a missing variable with a sentence
    // about the body not matching, which says nothing about the field a model forgot.
    expect((refused as { message: string }).message).toBe(
      "laf:alimtalk_variables_missing",
    );
    expect(seen.some((call) => call.path === "/messages/v4/send")).toBe(false);
  });

  test("a Bot may not send the owner's own notifications", async () => {
    const userId = await createUser();
    const { tools } = await connectApproved(userId);

    const refused = await tools
      .callTool(
        { url: baseUrl, actorId: userId, botId: "bot-1" },
        "alimtalk_send",
        {
          to: "01011112222",
          template: "laf_approval",
          variables: { 내용: "무엇이든", 시각: "지금" },
        },
      )
      .catch((error: unknown) => error);

    // A Bot that could send `laf_approval` could tell its owner it was waiting for an approval it
    // never asked for — a Bot writing the notification that decides whether it gets looked at.
    expect((refused as { message: string }).message).toBe(
      "laf:alimtalk_template_not_for_customers",
    );
  });

  test("a call nobody is attributed to picks up nobody's channel", async () => {
    const userId = await createUser();
    await connectApproved(userId);
    const { tools } = connectors();

    const refused = await tools
      .callTool(
        { url: baseUrl, actorId: "", botId: "bot-1" },
        "alimtalk_send",
        {
          to: "01011112222",
          template: "laf_reservation",
          variables: {},
        },
      )
      .catch((error: unknown) => error);

    expect((refused as { message: string }).message).toBe(
      "laf:alimtalk_no_actor",
    );
  });

  test("somebody else's channel is not this person's to send from", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    await connectApproved(owner);
    const { tools } = connectors();

    const refused = await tools
      .callTool(
        { url: baseUrl, actorId: stranger, botId: "bot-1" },
        "alimtalk_send",
        {
          to: "01011112222",
          template: "laf_reservation",
          variables: { 상호: "x", 고객명: "y", 일시: "z", 인원: "1" },
        },
      )
      .catch((error: unknown) => error);

    expect((refused as { message: string }).message).toBe(
      "laf:alimtalk_not_connected",
    );
  });

  test("the send is an external effect the catalogue puts a floor under", () => {
    // The floor is the reviewed catalogue's word for a curated entry (`call.ts`), so it has to be
    // HERE and not only in the tool's annotations, which that path deliberately ignores.
    expect(catalogueEntry("kakao-alimtalk")?.guardedTools?.alimtalk_send).toBe(
      "external",
    );
  });
});

describe("disconnecting", () => {
  test("takes the channel and its templates, and says nothing was revoked at 카카오", async () => {
    const userId = await createUser();
    const { connect } = await connectApproved(userId);
    auditRows.length = 0;

    expect(await connect.disconnect(userId)).toEqual({ disconnected: true });

    const rows = await database
      .select()
      .from(lafPartnerConnections)
      .where(eq(lafPartnerConnections.userId, userId));
    const templates = await database
      .select()
      .from(lafAlimtalkTemplates)
      .where(eq(lafAlimtalkTemplates.userId, userId));
    expect(rows).toHaveLength(0);
    // Template rows left behind would tell the next connect that LAF's templates are registered
    // under a 발신프로필 nothing here can name any more.
    expect(templates).toHaveLength(0);

    const row = auditRows.find(
      (event) => event.eventType === "mcp.account_disconnected",
    );
    expect(row?.payload?.vendorRevoked).toBe(false);
  });
});

describe("what is written down", () => {
  test("no phone number and no 인증번호 survives a whole connect", async () => {
    const userId = await createUser();
    const { status, tools } = await connectApproved(userId);
    const result = await tools.callTool(
      { url: baseUrl, actorId: userId, botId: "bot-1" },
      "alimtalk_templates",
      {},
    );

    const rows = await database
      .select()
      .from(lafPartnerConnections)
      .where(eq(lafPartnerConnections.userId, userId));

    /*
     * EVERYTHING, SERIALISED AND SEARCHED. The trail, the status a screen draws and the answer a
     * model reads, in one string. The 인증번호 is spent inside one request and must survive none of
     * them; the manager's number is deliberately kept on the ROW — it is where their own approval
     * buzz goes — and must reach no other one of the four.
     */
    const trail = JSON.stringify(auditRows);
    const surface = JSON.stringify({
      status,
      templates: JSON.parse(result.text),
    });

    expect(trail).not.toContain(VERIFICATION_CODE);
    expect(surface).not.toContain(VERIFICATION_CODE);
    expect(JSON.stringify(rows)).not.toContain(VERIFICATION_CODE);

    expect(trail).not.toContain(MANAGER_PHONE);
    expect(surface).not.toContain(MANAGER_PHONE);

    // The 발신프로필 key decides whose channel a message leaves from. It never crosses back to a
    // browser and never lands in the trail; the card shows the 검색용 아이디 instead.
    expect(trail).not.toContain(SENDER_KEY);
    expect(surface).not.toContain(SENDER_KEY);
    expect(status.searchId).toBe("@미소상회");
  });

  test("the trail names the connector and the channel, never the sender key", async () => {
    const userId = await createUser();
    await connectApproved(userId);

    const connected = auditRows.find(
      (event) => event.eventType === "mcp.account_connected",
    );
    expect(connected?.payload?.scope).toBe("channel:@미소상회");
    expect(connected?.payload?.server).toBe("kakao-alimtalk");
  });
});
