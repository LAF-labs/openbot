import { describe, expect, test } from "bun:test";
import { toolResultText } from "../../shared/prompt/tool-results.ko";
import {
  CORE_TOOL_NAMES,
  deferredToolsText,
  exposureOf,
  WEB_SEARCH_TOOL_NAME,
} from "../../shared/tools/bridge";
import { catalogueEntry, classifyTool } from "../src/plugins/catalogue";
import { createDeploymentKeyRuntime } from "../src/plugins/deployment-key-runtime";
import { DEPLOYMENT_KEY_SERVICES } from "../src/plugins/deployment-key-services";
import {
  PUBLIC_DATA_KEY,
  PUBLIC_DATA_TOOLS,
} from "../src/plugins/public-data-rest";
import {
  DEPLOYMENT_KEY_ENV,
  deploymentKeysFrom,
  entryIsOffered,
  keyLookupOver,
  NO_DEPLOYMENT_KEYS,
} from "../src/plugins/shared-clients";
import {
  type GrantedPlugins,
  PluginRefusedError,
  type ServerRecord,
} from "../src/plugins/store";
import {
  createWebSearchTransport,
  DAILY_SEARCH_CAP,
  MAX_QUERIES,
  MAX_RESULTS,
  SEARCH_URL,
  WEB_SEARCH_KEY,
  WEB_SEARCH_TOOLS,
} from "../src/plugins/web-search-rest";
import { stubFetch } from "./support/fetch";

/**
 * The web, searched on the fleet's one key — against the shapes the vendor actually answers with.
 *
 * NO LIVE VENDOR, for the reason the public-data suite gives: a key is money, and a suite that
 * spent it would cost something every time anybody ran the gate. What is pinned here is on this side
 * of the wire: what goes out (to the one pinned address, with the key in a header and nowhere
 * else), what a Bot reads back, and what it is told when the vendor says no — each kind of no its
 * own sentence, because a Bot told "try again" in front of a refused key tries again for ever.
 *
 * The fixtures are the live answers of 2026-10-02, cut down: `{id, results[]}` for one query and
 * for several (flat either way), and `{error: {message, type, code}}` under HTTP 400 and 401.
 */

/** Shaped like the real thing and distinctive, so finding it anywhere means what it looks like. */
const API_KEY = "pplx-CanaryKey7f3c9e1b5a2d4c6e8f0a1b2c3d4e5f6a7b8c9d0e";
/** Friday 2026-10-02 09:00 KST. */
const MORNING_KST = () => new Date("2026-10-02T00:00:00Z");

type Asked = {
  url: string;
  init: RequestInit | undefined;
  body: Record<string, unknown>;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Two results as the vendor sent them for "2027년 최저임금 시급". */
const WAGE_RESULTS = [
  {
    title: "내년도 최저임금 '1만 700원'…올해보다 3.7%↑ - 키워드 뉴스",
    url: "https://www.korea.kr/news/customizedNewsView.do?newsId=148969730",
    snippet:
      "고용노동부는 지난 8월 5일, 2027년도에 적용되는 최저임금을 시간급 1만 700원으로 고시했다.",
    date: "2026-08-08",
    last_updated: "2026-09-01",
  },
  {
    title: "최저임금위원회",
    url: "https://www.minimumwage.go.kr/",
    snippet: "2027년 적용 최저임금 시간급 10,700원",
    date: "2026-08-05",
    last_updated: "2026-08-05",
  },
];

function searching(
  reply: (asked: Asked) => Response | Promise<Response>,
  options: { dailyCap?: number; now?: () => Date } = {},
) {
  const asked: Asked[] = [];
  const transport = createWebSearchTransport({
    apiKey: API_KEY,
    now: options.now ?? MORNING_KST,
    ...(options.dailyCap === undefined ? {} : { dailyCap: options.dailyCap }),
    fetchImpl: stubFetch(async (url, init) => {
      const entry = {
        url: String(url),
        init,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      };
      asked.push(entry);
      return reply(entry);
    }),
  });
  const call = (args: Record<string, unknown>, toolName = "search") =>
    transport.callTool({ url: "https://api.perplexity.ai" }, toolName, args);
  return { asked, transport, call };
}

async function refusalOf(
  run: () => Promise<unknown>,
): Promise<PluginRefusedError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PluginRefusedError) return error;
    throw error;
  }
  throw new Error("the call was not refused");
}

describe("what goes out", () => {
  test("one request to the pinned address, the key in a header and nowhere else", async () => {
    const { asked, call } = searching(() =>
      json({ id: "r1", results: WAGE_RESULTS }),
    );
    await call({ queries: ["2027년 최저임금 시급"] });
    expect(asked.length).toBe(1);
    expect(asked[0]?.url).toBe(SEARCH_URL);
    expect(asked[0]?.init?.method).toBe("POST");
    const headers = new Headers(asked[0]?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    // The key is on the request, so an answer that points somewhere else is not followed.
    expect(asked[0]?.init?.redirect).toBe("error");
    expect(JSON.stringify(asked[0]?.body)).not.toContain(API_KEY);
    expect(asked[0]?.url).not.toContain(API_KEY);
  });

  test("the fast search, for Korea, a bounded passage per page — and nothing a model chose about any of it", async () => {
    const { asked, call } = searching(() => json({ id: "r1", results: [] }));
    await call({
      queries: ["부가세 신고 기간"],
      // None of these is the model's to say: the price and the country are this code's.
      search_type: "web",
      country: "US",
      max_tokens_per_page: 100_000,
    });
    expect(asked[0]?.body).toEqual({
      query: "부가세 신고 기간",
      search_type: "fast",
      country: "KR",
      max_results: 5,
      max_tokens_per_page: 256,
    });
  });

  test("several queries go as one request, and a count is capped at ten", async () => {
    const { asked, call } = searching(() => json({ id: "r1", results: [] }));
    await call({
      queries: ["주휴수당 계산", " 주휴수당   계산 ", "주휴수당 조건"],
      max: 50,
      recency: "month",
      domains: ["https://www.moel.go.kr/policy/a", "NTS.go.kr"],
    });
    expect(asked[0]?.body).toEqual({
      // The same words twice are one query.
      query: ["주휴수당 계산", "주휴수당 조건"],
      search_type: "fast",
      country: "KR",
      max_results: MAX_RESULTS,
      max_tokens_per_page: 256,
      search_recency_filter: "month",
      // A pasted address is the site it names.
      search_domain_filter: ["moel.go.kr", "nts.go.kr"],
    });
  });

  test("a lone `query` is what was meant, and is taken", async () => {
    const { asked, call } = searching(() => json({ id: "r1", results: [] }));
    await call({ query: "오늘 환율" });
    expect(asked[0]?.body.query).toBe("오늘 환율");
  });
});

describe("what a Bot reads back", () => {
  test("the results: title, address, date and the passage, and when it was updated if that differs", async () => {
    const { call } = searching(() => json({ id: "r1", results: WAGE_RESULTS }));
    const result = await call({ queries: ["2027년 최저임금 시급"] });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({
      source: "웹 검색",
      queries: ["2027년 최저임금 시급"],
      shown: 2,
      results: [
        {
          title: "내년도 최저임금 '1만 700원'…올해보다 3.7%↑ - 키워드 뉴스",
          url: "https://www.korea.kr/news/customizedNewsView.do?newsId=148969730",
          date: "2026-08-08",
          updated: "2026-09-01",
          snippet:
            "고용노동부는 지난 8월 5일, 2027년도에 적용되는 최저임금을 시간급 1만 700원으로 고시했다.",
        },
        {
          title: "최저임금위원회",
          url: "https://www.minimumwage.go.kr/",
          date: "2026-08-05",
          snippet: "2027년 적용 최저임금 시간급 10,700원",
        },
      ],
    });
  });

  test("a passage is bounded here whatever the vendor sent, and a result with no address is dropped", async () => {
    const { call } = searching(() =>
      json({
        id: "r1",
        results: [
          {
            title: "긴 글",
            url: "https://example.com/a",
            snippet: "가".repeat(5_000),
          },
          { title: "주소 없음", snippet: "…" },
          { title: "웹이 아님", url: "javascript:alert(1)", snippet: "…" },
        ],
      }),
    );
    const read = JSON.parse((await call({ queries: ["x"] })).text) as {
      shown: number;
      results: { url: string; snippet: string }[];
    };
    expect(read.shown).toBe(1);
    expect(read.results[0]?.snippet.length).toBe(600);
  });

  test("no more than was asked for, even if the vendor sends more", async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      title: `결과 ${index}`,
      url: `https://example.com/${index}`,
      snippet: "…",
    }));
    const { call } = searching(() => json({ id: "r1", results: many }));
    const read = JSON.parse((await call({ queries: ["x"], max: 3 })).text) as {
      results: unknown[];
    };
    expect(read.results.length).toBe(3);
  });

  test("nothing found is an answer, not a refusal", async () => {
    const { call } = searching(() => json({ id: "r1", results: [] }));
    const result = await call({ queries: ["아무도 쓰지 않은 말 qzxv"] });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ shown: 0, results: [] });
  });
});

describe("an argument that would search for something else is refused, not dropped", () => {
  const { asked, call } = searching(() => json({ id: "r1", results: [] }));

  test("no query, and more than three", async () => {
    expect((await refusalOf(() => call({}))).code).toBe(
      "laf:web_search_bad_argument",
    );
    expect((await refusalOf(() => call({ queries: [" ", ""] }))).code).toBe(
      "laf:web_search_bad_argument",
    );
    expect(
      (
        await refusalOf(() =>
          call({
            queries: Array.from(
              { length: MAX_QUERIES + 1 },
              (_, index) => `질문 ${index}`,
            ),
          }),
        )
      ).code,
    ).toBe("laf:web_search_bad_argument");
  });

  test("a recency the vendor does not know, and a site that is not a domain", async () => {
    // Dropped, these would be all of time answered as this week's, and the whole web as one site's.
    expect(
      (await refusalOf(() => call({ queries: ["x"], recency: "fortnight" })))
        .code,
    ).toBe("laf:web_search_bad_argument");
    expect(
      (await refusalOf(() => call({ queries: ["x"], domains: ["국세청"] })))
        .code,
    ).toBe("laf:web_search_bad_argument");
    expect(
      (
        await refusalOf(() =>
          call({
            queries: ["x"],
            domains: ["a.kr", "b.kr", "c.kr", "d.kr", "e.kr", "f.kr"],
          }),
        )
      ).code,
    ).toBe("laf:web_search_bad_argument");
  });

  test("and none of them reached the vendor or counted against the day", () => {
    expect(asked).toEqual([]);
  });

  test("a tool this entry does not have", async () => {
    expect((await refusalOf(() => call({}, "answer"))).code).toBe(
      "laf:web_search_unknown_tool",
    );
  });
});

describe("each kind of no is its own, and none carries the key", () => {
  const cases: Array<{
    name: string;
    reply: () => Response | Promise<Response>;
    code: string;
  }> = [
    {
      name: "a key the vendor will not take is not something to try again",
      reply: () =>
        json(
          {
            error: {
              // The live 401, with the key said back the way a debugging vendor would.
              message: `Invalid API key provided: ${API_KEY}. Ensure your API key is correct and active.`,
              type: "invalid_api_key",
              code: 401,
            },
          },
          401,
        ),
      code: "laf:web_search_refused",
    },
    {
      name: "too many at once wants a moment, then one more try",
      reply: () => json({ error: { message: "rate limited", code: 429 } }, 429),
      code: "laf:web_search_busy",
    },
    {
      name: "a request the vendor calls malformed is the argument's fault",
      reply: () =>
        json(
          {
            error: {
              message: "max results must be between 1 and 20",
              type: "invalid_request",
              code: 400,
            },
          },
          400,
        ),
      code: "laf:web_search_bad_argument",
    },
    {
      name: "the vendor being down",
      reply: () =>
        new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      code: "laf:web_search_unreachable",
    },
    {
      name: "a request that never arrived",
      reply: () => {
        throw new Error(`connect ETIMEDOUT with Bearer ${API_KEY}`);
      },
      code: "laf:web_search_unreachable",
    },
    {
      name: "a 200 that is not the vendor's JSON",
      reply: () => new Response(`<html>${API_KEY}</html>`, { status: 200 }),
      code: "laf:web_search_unreadable",
    },
    {
      name: "a 200 with no results in it",
      reply: () => json({ id: "r1" }),
      code: "laf:web_search_unreadable",
    },
  ];

  for (const { name, reply, code } of cases) {
    test(name, async () => {
      const { call } = searching(reply);
      const refusal = await refusalOf(() => call({ queries: ["x"] }));
      expect(refusal.code).toBe(code);
      // The whole error, serialised: the key is nowhere in what goes to the trail or the export.
      expect(
        JSON.stringify({
          ...refusal,
          message: refusal.message,
          stack: refusal.stack,
        }),
      ).not.toContain(API_KEY);
      // And the Bot has words for it.
      expect(toolResultText(code)).not.toBe(code);
    });
  }
});

describe("a day's searches are bounded", () => {
  test("the cap refuses the next one without asking the vendor, and a new Korean day starts over", async () => {
    let at = new Date("2026-10-02T00:00:00Z");
    const { asked, call } = searching(() => json({ id: "r", results: [] }), {
      dailyCap: 2,
      now: () => at,
    });
    await call({ queries: ["하나"] });
    await call({ queries: ["둘"] });
    const refusal = await refusalOf(() => call({ queries: ["셋"] }));
    expect(refusal.code).toBe("laf:web_search_daily_cap");
    expect(asked.length).toBe(2);

    // 14:59 UTC is 23:59 in Seoul: still the same day.
    at = new Date("2026-10-02T14:59:00Z");
    expect((await refusalOf(() => call({ queries: ["넷"] }))).code).toBe(
      "laf:web_search_daily_cap",
    );
    // 15:00 UTC is midnight in Seoul.
    at = new Date("2026-10-02T15:00:00Z");
    await call({ queries: ["다섯"] });
    expect(asked.length).toBe(3);
  });

  test("a search the vendor failed still counted: it was asked for", async () => {
    const { asked, call } = searching(
      () => new Response("down", { status: 503 }),
      { dailyCap: 1 },
    );
    expect((await refusalOf(() => call({ queries: ["x"] }))).code).toBe(
      "laf:web_search_unreachable",
    );
    expect((await refusalOf(() => call({ queries: ["x"] }))).code).toBe(
      "laf:web_search_daily_cap",
    );
    expect(asked.length).toBe(1);
  });

  test("the cap is a heavy day ten times over, not a number a day's work meets", () => {
    expect(DAILY_SEARCH_CAP).toBe(300);
  });
});

describe("the entry", () => {
  test("is a deployment-key entry on the vendor's own host, and its one tool only reads", async () => {
    const entry = catalogueEntry(WEB_SEARCH_KEY);
    expect(entry?.auth).toEqual({ kind: "deployment-key", key: "perplexity" });
    expect(SEARCH_URL.startsWith(`${entry?.host}`)).toBe(true);
    expect(WEB_SEARCH_TOOLS.map((tool) => tool.name)).toEqual(["search"]);
    expect(WEB_SEARCH_TOOLS[0]?.annotations).toEqual({ readOnlyHint: true });
    if (!entry) throw new Error("no entry");
    expect(classifyTool(entry, "search", true)).toBe("read");
    // The description is prompt, in Korean, and says the one thing a name cannot: no browser.
    expect(WEB_SEARCH_TOOLS[0]?.description).toMatch(/브라우저를 열지 않고/);
    const { transport } = searching(() => json({ id: "r", results: [] }));
    expect(transport.listNeedsCredential).toBe(false);
    expect(
      (await transport.listTools({ url: "" })).map((tool) => tool.name),
    ).toEqual(["search"]);
  });

  test("is hidden without the key, and the key is read from its own environment name", () => {
    const entry = catalogueEntry(WEB_SEARCH_KEY);
    if (!entry) throw new Error("no entry");
    expect(entryIsOffered(entry, NO_DEPLOYMENT_KEYS)).toBe(false);
    expect(DEPLOYMENT_KEY_ENV.perplexity).toBe("PERPLEXITY_API_KEY");
    const keys = deploymentKeysFrom({ PERPLEXITY_API_KEY: ` ${API_KEY}\n` });
    expect(keys).toEqual({ perplexity: API_KEY });
    expect(entryIsOffered(entry, keyLookupOver(keys))).toBe(true);
  });

  test("a key with a space inside it is refused at boot, by its own name — not by the portal's rule", () => {
    expect(() =>
      deploymentKeysFrom({ PERPLEXITY_API_KEY: "pplx-abc def" }),
    ).toThrow(/PERPLEXITY_API_KEY has whitespace/);
    // The data.go.kr spelling rule is that portal's alone: a `+` here is nobody's business.
    expect(
      deploymentKeysFrom({ PERPLEXITY_API_KEY: "pplx-a+b/c=" }).perplexity,
    ).toBe("pplx-a+b/c=");
    expect(() =>
      deploymentKeysFrom({ DATA_GO_KR_SERVICE_KEY: "a+b/c=" }),
    ).toThrow(/URL-encoded spelling data\.go\.kr issues/);
  });

  test("is in the schema, not behind the bridge — the one connected tool that is", () => {
    /*
     * Measured 2026-10-02 (`shared/tools/bridge.ts`, `WEB_SEARCH_TOOL_NAME`): behind the bridge a
     * price question took 16.9 s, a `tool_search` round first; in the schema, 6.1 s. The name this
     * side gives the tool and the name on the core list are two strings that must be one.
     */
    expect(WEB_SEARCH_TOOL_NAME).toBe(`mcp__${WEB_SEARCH_KEY}__search`);
    expect(CORE_TOOL_NAMES.has(WEB_SEARCH_TOOL_NAME)).toBe(true);
    expect(exposureOf(WEB_SEARCH_TOOL_NAME)).toBe("core");
    // And so it is not named in the context layer's list of what is behind the bridge.
    expect(
      deferredToolsText([
        WEB_SEARCH_TOOL_NAME,
        "mcp__public-data__search_bids",
      ]),
    ).not.toContain("web-search");
    // Every other tool of a connected service stays behind it.
    expect(exposureOf("mcp__public-data__search_bids")).toBe("deferred");
    expect(exposureOf("mcp__web-search__anything_else")).toBe("deferred");
  });
});

/* ── every deployment-key entry, reconciled together ─────────────────────────────────────────── */

type StoreCalls = {
  ensured: string[];
  refreshed: string[];
  granted: { ref: string; botId: string }[];
  revoked: { ref: string; botId: string }[];
  removed: string[];
};

function fakeStore(input: {
  calls: StoreCalls;
  rows?: string[];
  holding?: Record<string, string[]>;
  failOn?: string;
}) {
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
    ensureCatalogueServer: async ({ key }: { key: string }) => {
      if (key === input.failOn) throw new Error("the row would not write");
      input.calls.ensured.push(key);
      return { url: "https://example.test", added: true };
    },
    refreshTools: async (serverId: string) => {
      input.calls.refreshed.push(serverId);
      return { tools: 1 };
    },
    grant: async (_kind: string, ref: string, botId: string) => {
      input.calls.granted.push({ ref, botId });
    },
    revoke: async (_kind: string, ref: string, botId: string) => {
      input.calls.revoked.push({ ref, botId });
    },
    removeServer: async (serverId: string) => {
      input.calls.removed.push(serverId);
    },
    listServers: async () =>
      (input.rows ?? []).map((id) => ({ id }) as ServerRecord),
    listForAgent: async (botId: string) => granted(botId),
  } as unknown as Parameters<
    ReturnType<typeof createDeploymentKeyRuntime>["reconcile"]
  >[0];
}

const noCalls = (): StoreCalls => ({
  ensured: [],
  refreshed: [],
  granted: [],
  revoked: [],
  removed: [],
});

const SEARCH_REF = `${WEB_SEARCH_KEY}/search`;
const PUBLIC_REFS = PUBLIC_DATA_TOOLS.map(
  (tool) => `${PUBLIC_DATA_KEY}/${tool.name}`,
);

describe("the deployment's keys, at boot", () => {
  test("only the search key: its row and its grant, and the public-data row a lost key left is taken back", async () => {
    const runtime = createDeploymentKeyRuntime({
      keys: { perplexity: API_KEY },
      services: DEPLOYMENT_KEY_SERVICES,
      listBots: async () => ["bot-a"],
    });
    expect(runtime.has(WEB_SEARCH_KEY)).toBe(true);
    expect(runtime.has(PUBLIC_DATA_KEY)).toBe(false);
    expect(runtime.toolNames).toEqual(["search"]);
    expect(Object.keys(runtime.transports)).toEqual(["perplexity"]);
    expect(runtime.keys("perplexity")).toBe(API_KEY);
    expect(runtime.keys("data-go-kr")).toBeNull();

    const calls = noCalls();
    await runtime.reconcile(
      fakeStore({
        calls,
        rows: [PUBLIC_DATA_KEY],
        holding: { "bot-a": PUBLIC_REFS },
      }),
      "deployment",
    );
    expect(calls.revoked).toEqual(
      PUBLIC_REFS.map((ref) => ({ ref, botId: "bot-a" })),
    );
    expect(calls.removed).toEqual([PUBLIC_DATA_KEY]);
    expect(calls.ensured).toEqual([WEB_SEARCH_KEY]);
    expect(calls.granted).toEqual([{ ref: SEARCH_REF, botId: "bot-a" }]);
  });

  test("both keys: both entries, and a Bot made later is handed every tool", async () => {
    const runtime = createDeploymentKeyRuntime({
      keys: { perplexity: API_KEY, "data-go-kr": "abc%2Bdef" },
      services: DEPLOYMENT_KEY_SERVICES,
      listBots: async () => [],
    });
    expect(runtime.toolNames).toEqual([
      ...PUBLIC_DATA_TOOLS.map((tool) => tool.name),
      "search",
    ]);
    const calls = noCalls();
    await runtime.offerTo(fakeStore({ calls }), "bot-new", "deployment");
    expect(calls.granted.map((grant) => grant.ref)).toEqual([
      ...PUBLIC_REFS,
      SEARCH_REF,
    ]);
  });

  test("one entry that will not reconcile does not stop the next", async () => {
    const runtime = createDeploymentKeyRuntime({
      keys: { perplexity: API_KEY, "data-go-kr": "abc%2Bdef" },
      services: DEPLOYMENT_KEY_SERVICES,
      listBots: async () => ["bot-a"],
    });
    const calls = noCalls();
    await runtime.reconcile(
      fakeStore({ calls, failOn: PUBLIC_DATA_KEY }),
      "deployment",
    );
    expect(calls.ensured).toEqual([WEB_SEARCH_KEY]);
    expect(calls.granted).toEqual([{ ref: SEARCH_REF, botId: "bot-a" }]);
  });

  test("no keys at all: nothing is assembled and nothing is touched", async () => {
    const runtime = createDeploymentKeyRuntime({
      keys: {},
      services: DEPLOYMENT_KEY_SERVICES,
      listBots: async () => ["bot-a"],
    });
    expect(runtime.toolNames).toEqual([]);
    expect(runtime.transports).toEqual({});
    const calls = noCalls();
    await runtime.reconcile(
      fakeStore({ calls, rows: ["notion"] }),
      "deployment",
    );
    await runtime.offerTo(fakeStore({ calls }), "bot-new", "deployment");
    expect(calls).toEqual(noCalls());
  });
});
