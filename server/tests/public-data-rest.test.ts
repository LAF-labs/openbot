import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { catalogueEntry, classifyTool } from "../src/plugins/catalogue";
import {
  BIDS_URL,
  createPublicDataRuntime,
  createPublicDataTransport,
  kstStamp,
  plainText,
  PROGRAMS_URL,
  PUBLIC_DATA_KEY,
  PUBLIC_DATA_TOOLS,
  type PublicDataStore,
  RAW_RESPONSE_CAP_CHARS,
} from "../src/plugins/public-data-rest";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  deploymentKeysFrom,
  entryIsOffered,
  keyLookupOver,
  NO_DEPLOYMENT_KEYS,
} from "../src/plugins/shared-clients";
import {
  type GrantedPlugins,
  PluginRefusedError,
  type PluginStore,
  type ServerRecord,
} from "../src/plugins/store";
import { stubFetch } from "./support/fetch";

/**
 * 나라장터 and 기업마당 on the fleet's one key, against the shapes the portal actually answers with.
 *
 * NO LIVE PORTAL, for the reasons the other adapters give and one of their own: a key is a quota,
 * and a suite that spent it would be a suite that fails on the day it matters. What is pinned here
 * is on this side of the wire — the URL that goes out (and above all that the key goes out
 * UNTOUCHED, since re-encoding it is the one mistake that makes every call fail), what a person's
 * answer reads like, and what a Bot is told when the portal says no.
 *
 * The fixtures are the live answers of 2026-09-06, cut down: 나라장터's `items: [...]`, 기업마당's
 * `items: {item: [...]}`, 나라장터's own error shape, and the gateway's XML refusal that arrives as
 * HTTP 200 whatever format was asked for.
 */

const ENCODED_KEY = "abc%2Bdef%3D%2Fghi";
/** Saturday 2026-09-06 12:00 KST, which is 03:00 UTC. */
const NOON_KST = () => new Date("2026-09-06T03:00:00Z");

type Asked = { url: string; init: RequestInit | undefined };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" },
  });

const bidsAnswer = (rows: unknown[], totalCount = rows.length) =>
  json({
    response: {
      header: { resultCode: "00", resultMsg: "정상" },
      body: { items: rows, numOfRows: 10, pageNo: 1, totalCount },
    },
  });

const programsAnswer = (rows: unknown[], totalCount = rows.length) =>
  json({
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
      body: { items: { item: rows }, numOfRows: 10, pageNo: 1, totalCount },
    },
  });

/** One row as 나라장터 sent it, the hundred other fields left out. */
const BID_ROW = {
  bidNtceNo: "R26BK01706792",
  bidNtceOrd: "000",
  bidNtceDt: "2026-09-01 00:30:02",
  bidNtceNm:
    "2026년 글로벌 OTT 플랫폼 연계형 제작지원(Rakuten Viki) 사업 조련의 여왕 의상 제작 및 운영 용역",
  ntceInsttNm: "주식회사 스튜디오 봄",
  dminsttNm: "주식회사 스튜디오 봄",
  cntrctCnclsMthdNm: "제한경쟁",
  bidClseDt: "2026-09-14 17:00:00",
  asignBdgtAmt: "240900000",
  presmptPrce: "219000000",
  pubPrcrmntClsfcNm: "온라인홍보및방송콘텐츠서비스",
  bidNtceDtlUrl:
    "https://www.g2b.go.kr/link/PNPE027_01/single/?bidPbancNo=R26BK01706792&bidPbancOrd=000",
  bidNtceUrl: "https://www.g2b.go.kr/link/PNPE027_01/single/?x",
};

const PROGRAM_ROW = {
  pblancNm: "[부산] 2026년 AX 에이지테크 시장확산 지원사업 모집 공고 ",
  pblancUrl:
    "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000126187",
  pblancId: "PBLN_000000000126187",
  jrsdInsttNm: "부산광역시",
  excInsttNm: "부산정보산업진흥원",
  bsnsSumryCn:
    '<p>부산정보산업진흥원에서는 지역 에이지테크(AgeTech) 기업의&nbsp;국내 시장 안착을 지원합니다.</p><p><br></p><p style="line-height: 1.8;">☞ 부산광역시 소재 중소기업</p>',
  pldirSportRealmLclasCodeNm: "기술",
  creatPnttm: "2026-09-04 13:52:35",
  reqstBeginEndDe: "2026-09-01 ~ 2026-09-11",
  trgetNm: "중소기업",
  hashtags: "기술,경영,부산",
};

/** A transport over a fake portal, and what it was asked. */
function transportAnswering(
  reply: (asked: Asked) => Response | Promise<Response>,
) {
  const asked: Asked[] = [];
  const transport = createPublicDataTransport({
    serviceKey: ENCODED_KEY,
    now: NOON_KST,
    fetchImpl: stubFetch(async (url, init) => {
      const record = { url: String(url), init };
      asked.push(record);
      return await reply(record);
    }),
  });
  return { transport, asked };
}

const connection = { url: "https://apis.data.go.kr" };

async function refusalOf(
  run: () => Promise<unknown>,
): Promise<PluginRefusedError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PluginRefusedError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/* ── the entry ───────────────────────────────────────────────────────────────────────────────── */

describe("the public-data entry", () => {
  const entry = catalogueEntry(PUBLIC_DATA_KEY)!;

  test("spends the fleet's key and nothing of anybody's", () => {
    expect(entry.auth).toEqual({ kind: "deployment-key", key: "data-go-kr" });
    // Both services live on the host the entry pins; the paths are the adapter's reviewed word.
    expect(entry.host).toBe(new URL(BIDS_URL).origin);
    expect(entry.host).toBe(new URL(PROGRAMS_URL).origin);
  });

  test("every tool is a declared read, and the catalogue agrees", async () => {
    expect(entry.writeTools).toEqual([]);
    expect(entry.guardedTools).toBeUndefined();
    const { transport } = transportAnswering(() => json({}));
    expect(transport.listNeedsCredential).toBe(false);
    const tools = await transport.listTools(connection);
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_bids",
      "search_support_programs",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({ readOnlyHint: true });
      // The reviewed word for a curated entry: an advertised tool not named as a write is a read.
      expect(classifyTool(entry, tool.name, true)).toBe("read");
    }
  });

  test("is listed exactly when the key is here", () => {
    expect(entryIsOffered(entry, NO_DEPLOYMENT_KEYS)).toBe(false);
    expect(
      entryIsOffered(entry, keyLookupOver({ "data-go-kr": ENCODED_KEY })),
    ).toBe(true);
    // Every other entry is untouched by the rule.
    expect(
      entryIsOffered(catalogueEntry("google-drive")!, NO_DEPLOYMENT_KEYS),
    ).toBe(true);
  });
});

/* ── the key ─────────────────────────────────────────────────────────────────────────────────── */

describe("the key as the environment carries it", () => {
  test("the encoded spelling is taken as-is, absent is nothing", () => {
    expect(deploymentKeysFrom({ DATA_GO_KR_SERVICE_KEY: ENCODED_KEY })).toEqual(
      {
        "data-go-kr": ENCODED_KEY,
      },
    );
    expect(deploymentKeysFrom({})).toEqual({});
    expect(deploymentKeysFrom({ DATA_GO_KR_SERVICE_KEY: "  " })).toEqual({});
  });

  test("the decoded spelling is refused by name", () => {
    expect(() =>
      deploymentKeysFrom({ DATA_GO_KR_SERVICE_KEY: "abc+def=/ghi" }),
    ).toThrow("DATA_GO_KR_SERVICE_KEY");
  });
});

/* ── 나라장터 ─────────────────────────────────────────────────────────────────────────────────── */

describe("search_bids", () => {
  test("puts the encoded key on the query string untouched, and asks for this week's 용역 by 게시일시", async () => {
    const { transport, asked } = transportAnswering(() => bidsAnswer([]));

    await transport.callTool(connection, "search_bids", {});

    const [call] = asked;
    // The whole point: `%2B` stays `%2B`. Through URLSearchParams it would have become `%252B`.
    expect(call?.url.startsWith(`${BIDS_URL}?serviceKey=${ENCODED_KEY}&`)).toBe(
      true,
    );
    const url = new URL(call?.url ?? "");
    expect(url.searchParams.get("inqryDiv")).toBe("1");
    expect(url.searchParams.get("type")).toBe("json");
    expect(url.searchParams.get("numOfRows")).toBe("10");
    // Seven days back to midnight KST, up to now in KST — the portal compares Korean wall clock.
    expect(url.searchParams.get("inqryBgnDt")).toBe("202608300000");
    expect(url.searchParams.get("inqryEndDt")).toBe("202609061200");
    expect(url.searchParams.has("bidNtceNm")).toBe(false);
    // The key rides on the query string, so a redirect must not be followed.
    expect(call?.init?.redirect).toBe("manual");
  });

  test("filters travel under the vendor's own names, and nothing can ask for more than ten rows", async () => {
    const { transport, asked } = transportAnswering(() => bidsAnswer([]));

    await transport.callTool(connection, "search_bids", {
      keyword: "청소",
      region: "11",
      industry: "1162",
      max: 50,
      days: 400,
    });

    const url = new URL(asked[0]?.url ?? "");
    expect(url.searchParams.get("bidNtceNm")).toBe("청소");
    expect(url.searchParams.get("prtcptLmtRgnCd")).toBe("11");
    expect(url.searchParams.get("indstrytyCd")).toBe("1162");
    expect(url.searchParams.get("numOfRows")).toBe("10");
    expect(url.searchParams.get("inqryBgnDt")).toBe("202608060000");
  });

  test("rows come back as the facts a person asks for: 공고명·기관·마감·금액·링크", async () => {
    const { transport } = transportAnswering(() => bidsAnswer([BID_ROW], 2236));

    const result = await transport.callTool(connection, "search_bids", {
      keyword: "용역",
    });

    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(false);
    const facts = JSON.parse(result.text) as {
      source: string;
      period: { from: string; to: string };
      filters: Record<string, string>;
      totalCount: number;
      shown: number;
      rows: Record<string, unknown>[];
    };
    expect(facts.source).toBe("나라장터");
    expect(facts.period).toEqual({ from: "2026-08-30", to: "2026-09-06" });
    expect(facts.filters).toEqual({ keyword: "용역" });
    expect(facts.totalCount).toBe(2236);
    expect(facts.shown).toBe(1);
    expect(facts.rows[0]).toEqual({
      noticeNo: "R26BK01706792-000",
      title: BID_ROW.bidNtceNm,
      agency: "주식회사 스튜디오 봄",
      postedAt: "2026-09-01 00:30:02",
      closesAt: "2026-09-14 17:00:00",
      budgetWon: 240_900_000,
      estimatedPriceWon: 219_000_000,
      method: "제한경쟁",
      category: "온라인홍보및방송콘텐츠서비스",
      url: BID_ROW.bidNtceDtlUrl,
    });
  });

  test("nothing found is said as a fact, never as an empty answer", async () => {
    // The portal's older services answer `items: ""` for none; this one answers `[]`. Both are none.
    const { transport } = transportAnswering(() =>
      json({
        response: {
          header: { resultCode: "00", resultMsg: "정상" },
          body: { items: "", numOfRows: 10, pageNo: 1, totalCount: 0 },
        },
      }),
    );

    const result = await transport.callTool(connection, "search_bids", {});

    expect(result.isError).toBe(false);
    expect(result.text).toContain('"totalCount":0');
    expect(result.text).toContain('"rows":[]');
  });

  test("나라장터's own error shape is a refusal that keeps its words", async () => {
    const { transport } = transportAnswering(() =>
      json({
        "nkoneps.com.response.ResponseError": {
          header: { resultCode: "06", resultMsg: "DATE Format 에러" },
        },
      }),
    );

    const refused = await refusalOf(() =>
      transport.callTool(connection, "search_bids", {}),
    );
    expect(refused.code).toBe("laf:public_data_refused");
    // The vendor's sentence goes to the trail (`mcp.call_failed`), the code goes to the Bot.
    expect(refused.message).toContain("06 DATE Format 에러");
  });

  test("the gateway's XML refusal, sent as HTTP 200, names the reason an operator needs", async () => {
    const { transport } = transportAnswering(
      () =>
        new Response(
          "<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>",
          { status: 200, headers: { "content-type": "text/xml" } },
        ),
    );

    const refused = await refusalOf(() =>
      transport.callTool(connection, "search_bids", {}),
    );
    expect(refused.code).toBe("laf:public_data_refused");
    expect(refused.message).toContain(
      "gateway 30 SERVICE_KEY_IS_NOT_REGISTERED_ERROR",
    );
  });

  test("an HTTP failure, a timeout and a page of HTML are three different facts", async () => {
    const failing = transportAnswering(() => json({ error: "down" }, 500));
    expect(
      (
        await refusalOf(() =>
          failing.transport.callTool(connection, "search_bids", {}),
        )
      ).code,
    ).toBe("laf:public_data_refused");

    const timingOut = transportAnswering(() => {
      throw Object.assign(new Error("The operation timed out."), {
        name: "TimeoutError",
      });
    });
    expect(
      (
        await refusalOf(() =>
          timingOut.transport.callTool(connection, "search_bids", {}),
        )
      ).code,
    ).toBe("laf:public_data_unreachable");

    const portal = transportAnswering(
      () => new Response("<html><body>점검 중</body></html>", { status: 200 }),
    );
    expect(
      (
        await refusalOf(() =>
          portal.transport.callTool(connection, "search_bids", {}),
        )
      ).code,
    ).toBe("laf:public_data_unreadable");
  });

  test("an answer past the raw cap is refused rather than half-read", async () => {
    const { transport } = transportAnswering(
      () =>
        new Response("x".repeat(RAW_RESPONSE_CAP_CHARS + 1), { status: 200 }),
    );
    expect(
      (await refusalOf(() => transport.callTool(connection, "search_bids", {})))
        .code,
    ).toBe("laf:public_data_too_large");
  });
});

/* ── 기업마당 ─────────────────────────────────────────────────────────────────────────────────── */

describe("search_support_programs", () => {
  test("asks 기업마당 through the portal, as JSON, with the tag and field filters", async () => {
    const { transport, asked } = transportAnswering(() => programsAnswer([]));

    await transport.callTool(connection, "search_support_programs", {
      hashtags: "서울,소상공인",
      field: "02",
      max: 5,
    });

    const [call] = asked;
    expect(
      call?.url.startsWith(`${PROGRAMS_URL}?serviceKey=${ENCODED_KEY}&`),
    ).toBe(true);
    const url = new URL(call?.url ?? "");
    // `dataType`, not `type`: the other spelling answers XML on this service. Measured.
    expect(url.searchParams.get("dataType")).toBe("json");
    expect(url.searchParams.get("hashtags")).toBe("서울,소상공인");
    expect(url.searchParams.get("searchLclasId")).toBe("02");
    expect(url.searchParams.get("numOfRows")).toBe("5");
  });

  test("a programme is 공고명·소관기관·신청기간·대상·링크, with the 사업개요 as one plain line", async () => {
    const { transport } = transportAnswering(() =>
      programsAnswer([PROGRAM_ROW], 1506),
    );

    const result = await transport.callTool(
      connection,
      "search_support_programs",
      {},
    );

    const facts = JSON.parse(result.text) as {
      source: string;
      totalCount: number;
      rows: Record<string, unknown>[];
    };
    expect(facts.source).toBe("기업마당");
    expect(facts.totalCount).toBe(1506);
    expect(facts.rows[0]).toEqual({
      id: "PBLN_000000000126187",
      title: "[부산] 2026년 AX 에이지테크 시장확산 지원사업 모집 공고",
      agency: "부산광역시",
      executor: "부산정보산업진흥원",
      field: "기술",
      period: "2026-09-01 ~ 2026-09-11",
      target: "중소기업",
      postedAt: "2026-09-04 13:52:35",
      summary:
        "부산정보산업진흥원에서는 지역 에이지테크(AgeTech) 기업의 국내 시장 안착을 지원합니다. ☞ 부산광역시 소재 중소기업",
      url: PROGRAM_ROW.pblancUrl,
    });
  });

  test("a tool that does not exist is refused by name", async () => {
    const { transport } = transportAnswering(() => programsAnswer([]));
    expect(
      (
        await refusalOf(() =>
          transport.callTool(connection, "search_awards", {}),
        )
      ).code,
    ).toBe("laf:public_data_unknown_tool");
  });
});

describe("the small parts", () => {
  test("a KST stamp is Korean wall clock, whatever the process clock is", () => {
    // 15:30 UTC is half past midnight the next day in Seoul.
    expect(kstStamp(new Date("2026-09-05T15:30:00Z"))).toBe("202609060030");
    expect(kstStamp(new Date("2026-09-05T15:30:00Z"), "0000")).toBe(
      "202609060000",
    );
  });

  test("a 사업개요 loses its markup and keeps its words", () => {
    expect(plainText('<p>a&nbsp;b</p><p style="x">c &amp; d</p>')).toBe(
      "a b c & d",
    );
  });
});

/* ── the runtime: boot, and a Bot that arrives later ─────────────────────────────────────────── */

type StoreCalls = {
  ensured: string[];
  refreshed: string[];
  approved: string[];
  granted: { ref: string; botId: string }[];
  revoked: { ref: string; botId: string }[];
  removed: string[];
};

const noCalls = (): StoreCalls => ({
  ensured: [],
  refreshed: [],
  approved: [],
  granted: [],
  revoked: [],
  removed: [],
});

const REFS = PUBLIC_DATA_TOOLS.map((tool) => `${PUBLIC_DATA_KEY}/${tool.name}`);

/** A store that remembers what it was asked, with what each Bot already holds and which rows exist. */
function fakeStore(input: {
  calls: StoreCalls;
  rows?: string[];
  holding?: Record<string, string[]>;
  paused?: number;
}): PublicDataStore {
  const granted = (botId: string): GrantedPlugins => ({
    tools: (input.holding?.[botId] ?? []).map((ref) => ({
      ref,
      toolName: ref,
      description: "",
      inputSchema: {},
    })),
    skills: [],
  });
  return {
    ensureCatalogueServer: async ({ key }) => {
      input.calls.ensured.push(key);
      return { url: "https://apis.data.go.kr", added: true };
    },
    refreshTools: async (serverId) => {
      input.calls.refreshed.push(serverId);
      return { tools: 2, ...(input.paused ? { paused: input.paused } : {}) };
    },
    approveToolDefinition: async (_serverId, toolName) => {
      input.calls.approved.push(toolName);
      return true;
    },
    grant: async (_kind, ref, botId) => {
      input.calls.granted.push({ ref, botId });
    },
    revoke: async (_kind, ref, botId) => {
      input.calls.revoked.push({ ref, botId });
    },
    removeServer: async (serverId) => {
      input.calls.removed.push(serverId);
    },
    listServers: async () =>
      (input.rows ?? []).map((id) => ({ id }) as ServerRecord),
    listForAgent: async (botId) => granted(botId),
  };
}

describe("what a deployment does with the key at boot", () => {
  test("no key: nothing is assembled, and a row left over from a key is taken back", async () => {
    const runtime = createPublicDataRuntime({
      keys: {},
      listBots: async () => ["bot-a", "bot-b"],
    });
    expect(runtime.configured).toBe(false);
    expect(runtime.transports).toEqual({});
    expect(runtime.keys("data-go-kr")).toBeNull();

    const calls = noCalls();
    await runtime.reconcile(
      fakeStore({
        calls,
        rows: [PUBLIC_DATA_KEY, "notion"],
        holding: { "bot-a": REFS },
      }),
      "deployment",
    );

    // The grants first, then the row — the partner order, so nothing holds a grant on a live tool.
    expect(calls.revoked).toEqual(REFS.map((ref) => ({ ref, botId: "bot-a" })));
    expect(calls.removed).toEqual([PUBLIC_DATA_KEY]);
    expect(calls.ensured).toEqual([]);
    expect(calls.granted).toEqual([]);
  });

  test("no key and no row: boot touches nothing", async () => {
    const runtime = createPublicDataRuntime({
      keys: {},
      listBots: async () => ["bot-a"],
    });
    const calls = noCalls();
    await runtime.reconcile(
      fakeStore({ calls, rows: ["notion"] }),
      "deployment",
    );
    expect(calls).toEqual(noCalls());
  });

  test("the key: the row, the tools, and a grant on each for every Bot — only the missing ones", async () => {
    const runtime = createPublicDataRuntime({
      keys: { "data-go-kr": ENCODED_KEY },
      listBots: async () => ["bot-a", "bot-b"],
    });
    expect(runtime.configured).toBe(true);
    expect(Object.keys(runtime.transports)).toEqual(["data-go-kr"]);

    const calls = noCalls();
    await runtime.reconcile(
      fakeStore({ calls, holding: { "bot-a": [REFS[0]!] } }),
      "deployment",
    );

    expect(calls.ensured).toEqual([PUBLIC_DATA_KEY]);
    expect(calls.refreshed).toEqual([PUBLIC_DATA_KEY]);
    expect(calls.approved).toEqual([]);
    // A boot must not rewrite ten rows of trail: bot-a already held the first tool.
    expect(calls.granted).toEqual([
      { ref: REFS[1]!, botId: "bot-a" },
      { ref: REFS[0]!, botId: "bot-b" },
      { ref: REFS[1]!, botId: "bot-b" },
    ]);
    expect(calls.revoked).toEqual([]);
    expect(calls.removed).toEqual([]);
  });

  test("a shipped definition that changed is accepted as this repository's own word", async () => {
    // The refresh pauses a changed tool for review, which is right for somebody else's server and
    // a dead tool here: nobody presses Approve on every shop owner's machine after an upgrade.
    const runtime = createPublicDataRuntime({
      keys: { "data-go-kr": ENCODED_KEY },
      listBots: async () => [],
    });
    const calls = noCalls();
    await runtime.reconcile(fakeStore({ calls, paused: 2 }), "deployment");
    expect(calls.approved).toEqual(["search_bids", "search_support_programs"]);
  });

  test("a Bot made after boot is offered the tools on the spot, and without the key it is not", async () => {
    const calls = noCalls();
    const store = fakeStore({ calls });

    await createPublicDataRuntime({
      keys: { "data-go-kr": ENCODED_KEY },
      listBots: async () => [],
    }).offerTo(store, "bot-new", "deployment");
    expect(calls.granted).toEqual(
      REFS.map((ref) => ({ ref, botId: "bot-new" })),
    );

    const untouched = noCalls();
    await createPublicDataRuntime({
      keys: {},
      listBots: async () => [],
    }).offerTo(fakeStore({ calls: untouched }), "bot-new", "deployment");
    expect(untouched.granted).toEqual([]);
  });

  test("a store that fails does not fail the boot", async () => {
    const runtime = createPublicDataRuntime({
      keys: { "data-go-kr": ENCODED_KEY },
      listBots: async () => ["bot-a"],
    });
    const broken = {
      ...fakeStore({ calls: noCalls() }),
      listServers: async () => {
        throw new Error("database gone");
      },
    };
    await expect(
      runtime.reconcile(broken, "deployment"),
    ).resolves.toBeUndefined();
  });
});

/* ── hidden without the key, on the one listing that carries the catalogue ───────────────────── */

function actingAs(
  role: "user" | "admin",
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: "person-1",
      email: "person@example.test",
      role,
    });
    await next();
  };
}

function listingApp(role: "user" | "admin", keys: Record<string, string>) {
  const added: string[] = [];
  const store = {
    listServers: async () => [],
    listSkills: async () => [],
    addServer: async ({ key }: { key: string }) => {
      added.push(key);
      return { id: key } as ServerRecord;
    },
  } as unknown as PluginStore;
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/plugins",
    createPluginRoutes(
      store,
      actingAs(role),
      { encryptionKey: "k", personHasAccess: async () => true },
      keyLookupOver(keys as Partial<Record<"data-go-kr", string>>),
    ),
  );
  return { app, added };
}

describe("the catalogue a screen is sent", () => {
  test("leaves the entry out until the key is here, and lists it with its own auth kind after", async () => {
    const without = listingApp("user", {});
    const listed = (await (
      await without.app.request("/api/plugins")
    ).json()) as {
      catalogue: { key: string; auth: string }[];
    };
    expect(listed.catalogue.map((entry) => entry.key)).not.toContain(
      PUBLIC_DATA_KEY,
    );
    // Nothing else moved: the rule is about this one kind of entry.
    expect(listed.catalogue.map((entry) => entry.key)).toContain(
      "kakao-alimtalk",
    );

    const withKey = listingApp("user", { "data-go-kr": ENCODED_KEY });
    const offered = (await (
      await withKey.app.request("/api/plugins")
    ).json()) as {
      catalogue: { key: string; auth: string }[];
    };
    expect(
      offered.catalogue.find((entry) => entry.key === PUBLIC_DATA_KEY),
    ).toEqual(expect.objectContaining({ auth: "deployment-key" }));
  });

  test("adding the entry by hand on a VM without the key is a 503, not a row", async () => {
    const without = listingApp("admin", {});
    const answered = await without.app.request("/api/plugins/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: PUBLIC_DATA_KEY }),
    });
    expect(answered.status).toBe(503);
    expect(((await answered.json()) as { code: string }).code).toBe(
      "laf:deployment_key_missing",
    );
    expect(without.added).toEqual([]);

    const withKey = listingApp("admin", { "data-go-kr": ENCODED_KEY });
    const accepted = await withKey.app.request("/api/plugins/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: PUBLIC_DATA_KEY }),
    });
    expect(accepted.status).toBe(200);
    expect(withKey.added).toEqual([PUBLIC_DATA_KEY]);
  });
});
