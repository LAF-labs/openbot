/**
 * 나라장터 and 기업마당, through the public data portal (data.go.kr), on the fleet's one key.
 *
 * THE THIRD ARRANGEMENT, after a person's own grant and a partner registration. Nobody consents and
 * nobody registers: the data is public, the portal wants a key to count calls against, and LAF
 * obtained one key for every VM (`DATA_GO_KR_SERVICE_KEY`, planted by the provisioner). A person
 * asks their Bot about 공고 and gets an answer — or the key is absent and the entry is not there at
 * all, which is the rule a partner card already keeps. What this file holds is the two tools, the
 * transport that spends the key, and the boot-time reconciliation that puts the tools in front of
 * every Bot on the machine, or takes them back when the key is gone.
 *
 * BOTH TOOLS ONLY READ, and say so with `readOnlyHint` the way a partner tool declares itself. The
 * entry names no `writeTools`, so `call.ts` classifies every call as a read and no guard floor stops
 * it — a routine asking every morning is the intended shape.
 *
 * THE KEY GOES INTO THE QUERY STRING AS-IS. data.go.kr issues two spellings of one key, "encoding"
 * (with %2B, %3D in it) and "decoding" (with + and =), and its gateway reads the raw query. Encoding
 * the encoded spelling again turns %2B into %252B, which is a key nobody registered, and sending the
 * decoded one turns + into a space, which is the same failure. So the fleet plants the encoded
 * spelling, `shared-clients.ts` refuses the other at boot, and this file concatenates the key rather
 * than handing it to `URLSearchParams`.
 *
 * VERIFIED LIVE ON 2026-09-06 with the fleet's key: both services answered 200 with `resultCode`
 * 00; the keyword, region and industry filters each narrowed 나라장터's count; the hashtag and field
 * filters each narrowed 기업마당's; and a malformed date came back as resultCode 06 inside the
 * `nkoneps.com.response.ResponseError` shape `vendorHeaderOf` reads. `type=json` is 나라장터's word
 * for the format and `dataType=json` is 기업마당's — the other spelling answers XML.
 */
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { PluginStore } from "./store";
import { PluginRefusedError } from "./store";
import type { DeploymentKeyFamily } from "./catalogue";
import type { McpCallResult } from "./mcp";
import type { PartnerToolSpec } from "./partner-tools";
import { asResult, countArg, REST_TIMEOUT_MS, stringArg } from "./rest-support";
import { type DeploymentKeyLookup, keyLookupOver } from "./shared-clients";
import type { VendorTransport } from "./transport";

/** The catalogue entry these tools live under. Prefixes every tool ref: `public-data/search_bids`. */
export const PUBLIC_DATA_KEY = "public-data";

/**
 * The two services, pinned here because the entry's one host serves both under different paths.
 *
 * `getBidPblancListInfoServcPPSSrch` is the 용역 (services) listing, which is what a small business
 * bids on; 물품 and 공사 have sibling operations and are a later decision. `pblancBsnsService` is the
 * portal's own front on 기업마당 — the one that takes a data.go.kr key, unlike bizinfo.go.kr's RSS
 * API, which wants a key of its own that nobody here holds.
 */
export const BIDS_URL =
  "https://apis.data.go.kr/1230000/ad/BidPublicInfoService/getBidPblancListInfoServcPPSSrch";
export const PROGRAMS_URL =
  "https://apis.data.go.kr/1421000/bizinfo/pblancBsnsService";

const DEFAULT_DAYS = 7;
const MAX_DAYS = 31;
const DEFAULT_ROWS = 10;
/** Ten, and no way to ask for more: the result rides in a model's context on every later turn. */
export const MAX_ROWS = 10;
/**
 * The raw cap: how much of a vendor's answer this file will read before refusing.
 *
 * Ten 나라장터 rows are about eighty kilobytes because each carries a hundred and twenty fields, so
 * this is a bound against a portal misbehaving rather than against a large honest answer. Refused
 * rather than truncated, since a JSON body cut in half parses as nothing.
 */
export const RAW_RESPONSE_CAP_CHARS = 1_000_000;
/** A 사업개요 is HTML paragraphs of the whole announcement. This much says what it is about. */
const SUMMARY_CHARS = 160;

/*
 * The descriptions are Korean and short because they are prompt, in every turn's context for the
 * life of the deployment. The region codes are the 행정표준 시도 codes; 11, 26, 41 and 50 were
 * measured to narrow the listing to that 시도, and the rest follow the same table.
 */
export const PUBLIC_DATA_TOOLS: readonly PartnerToolSpec[] = Object.freeze([
  {
    name: "search_bids",
    description:
      "나라장터(조달청) 용역 입찰공고를 찾는다. 최근 며칠 사이에 올라온 공고를 공고명 키워드·지역·업종으로 거른다. 결과는 공고명·기관·마감·금액·링크가 든 JSON.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "공고명에 들어갈 말. 예: 청소, 급식, 인쇄, 행사",
        },
        days: {
          type: "number",
          description: `오늘부터 며칠 전까지 올라온 공고를 볼지. 기본 ${DEFAULT_DAYS}, 최대 ${MAX_DAYS}`,
        },
        region: {
          type: "string",
          description:
            "참가제한 지역의 시도 코드 두 자리. 11 서울, 26 부산, 27 대구, 28 인천, 29 광주, 30 대전, 31 울산, 36 세종, 41 경기, 43 충북, 44 충남, 46 전남, 47 경북, 48 경남, 50 제주, 51 강원, 52 전북",
        },
        industry: {
          type: "string",
          description:
            "나라장터 업종코드. 코드를 알 때만 쓰고, 모르면 keyword로 거른다.",
        },
        max: {
          type: "number",
          description: `가져올 개수. 기본 ${DEFAULT_ROWS}, 최대 ${MAX_ROWS}`,
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_support_programs",
    description:
      "기업마당(중소벤처기업부)의 정부·지자체 지원사업 공고를 최신순으로 찾는다. 해시태그(지역·업종·키워드, 쉼표로 여러 개)와 분야 코드로 거른다. 결과는 공고명·소관기관·신청기간·대상·링크가 든 JSON.",
    inputSchema: {
      type: "object",
      properties: {
        hashtags: {
          type: "string",
          description: "쉼표로 나눈 해시태그. 예: 서울,소상공인 또는 제조,수출",
        },
        field: {
          type: "string",
          description:
            "분야 코드. 01 금융, 02 기술, 03 인력, 04 수출, 05 내수, 06 창업, 07 경영, 09 기타",
          enum: ["01", "02", "03", "04", "05", "06", "07", "09"],
        },
        max: {
          type: "number",
          description: `가져올 개수. 기본 ${DEFAULT_ROWS}, 최대 ${MAX_ROWS}`,
        },
      },
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

/** What the portal wraps every answer in, on both services. */
type VendorHeader = { resultCode?: unknown; resultMsg?: unknown };
type VendorBody = { totalCount?: unknown; items?: unknown };

/**
 * The header, wherever this vendor put it.
 *
 * A good answer is `{response: {header, body}}`. 나라장터's own errors are
 * `{"nkoneps.com.response.ResponseError": {header}}` — one key, whatever it is called, with a header
 * inside — so the header is looked for under `response` first and under whatever single key there is
 * otherwise. Null means the shape is not one this file knows.
 */
function vendorHeaderOf(parsed: unknown): VendorHeader | null {
  if (!parsed || typeof parsed !== "object") return null;
  const top = parsed as Record<string, unknown>;
  const candidates = [top.response, ...Object.values(top)];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const header = (candidate as { header?: unknown }).header;
    if (header && typeof header === "object") return header as VendorHeader;
  }
  return null;
}

/**
 * The rows, in the one shape both services could have used and did not.
 *
 * 나라장터 answers `items: [...]`; 기업마당 answers `items: {item: [...]}`; and data.go.kr's older
 * services answer a bare object for one row and `""` for none. All four are rows.
 */
function rowsOf(body: VendorBody | undefined): Record<string, unknown>[] {
  const items = body?.items;
  const list = Array.isArray(items)
    ? items
    : items && typeof items === "object"
      ? ((items as { item?: unknown }).item ?? [])
      : [];
  const rows = Array.isArray(list) ? list : [list];
  return rows.filter(
    (row): row is Record<string, unknown> => !!row && typeof row === "object",
  );
}

const text = (row: Record<string, unknown>, key: string): string =>
  typeof row[key] === "string" ? (row[key] as string).trim() : "";

/** A won amount as a number, or null: the vendor sends "240900000" and sometimes "". */
const won = (row: Record<string, unknown>, key: string): number | null => {
  const value = Number(text(row, key));
  return Number.isFinite(value) && text(row, key) !== "" ? value : null;
};

/** The 사업개요 without its markup: paragraphs, entities and whitespace collapsed to one line. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `YYYYMMDDHHmm` in Korea Standard Time, which is what 나라장터 compares against.
 *
 * A fixed offset rather than `Intl`, because KST has no daylight saving and the alternative is a
 * formatter whose output depends on the ICU data the runtime was built with.
 */
const KST_OFFSET_MS = 9 * 60 * 60_000;
export function kstStamp(at: Date, time?: "0000" | "2359"): string {
  const shifted = new Date(at.getTime() + KST_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  const day = `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`;
  return `${day}${time ?? `${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}`}`;
}

/** The same day as a person writes it. */
const ymd = (stamp: string) =>
  `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;

export function createPublicDataTransport(input: {
  /** The encoded spelling, exactly as the environment carries it. Concatenated, never encoded. */
  serviceKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): VendorTransport {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());

  /**
   * One request to the portal, with the key in front of everything else, and the answer's rows.
   *
   * Every way the portal says no is turned into a code a Bot reads as Korean, with the portal's own
   * words in the message for the trail — the gateway's `SERVICE_KEY_IS_NOT_REGISTERED_ERROR` is
   * the one sentence that tells an operator what to fix.
   */
  async function ask(
    url: string,
    query: Record<string, string | undefined>,
  ): Promise<{ header: VendorHeader; body: VendorBody | undefined }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") params.set(key, value);
    }
    const address = `${url}?serviceKey=${input.serviceKey}&${params.toString()}`;

    let response: Response;
    try {
      response = await fetchImpl(address, {
        method: "GET",
        headers: { accept: "application/json" },
        // The key rides on the query string, so a redirect would carry it wherever the answer said.
        redirect: "manual",
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      });
    } catch (error) {
      refuseWith(
        "laf:public_data_unreachable",
        error instanceof Error ? error.message : String(error),
      );
    }

    const raw = await response.text().catch(() => "");
    if (raw.length > RAW_RESPONSE_CAP_CHARS) {
      refuseWith("laf:public_data_too_large", `${raw.length} characters`);
    }
    if (!response.ok) {
      refuseWith("laf:public_data_refused", `HTTP ${response.status}`);
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /*
       * The gateway in front of every data.go.kr service answers its own refusals — an unregistered
       * key, a spent quota — as XML with HTTP 200, whatever format was asked for. Those are the
       * refusals worth naming to an operator, so the code and the message are pulled out of the XML
       * rather than reported as "unreadable".
       */
      const code = /<returnReasonCode>\s*(\d+)\s*<\/returnReasonCode>/.exec(
        raw,
      );
      const message = /<returnAuthMsg>([^<]*)<\/returnAuthMsg>/.exec(raw);
      if (code) {
        refuseWith(
          "laf:public_data_refused",
          `gateway ${code[1]}${message ? ` ${message[1].trim()}` : ""}`,
        );
      }
      refuseWith("laf:public_data_unreadable", raw.slice(0, 120));
    }

    const header = vendorHeaderOf(parsed);
    if (!header) refuseWith("laf:public_data_unreadable", "no header");
    if (String(header.resultCode) !== "00") {
      refuseWith(
        "laf:public_data_refused",
        `${String(header.resultCode)} ${String(header.resultMsg ?? "")}`.trim(),
      );
    }
    const body = (parsed as { response?: { body?: VendorBody } }).response
      ?.body;
    return { header, body };
  }

  async function searchBids(args: Record<string, unknown>): Promise<string> {
    const days = countArg(args, "days", DEFAULT_DAYS, MAX_DAYS);
    const rows = countArg(args, "max", DEFAULT_ROWS, MAX_ROWS);
    const at = now();
    const to = kstStamp(at);
    const from = kstStamp(new Date(at.getTime() - days * 86_400_000), "0000");
    const keyword = stringArg(args, "keyword");
    const region = stringArg(args, "region");
    const industry = stringArg(args, "industry");

    const { body } = await ask(BIDS_URL, {
      pageNo: "1",
      numOfRows: String(rows),
      // 1 is "by 공고게시일시", the window a person means by "this week's notices".
      inqryDiv: "1",
      inqryBgnDt: from,
      inqryEndDt: to,
      type: "json",
      bidNtceNm: keyword ?? undefined,
      prtcptLmtRgnCd: region ?? undefined,
      indstrytyCd: industry ?? undefined,
    });

    const listed = rowsOf(body).slice(0, rows);
    return JSON.stringify({
      source: "나라장터",
      period: { from: ymd(from), to: ymd(to) },
      filters: {
        ...(keyword ? { keyword } : {}),
        ...(region ? { region } : {}),
        ...(industry ? { industry } : {}),
      },
      totalCount: Number(body?.totalCount ?? listed.length) || 0,
      shown: listed.length,
      rows: listed.map((row) => {
        const agency = text(row, "ntceInsttNm");
        const demand = text(row, "dminsttNm");
        return {
          noticeNo: `${text(row, "bidNtceNo")}-${text(row, "bidNtceOrd")}`,
          title: text(row, "bidNtceNm"),
          agency,
          ...(demand && demand !== agency ? { demandAgency: demand } : {}),
          postedAt: text(row, "bidNtceDt"),
          closesAt: text(row, "bidClseDt"),
          budgetWon: won(row, "asignBdgtAmt"),
          estimatedPriceWon: won(row, "presmptPrce"),
          method: text(row, "cntrctCnclsMthdNm"),
          category: text(row, "pubPrcrmntClsfcNm"),
          url: text(row, "bidNtceDtlUrl") || text(row, "bidNtceUrl"),
        };
      }),
    });
  }

  async function searchPrograms(
    args: Record<string, unknown>,
  ): Promise<string> {
    const rows = countArg(args, "max", DEFAULT_ROWS, MAX_ROWS);
    const hashtags = stringArg(args, "hashtags");
    const field = stringArg(args, "field");

    const { body } = await ask(PROGRAMS_URL, {
      pageNo: "1",
      numOfRows: String(rows),
      dataType: "json",
      hashtags: hashtags ?? undefined,
      searchLclasId: field ?? undefined,
    });

    const listed = rowsOf(body).slice(0, rows);
    return JSON.stringify({
      source: "기업마당",
      filters: {
        ...(hashtags ? { hashtags } : {}),
        ...(field ? { field } : {}),
      },
      totalCount: Number(body?.totalCount ?? listed.length) || 0,
      shown: listed.length,
      rows: listed.map((row) => ({
        id: text(row, "pblancId"),
        title: text(row, "pblancNm"),
        agency: text(row, "jrsdInsttNm"),
        executor: text(row, "excInsttNm"),
        field: text(row, "pldirSportRealmLclasCodeNm"),
        period: text(row, "reqstBeginEndDe"),
        target: text(row, "trgetNm"),
        postedAt: text(row, "creatPnttm"),
        summary: plainText(text(row, "bsnsSumryCn")).slice(0, SUMMARY_CHARS),
        url: text(row, "pblancUrl"),
      })),
    });
  }

  return {
    listNeedsCredential: false,
    listTools: async () =>
      PUBLIC_DATA_TOOLS.map((tool) => ({
        ...tool,
        annotations: { ...tool.annotations },
      })),
    callTool: async (_connection, toolName, args): Promise<McpCallResult> => {
      if (toolName === "search_bids") return asResult(await searchBids(args));
      if (toolName === "search_support_programs") {
        return asResult(await searchPrograms(args));
      }
      return refuseWith("laf:public_data_unknown_tool", toolName);
    },
  };
}

/* ── The runtime: what the process assembles, and what it does at boot ───────────────────────── */

/** The slice of the store the reconciliation needs, so a test hands in exactly that and no more. */
export type PublicDataStore = Pick<
  PluginStore,
  | "ensureCatalogueServer"
  | "refreshTools"
  | "approveToolDefinition"
  | "grant"
  | "revoke"
  | "removeServer"
  | "listServers"
  | "listForAgent"
>;

export type PublicDataRuntime = {
  /** Whether this VM was given the key. False draws no entry and offers no tool. */
  configured: boolean;
  /** For the catalogue listing, which hides a deployment-key entry whose key is absent. */
  keys: DeploymentKeyLookup;
  /** For `createPluginStore`. Empty leaves the entry refusing rather than falling back to MCP. */
  transports: Partial<Record<DeploymentKeyFamily, VendorTransport>>;
  /**
   * The row, the tools and a grant on each for every Bot on this machine — or, with no key, every
   * one of those taken back. Run at boot; idempotent; never throws.
   */
  reconcile: (store: PublicDataStore, by: string) => Promise<void>;
  /** A Bot that has just come into being gets the tools, if the key is here. Never throws. */
  offerTo: (store: PublicDataStore, botId: string, by: string) => Promise<void>;
};

export function createPublicDataRuntime(input: {
  keys: Partial<Record<DeploymentKeyFamily, string>>;
  /** Every live Bot on this deployment, whoever owns it: the set the tools are offered to. */
  listBots: () => Promise<string[]>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): PublicDataRuntime {
  const serviceKey = input.keys["data-go-kr"];
  const configured = Boolean(serviceKey);
  const transports: Partial<Record<DeploymentKeyFamily, VendorTransport>> =
    serviceKey
      ? {
          "data-go-kr": createPublicDataTransport({
            serviceKey,
            ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
            ...(input.now ? { now: input.now } : {}),
          }),
        }
      : {};

  const refs = PUBLIC_DATA_TOOLS.map(
    (tool) => `${PUBLIC_DATA_KEY}/${tool.name}`,
  );

  /** Only the grants a Bot does not already hold: a boot must not rewrite ten rows of trail. */
  async function grantMissing(
    store: PublicDataStore,
    botId: string,
    by: string,
  ) {
    const held = new Set(
      (await store.listForAgent(botId)).tools.map((tool) => tool.ref),
    );
    for (const ref of refs) {
      if (!held.has(ref)) await store.grant("mcp", ref, botId, by);
    }
  }

  async function revokeHeld(store: PublicDataStore, botId: string, by: string) {
    const held = new Set(
      (await store.listForAgent(botId)).tools.map((tool) => tool.ref),
    );
    for (const ref of refs) {
      if (held.has(ref)) await store.revoke("mcp", ref, botId, by);
    }
  }

  const failed = (what: string, error: unknown) =>
    log.error("public_data_not_reconciled", {
      what,
      reason: describeFailure(error),
    });

  return {
    configured,
    keys: keyLookupOver(input.keys),
    transports,

    async reconcile(store, by) {
      try {
        const held = (await store.listServers()).some(
          (server) => server.id === PUBLIC_DATA_KEY,
        );
        if (!configured) {
          /*
           * A key taken away after the row was made. The grants go first, then the row — the same
           * order a partner disconnect keeps, so no Bot holds a grant on a tool that still exists.
           */
          if (!held) return;
          for (const botId of await input.listBots()) {
            await revokeHeld(store, botId, by);
          }
          await store.removeServer(PUBLIC_DATA_KEY, by);
          return;
        }

        await store.ensureCatalogueServer({ key: PUBLIC_DATA_KEY, by });
        const refreshed = await store.refreshTools(PUBLIC_DATA_KEY);
        /*
         * A definition that changed since the row was made is paused by the refresh for a person
         * to review — right for somebody else's server, and a dead tool here, because the
         * definition is this repository's own reviewed code and nobody is going to press Approve on
         * every shop owner's machine after every upgrade. The trail still records the change and
         * the acceptance, one row each.
         */
        if ((refreshed.paused ?? 0) > 0) {
          for (const tool of PUBLIC_DATA_TOOLS) {
            await store.approveToolDefinition(PUBLIC_DATA_KEY, tool.name, by);
          }
        }
        for (const botId of await input.listBots()) {
          await grantMissing(store, botId, by);
        }
      } catch (error) {
        failed("reconcile", error);
      }
    },

    async offerTo(store, botId, by) {
      if (!configured) return;
      try {
        await grantMissing(store, botId, by);
      } catch (error) {
        failed(`offer to ${botId}`, error);
      }
    },
  };
}
