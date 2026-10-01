/**
 * The web, searched on the fleet's one key (Perplexity's Search API).
 *
 * WHY A BOT HAS THIS. Asked a thing the web answers — next year's minimum wage, when a VAT return is
 * due, what a competitor charges — a Bot opened its browser, went to a search engine, read a result
 * page, opened a result and read that: a payroll question took about four minutes and 주휴수당 ten
 * (measured 2026-09, `~/laf/docs/open-dot-review-2026-10-01.md` B8). The same question here is one
 * request: measured 2026-10-02 with the fleet's key, "2027년 최저임금 시급" answered in 0.34–0.54 s
 * with five results in 2.2 KB, the first of them korea.kr saying the figure and the date it was
 * gazetted. The browser stays for what only a browser can do — sign in, press, fill in.
 *
 * THE SEARCH API, NOT THE ANSWER ONE. The owner's direction (2026-10-01), and the right one for a
 * Bot: this returns ranked pages with their addresses, dates and the passage that matched, and the
 * Bot — which knows who it is talking to and what was asked — reads them and says where each fact
 * came from. An API that returns somebody else's written answer would put a second model's judgement
 * between the page and the person, with no boundary of ours around it.
 *
 * `search_type: "fast"` IS THE ONLY ONE SENT. Fast is $1 per thousand requests against $5 for the
 * standard search, and the vendor's own guide gives the standard one to "rare, difficult, or
 * ambiguous questions". A Bot that finds fast results thin can still open a page. If a slower
 * search is ever wanted it is a decision with a price, not an argument a model may pass.
 *
 * WHAT LEAVES THE MACHINE IS THE QUERY, and nothing else: no account, no conversation, no place
 * beyond the fixed country. The words are the Bot's — the same ones it would have typed into a
 * search box in its own browser — so this adds a recipient, not a kind of disclosure. That recipient
 * belongs in the privacy policy's list when the policy is next revised (the owner's and a lawyer's,
 * not this file's).
 *
 * VERIFIED LIVE 2026-10-02: a single query and an array both answer `{id, results[]}` with a FLAT
 * `results` — an array of queries is merged into one ranked list, `max_results` counts the whole
 * list and nothing says which query a result answered. A bad argument is HTTP 400 and a bad key 401,
 * both as `{error: {message, type, code}}`. A request with up to five queries is one billed request.
 */
import { describeFailure } from "../failure-text";
import type { DeploymentKeyService } from "./deployment-key-runtime";
import { type McpCallResult, withoutCredential } from "./mcp";
import type { PartnerToolSpec } from "./partner-tools";
import { asResult } from "./rest-support";
import { PluginRefusedError } from "./store";
import { TIMEOUT_MS } from "./timeouts";
import type { VendorTransport } from "./transport";

/** The catalogue entry this tool lives under. Prefixes its ref: `web-search/search`. */
export const WEB_SEARCH_KEY = "web-search";

/** Pinned here beside the entry's host: the one address the key is ever sent to. */
export const SEARCH_URL = "https://api.perplexity.ai/search";

const DEFAULT_RESULTS = 5;
/** Ten, and no way to ask for more: a result rides in the model's context on every later turn. */
export const MAX_RESULTS = 10;
/** Three, of the vendor's five: more angles than that is a second search, with a second look at the first. */
export const MAX_QUERIES = 3;
const MAX_QUERY_CHARS = 300;
const MAX_DOMAINS = 5;
/**
 * How much of each page the vendor is asked to hand back, in its tokens. Measured: without it a
 * passage ran to 438 characters and with it to about 230, and the passage that carried the answer
 * was the same one both times.
 */
const TOKENS_PER_PAGE = 256;
/** And a bound of our own on what one passage may be, whatever the vendor sent. */
const SNIPPET_CHARS = 600;
/** Korea: the product's first audience, and what "최저임금" or "부가세" means without saying so. */
const COUNTRY = "KR";
const RECENCIES = ["day", "week", "month", "year"] as const;

/**
 * How many searches one deployment may make in a day of Korean time.
 *
 * A deployment is one person and their Bot. Thirty a day is a heavy day; three hundred is a Bot in
 * a loop, or a routine written to search every minute, spending the fleet's money on nobody's
 * behalf. In memory by decision (`docs/laf/deployment-model.md`): one process per VM, and a restart
 * that forgets the count costs at most another day's allowance.
 */
export const DAILY_SEARCH_CAP = 300;

/*
 * The description is Korean and short because it is prompt. What it has to carry: that this is the
 * way to find a fact, that the browser is not needed for it, and that a result has a date to check.
 */
export const WEB_SEARCH_TOOLS: readonly PartnerToolSpec[] = Object.freeze([
  {
    name: "search",
    description:
      "웹을 검색해 지금의 사실을 찾는다 — 뉴스, 가격, 영업시간, 제도와 기한, 회사와 사람. 브라우저를 열지 않고 결과의 제목·주소·날짜·발췌를 바로 받는다. 날짜를 보고 최신인지 확인하고, 답에는 근거가 된 주소를 쓴다. 로그인하거나 눌러야 하는 일은 브라우저로 한다.",
    inputSchema: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_QUERIES,
          description: `검색어. 보통 하나. 한 주제를 다른 각도로도 찾을 때만 ${MAX_QUERIES}개까지 — 결과는 한 목록으로 섞여 온다`,
        },
        recency: {
          type: "string",
          enum: [...RECENCIES],
          description:
            "최근 것만 볼 때: 하루, 한 주, 한 달, 한 해 안에 나온 것",
        },
        domains: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_DOMAINS,
          description:
            "이 사이트들에서만 찾을 때. 주소가 아니라 도메인으로. 예: nts.go.kr, moel.go.kr",
        },
        max: {
          type: "number",
          description: `가져올 결과 수. 기본 ${DEFAULT_RESULTS}, 최대 ${MAX_RESULTS}`,
        },
      },
      required: ["queries"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
]);

/** A refusal a Bot reads as Korean, with the vendor's own words kept for the trail. */
function refuseWith(code: string, detail?: string): never {
  throw new PluginRefusedError(
    detail ? `${code}: ${detail}` : code,
    null,
    code,
  );
}

/** `YYYY-MM-DD` in Korean time: the day the cap counts by. A fixed offset, as `kstStamp` is. */
function kstDay(at: Date): string {
  return new Date(at.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

/**
 * The queries a call carries, cleaned: `queries` as the schema says, or a lone `query` — a model
 * that has not read the schema reaches for the singular, and refusing it would cost a round to say
 * what was plainly meant.
 */
function queriesOf(args: Record<string, unknown>): string[] {
  const given = Array.isArray(args.queries)
    ? args.queries
    : typeof args.queries === "string"
      ? [args.queries]
      : typeof args.query === "string"
        ? [args.query]
        : [];
  const cleaned = given
    .filter((query): query is string => typeof query === "string")
    .map((query) => query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS))
    .filter(Boolean);
  return [...new Set(cleaned)];
}

/**
 * A site as the vendor's filter takes it: a bare domain. `https://www.nts.go.kr/a/b` and
 * `nts.go.kr` are the same wish, and only the second is accepted there.
 */
function domainOf(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const host = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "");
  return /^[a-z0-9가-힣.-]+\.[a-z가-힣]{2,}$/.test(host) ? host : null;
}

type VendorResult = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  date?: unknown;
  last_updated?: unknown;
};

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export function createWebSearchTransport(input: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Searches allowed in one Korean day. {@link DAILY_SEARCH_CAP} unless a test says otherwise. */
  dailyCap?: number;
}): VendorTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const dailyCap = input.dailyCap ?? DAILY_SEARCH_CAP;
  /** The day being counted, and how many searches it has had. */
  const spent = { day: "", count: 0 };

  // A declaration rather than an arrow, so a call to it narrows like the `never` it returns.
  function refuse(code: string, detail: string): never {
    // The key rides in a header, but a vendor's error page may still say it back.
    return refuseWith(code, withoutCredential(detail, input.apiKey));
  }

  async function search(args: Record<string, unknown>): Promise<string> {
    const queries = queriesOf(args);
    if (queries.length === 0) refuse("laf:web_search_bad_argument", "no query");
    if (queries.length > MAX_QUERIES) {
      refuse("laf:web_search_bad_argument", `${queries.length} queries`);
    }
    /*
     * REFUSED, NOT DROPPED — the lesson `fieldsOf` records for the support-programme search. A
     * recency the vendor does not know, dropped, is a search of all time answered as though it were
     * this week's; a site that is not a domain, dropped, is the whole web answered as though it
     * were the tax office's.
     */
    const recency = args.recency;
    if (
      recency !== undefined &&
      !RECENCIES.includes(recency as (typeof RECENCIES)[number])
    ) {
      refuse("laf:web_search_bad_argument", "recency");
    }
    const wanted = Array.isArray(args.domains) ? args.domains : [];
    const domains = wanted.map((domain) =>
      typeof domain === "string" ? domainOf(domain) : null,
    );
    if (domains.length > MAX_DOMAINS || domains.includes(null)) {
      refuse("laf:web_search_bad_argument", "domains");
    }
    const sites = domains.filter((domain): domain is string => domain !== null);
    const asked = Number(args.max);
    const max =
      Number.isFinite(asked) && asked >= 1
        ? Math.min(Math.floor(asked), MAX_RESULTS)
        : DEFAULT_RESULTS;

    // Counted before it is sent: a search that fails at the vendor was still asked for.
    const today = kstDay(now());
    if (spent.day !== today) {
      spent.day = today;
      spent.count = 0;
    }
    if (spent.count >= dailyCap) {
      refuse("laf:web_search_daily_cap", `${spent.count} today`);
    }
    spent.count += 1;

    let response: Response;
    try {
      response = await fetchImpl(SEARCH_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          query: queries.length === 1 ? queries[0] : queries,
          search_type: "fast",
          country: COUNTRY,
          max_results: max,
          max_tokens_per_page: TOKENS_PER_PAGE,
          ...(recency ? { search_recency_filter: recency } : {}),
          ...(sites.length > 0 ? { search_domain_filter: sites } : {}),
        }),
        // The key is on the request: it goes to the pinned address or nowhere.
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS.rest),
      });
    } catch (error) {
      refuse("laf:web_search_unreachable", describeFailure(error));
    }

    const raw = await response.text().catch(() => "");
    if (!response.ok) {
      const said = (() => {
        try {
          const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
          return text(parsed.error?.message);
        } catch {
          return "";
        }
      })();
      const detail = `HTTP ${response.status}${said ? ` ${said.slice(0, 200)}` : ""}`;
      /*
       * NOT ALL ONE FAILURE (CLAUDE.md, "Model calls"). A 429 wants waiting and one more try; a key
       * the vendor will not take wants nobody trying again; a request it calls malformed is this
       * code's argument to fix. Told apart, the Bot does the right next thing instead of the same
       * thing three times.
       */
      if (response.status === 429) refuse("laf:web_search_busy", detail);
      if ([401, 402, 403].includes(response.status)) {
        refuse("laf:web_search_refused", detail);
      }
      if (response.status === 400 || response.status === 422) {
        refuse("laf:web_search_bad_argument", detail);
      }
      refuse("laf:web_search_unreachable", detail);
    }

    let parsed: { results?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw) as { results?: unknown };
    } catch {
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.results)) {
      refuse("laf:web_search_unreadable", raw.slice(0, 120));
    }

    const results = (parsed.results as VendorResult[])
      .filter((result) => result && typeof result === "object")
      .map((result) => ({ ...result, url: text(result.url) }))
      // An address is what a result is for: one without it is nothing a Bot can cite or open.
      .filter((result) => /^https?:\/\//.test(result.url))
      .slice(0, max)
      .map((result) => {
        const date = text(result.date);
        const updated = text(result.last_updated);
        return {
          title: text(result.title),
          url: result.url,
          ...(date ? { date } : {}),
          ...(updated && updated !== date ? { updated } : {}),
          snippet: text(result.snippet).slice(0, SNIPPET_CHARS),
        };
      });

    // No results is an answer, not a refusal: the Bot says it found nothing, or asks another way.
    return JSON.stringify({
      source: "웹 검색",
      queries,
      ...(recency ? { recency } : {}),
      ...(sites.length > 0 ? { domains: sites } : {}),
      shown: results.length,
      results,
    });
  }

  return {
    listNeedsCredential: false,
    listTools: async () =>
      WEB_SEARCH_TOOLS.map((tool) => ({
        ...tool,
        annotations: { ...tool.annotations },
      })),
    callTool: async (_connection, toolName, args): Promise<McpCallResult> => {
      if (toolName === "search") return asResult(await search(args));
      return refuseWith("laf:web_search_unknown_tool", toolName);
    },
  };
}

/** This entry, as the deployment-key runtime takes it (`deployment-key-runtime.ts`). */
export const WEB_SEARCH_SERVICE: DeploymentKeyService = {
  key: WEB_SEARCH_KEY,
  family: "perplexity",
  tools: WEB_SEARCH_TOOLS,
  transport: ({ key, fetchImpl, now }) =>
    createWebSearchTransport({
      apiKey: key,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(now ? { now } : {}),
    }),
};
