/**
 * A PERSON ASKS FOR SOMETHING THAT NEEDS A SERVICE THEY HAVE NOT CONNECTED (2026-10-05).
 *
 * Measured on the local stack that afternoon, one sample each, beside the product this one is held
 * against. "오늘 일정 뭐 있어?" with no calendar connected: the other product said in one sentence
 * that the calendar was not connected and put a connect card under it, seven seconds after the
 * send. This one said "일정 확인해 볼게요", looked for a tool, said "연결된 일정 도구를 더
 * 찾아볼게요", looked again, and at 8.3 s answered in prose that no calendar was connected — with no
 * card, though it has one (`showConnection`, `shared/tools/gallery.ts`). "새 메일 왔어?": one look,
 * then prose.
 *
 * WHAT A SCENARIO HERE HANDS THE BOT is what a chat window hands one: every core tool, the tools
 * that run on the fleet's own keys (기업마당, the web search, the weather), 목표's four, and the
 * screen's cards — the connect card with the schema a window really declares, because the keys a
 * Bot may offer are in that schema and nowhere else. And the context layer names what stands behind
 * the bridge, as production draws it (`listed` on the scenario): a Bot that is told "여기 없는 일을
 * 하려고 tool_search 하지 말고" is a different Bot from one that is told nothing.
 *
 * THE JUDGES ARE PURE, so `tests/eval-connect.test.ts` can hand them a turn that offered the wrong
 * service, one that looked twice and one that answered in prose, and watch each fail.
 */
import { CATALOGUE } from "../server/src/plugins/catalogue";
import { toolResultText } from "../shared/prompt/tool-results.ko";
import { BUSINESS_SITES } from "../shared/sites/catalogue";
import {
  serverKeyOf,
  TOOL_SEARCH,
  type WireTool,
} from "../shared/tools/bridge";
import {
  type AccountState,
  CONNECT_CARD,
  connectionAnswer,
  GALLERY_DECISIONS,
  withAccountStates,
} from "../shared/tools/gallery";
import { GOAL_TOOLS, LIST_GOALS } from "../shared/tools/goals";
import type { ObservedCall, StreamEvent } from "./lib";

/** What a person turns on themselves: the catalogue's accounts. */
export const ACCOUNTS: readonly string[] = CATALOGUE.filter(
  (entry) => entry.auth.kind === "user-oauth",
).map((entry) => entry.key);

/** What runs on a key the fleet holds: there from boot, with nothing for anybody to connect. */
const ON_THE_FLEETS_KEY: ReadonlySet<string> = new Set(
  CATALOGUE.filter((entry) => entry.auth.kind === "deployment-key").map(
    (entry) => entry.key,
  ),
);

/**
 * A person's accounts as a turn reads them on a deployment that holds every vendor's client
 * (`readAccountStates`, `server/src/plugins/overview-routes.ts`): every account, in key order,
 * the named ones on.
 */
export function accountsWith(
  connected: readonly string[] = [],
): AccountState[] {
  return [...ACCOUNTS]
    .sort()
    .map((key) => ({ key, connected: connected.includes(key) }));
}

/**
 * The connect card as a window declares it (`app/src/components/gallery/connect.tsx`): every row
 * its build knows, whatever the deployment has.
 *
 * THE PARAMETERS ARE THE REAL ONES, read off the card's own schema through the conversion a window
 * sends it through (CopilotKit's `createToolSchema`, 2026-10-05): `services` is an enum, and that
 * enum is how a Bot learns which keys exist. The other cards in the pack carry an empty schema
 * because no scenario calls them; every scenario here calls this one.
 */
export function connectCard(): WireTool {
  return {
    name: CONNECT_CARD,
    description:
      "Put connection switches on screen and WAIT until the person turns one on, or says not now. Use when they ask to connect an account or site, or when what they asked needs one that is not connected. You are told which of them are connected now, and then you go on with what they asked. You cannot connect anything yourself.",
    parameters: {
      type: "object",
      properties: {
        services: {
          minItems: 1,
          maxItems: 3,
          type: "array",
          items: {
            type: "string",
            // Every row 연결 can draw: the accounts, and the sites a Bot signs into.
            enum: [...ACCOUNTS, ...BUSINESS_SITES.map((site) => site.id)],
          },
          description:
            "The connections to offer, most useful first: google-calendar, gmail, google-drive, google-sheets, notion, canva, kakao-playmcp (KakaoTalk to yourself, Talk Calendar, Kakao Map), google-business-profile and cafe24 are accounts; the rest are sites signed into on your own browser, such as naver-smartstore, naver-smartplace, baemin-ceo, coupang-wing or instagram",
        },
        reason: {
          description:
            "One short line in the person's language: what connecting lets you do for them now",
          type: "string",
        },
      },
      required: ["services"],
    },
  };
}

/**
 * The same cards with the connect card as a turn hands it to the Bot service: the window's card
 * with this person's accounts written on it, by the server's own `withAccountStates`
 * (`server/src/turns/chat-tools.ts`) — so a person made up for a scenario is made up the way a
 * real one is read.
 */
export function withTheConnectCard(
  cards: readonly WireTool[],
  accounts: readonly AccountState[] = accountsWith(),
): WireTool[] {
  const declared = connectCard();
  return cards.map((card) =>
    card.name === CONNECT_CARD
      ? {
          ...declared,
          parameters: withAccountStates(declared.parameters, accounts),
        }
      : card,
  );
}

/**
 * A connect card raised for accounts that are all on already: the server answers it at once, with
 * nobody waited for (`connectCard`, `server/src/turns/chat-tools.ts`) — `laf:connection_on` where
 * one of them has a tool in the run's list, `laf:connection_unusable` where none has. Undefined for
 * any other call, and for a card naming anything that is not on: that one is drawn, and waited on.
 */
export function answeredAtOnce(
  accounts: readonly AccountState[],
  tools: readonly WireTool[],
): (call: ObservedCall) => string | undefined {
  const on = accounts
    .filter((account) => account.connected)
    .map((account) => account.key);
  return (call) => {
    if (call.name !== CONNECT_CARD) return undefined;
    const offered = servicesOf(call);
    if (offered.length === 0 || offered.some((id) => !on.includes(id))) {
      return undefined;
    }
    return JSON.stringify(
      connectionAnswer({
        offered,
        connected: offered,
        isUsable: offered.some((id) =>
          tools.some((tool) => serverKeyOf(tool.name) === id),
        ),
      }),
    );
  };
}

/**
 * 톡캘린더, as a person who put it in their 카카오 toolbox would have it behind the bridge.
 *
 * INVENTED. 카카오's tool list is the person's own and this repository holds no adapter for it
 * (`server/src/plugins/catalogue.ts`, `kakao-playmcp`): the name and the words are made up, to
 * stand for a calendar that is connected and is not Google's.
 */
export const TALK_CALENDAR: WireTool = {
  name: "mcp__kakao-playmcp__list_talk_calendar_events",
  description:
    "톡캘린더의 일정을 기간으로 본다. 결과는 제목·시작·끝·장소가 든 목록.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "시작 날짜, YYYY-MM-DD" },
      to: { type: "string", description: "끝 날짜, YYYY-MM-DD" },
    },
  },
};

const servicesOf = (call: ObservedCall): string[] =>
  Array.isArray(call.arguments?.services)
    ? call.arguments.services.filter(
        (id): id is string => typeof id === "string",
      )
    : [];

/** A tool no person connected: a core tool, or one that runs on the fleet's own key. */
function isNobodysConnection(tool: WireTool): boolean {
  const key = serverKeyOf(tool.name);
  return key === null || ON_THE_FLEETS_KEY.has(key);
}

/**
 * What a chat turn hands the Bot of a person who has connected NOTHING: `everything` (the product's
 * whole schema) without the accounts' tools, then 목표's four — a chat turn offers those whatever
 * the window declared (`server/src/turns/chat-tools.ts`) — and the cards.
 *
 * 목표 and 기업마당 are why this is not "an empty bridge": they stand behind it on every deployment
 * that holds the fleet's keys, and a lookup that misses is answered differently for it.
 */
export function nothingConnected(
  everything: readonly WireTool[],
  cards: readonly WireTool[],
): WireTool[] {
  return [
    ...everything.filter(isNobodysConnection),
    ...GOAL_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    ...cards,
  ];
}

/**
 * The same turn for a person who has connected ONLY `keys`: those accounts' tools out of
 * `everything`, beside what nobody connects. The common person — one service connected, and
 * something asked that needs another (review, 2026-10-05: no scenario had one).
 */
export function onlyConnected(
  everything: readonly WireTool[],
  cards: readonly WireTool[],
  keys: readonly string[],
): WireTool[] {
  return [
    ...everything.filter((tool) => {
      const key = serverKeyOf(tool.name);
      return isNobodysConnection(tool) || (key !== null && keys.includes(key));
    }),
    ...GOAL_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    ...cards,
  ];
}

/** The same turn for a person who has connected every account. */
export function everythingConnected(
  everything: readonly WireTool[],
  cards: readonly WireTool[],
): WireTool[] {
  return [
    ...everything,
    ...GOAL_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
    ...cards,
  ];
}

/**
 * What the surface answers a Bot that looks at something else on the way: its routines and its
 * 목표, of which it has none ("일정" is also the word this product's prompt uses for a routine's
 * schedule, and the fleet's model opens both for it most runs), and the vendor's own site, which
 * is a sign-in wall. The pack's ordinary page is a shop's order list, and a Bot that opened Google
 * Calendar must not be handed three orders to read a schedule out of.
 */
export function nothingToRead(call: ObservedCall): string | undefined {
  if (call.name === "manage_routine" && call.arguments?.action === "list") {
    return toolResultText("laf:routine_list_empty");
  }
  // As `server/src/goals/tools.ts` answers a person with no goal yet.
  if (call.name === LIST_GOALS) return JSON.stringify({ ok: true, goals: [] });
  if (call.name !== "computer_navigate" && call.name !== "computer_read") {
    return undefined;
  }
  return JSON.stringify({
    ok: true,
    title: "로그인",
    url: String(call.arguments?.url ?? "https://accounts.google.com/"),
    text: "로그인\n계정으로 계속하려면 로그인하세요\n이메일 또는 휴대전화\n비밀번호\n로그인 상태 유지\n계정 만들기\n다음",
    truncated: false,
  });
}

/**
 * 노션, as a person who connected it would have it behind the bridge.
 *
 * INVENTED, like {@link TALK_CALENDAR}: 노션's tools are listed by its own server at connect and
 * this repository holds no copy of their words. It stands for a connected service that has nothing
 * to do with what is asked.
 */
export const NOTION_SEARCH: WireTool = {
  name: "mcp__notion__notion-search",
  description: "노션 워크스페이스에서 페이지와 데이터베이스를 찾는다.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "찾을 말" } },
    required: ["query"],
  },
};

/**
 * A lookup for a 지원사업's deadline, in words that also name the calendar: what
 * `deadline-is-not-the-calendar` starts from. `tests/eval-connect.test.ts` holds its answer to
 * leading with the calendar and carrying 기업마당's search — a table that stops reading 일정 here
 * leaves the scenario measuring nothing, and that test says so.
 */
export const DEADLINE_LOOKUP = "소상공인 지원사업 마감 일정";

/**
 * 기업마당's search answered with two notices that close this month, in the transport's own shape
 * (`server/src/plugins/public-data-rest.ts`, `searchPrograms`). A fixture, unlike the 지원사업
 * scenario's live portal: what is measured with it is whether a deadline is taken for the
 * calendar, not what the portal holds today.
 */
export function supportNotices(today: string): string {
  const month = today.slice(0, 8);
  return JSON.stringify({
    source: "기업마당",
    filters: { hashtags: "소상공인" },
    totalCount: 2,
    shown: 2,
    rows: [
      {
        id: "PBLN_000000000109871",
        title: "소상공인 스마트상점 기술보급사업 추가 모집 공고",
        agency: "중소벤처기업부",
        executor: "소상공인시장진흥공단",
        field: "경영",
        period: `${month}01 ~ ${month}24`,
        target: "소상공인",
        postedAt: `${month}01 09:00:00`,
        summary:
          "스마트기술(키오스크, 서빙로봇 등) 도입 비용의 일부를 지원한다.",
        url: "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_000000000109871",
      },
      {
        id: "PBLN_000000000109902",
        title: "희망리턴패키지 경영개선지원 사업 참여자 모집",
        agency: "중소벤처기업부",
        executor: "소상공인시장진흥공단",
        field: "경영",
        period: `${month}05 ~ ${month}28`,
        target: "소상공인",
        postedAt: `${month}02 10:00:00`,
        summary: "경영 위기 소상공인에게 진단과 개선 자금을 지원한다.",
        url: "https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_000000000109902",
      },
    ],
  });
}

/**
 * A call the product's turn waits on a person for: a card that asks (`GALLERY_DECISIONS`), or the
 * Bot handing over its browser. A run ends at one — the connect card above all, which is where
 * these scenarios are meant to end.
 */
export const asksThePerson = (call: ObservedCall): boolean =>
  GALLERY_DECISIONS.has(call.name) ||
  call.name === "computer_request_help" ||
  call.name === "computer_request_secret";

/* ── What a turn did about connecting ───────────────────────────────────────────────────────── */

export type ConnectTurn = {
  text: string;
  calls: readonly ObservedCall[];
  events: readonly StreamEvent[];
};

export type ConnectFacts = {
  /** What the Bot looked for through the bridge, in order. */
  searches: string[];
  /** What the first connect card offered, or null when none was raised. */
  offered: string[] | null;
  /** What every connect card of the turn offered, in the order they were raised. */
  cards: string[][];
  /**
   * How many times the model had been asked when the card went up, the request that raised it
   * included. Null when no card was raised.
   */
  requestsToTheCard: number | null;
  /** The first call that reached the surface: not a lookup, not the clock. */
  first: string | null;
};

/** The calls the Bot service answers itself, which never reach a surface. */
const ANSWERED_IN_THE_RUN: ReadonlySet<string> = new Set([TOOL_SEARCH, "now"]);

export function connectFactsOf(turn: ConnectTurn): ConnectFacts {
  const searches = turn.calls
    .filter((call) => call.name === TOOL_SEARCH)
    .map((call) => String(call.arguments?.query ?? ""));
  const raised = turn.calls.filter((call) => call.name === CONNECT_CARD);
  const card = raised[0];
  /*
   * A round's usage is said after its calls are on the wire (`agent-bot/src/run.ts`), so the
   * requests made by the time a card went up are the usage events before its start, and one more.
   */
  let requestsToTheCard: number | null = null;
  if (card) {
    let asked = 0;
    for (const event of turn.events) {
      if (event.type === "CUSTOM" && event.name === "laf.model.usage") {
        asked += 1;
      }
      if (event.type === "TOOL_CALL_START" && event.toolCallId === card.id) {
        requestsToTheCard = asked + 1;
        break;
      }
    }
  }
  return {
    searches,
    offered: card ? servicesOf(card) : null,
    cards: raised.map(servicesOf),
    requestsToTheCard,
    first:
      turn.calls.find((call) => !ANSWERED_IN_THE_RUN.has(call.name))?.name ??
      null,
  };
}

type Condition = [string, boolean];

/** How many requests a card may take: one to look, one to raise it. */
export const REQUESTS_TO_A_CARD = 2;

/**
 * THE SAME THING LOOKED FOR TWICE. `about` is the thing a scenario asks for, in the words a lookup
 * for it is written in: a second lookup with those words is the round this change exists to save.
 * A lookup for something else on the way — 목표, which a Bot asked about "일정" also opens — is not
 * the calendar looked for again, and is not counted. With no `about`, every lookup is.
 */
function lookedForAgain(facts: ConnectFacts, about?: RegExp): Condition {
  const same = about
    ? facts.searches.filter((query) => about.test(query))
    : facts.searches;
  return [
    `같은 것을 두 번 찾음 — ${same.map((query) => `"${query}"`).join(" → ")}`,
    same.length <= 1,
  ];
}

/**
 * THE SERVICE IS NOT CONNECTED AND THIS DEPLOYMENT CAN CONNECT IT: the card for that service, after
 * at most one look for it and two requests. What else the Bot read on the way is not judged by
 * name — a request spent on it before the card is, by the count.
 */
export function judgeCardOffered(
  turn: ConnectTurn,
  service: string,
  about?: RegExp,
): Condition[] {
  const facts = connectFactsOf(turn);
  const offered = facts.offered ?? [];
  return [
    [
      `연결 카드(showConnection)를 띄우지 않음 — 처음 닿은 호출: ${facts.first ?? "없음, 말로만 답함"}`,
      facts.offered !== null,
    ],
    [
      `카드가 ${service}를 먼저 권하지 않음 — 권한 것: ${offered.join(", ") || "없음"}`,
      offered[0] === service,
    ],
    lookedForAgain(facts, about),
    [
      `카드까지 모델을 ${facts.requestsToTheCard}번 부름 (${REQUESTS_TO_A_CARD}번까지)`,
      facts.requestsToTheCard === null ||
        facts.requestsToTheCard <= REQUESTS_TO_A_CARD,
    ],
  ];
}

/** What an answer that owns up says: it could not, or something is not connected or signed in. */
const OWNS_UP =
  /(못\s?[하했해합드봤봐]|지\s?못|수\s?(가|는)?\s?없|(방법|길|수단|곳|데)(이|은|도|가)?\s?없|어려[워우]|어렵|불가|안\s?[돼되]|연결|로그인|권한)/;

/**
 * A sentence that says there is none of the thing — no schedule, no mail — and gives no reason it
 * could not look. From a Bot that read no calendar, that is a claim about a calendar: "오늘 등록된
 * 일정이 없어요" was passed as owning up for a day, on the word 없 (review, 2026-10-05).
 */
export function claimsNothingThere(text: string): boolean {
  return text
    .split(/[.!?\n]+/)
    .some(
      (sentence) =>
        /(일정|약속|스케[줄쥴]|메일|편지)[^.!?\n]*없/.test(sentence) &&
        !OWNS_UP.test(sentence),
    );
}

/**
 * The Bot owned up: it could not see or do the thing, and says so — because something is not
 * connected, not signed in, or not possible. Never by saying there is nothing there
 * ({@link claimsNothingThere}). Loose on purpose, and the runs' own words are read beside it
 * (`EVAL_SHOW=1`).
 */
export function saysItCouldNot(text: string): boolean {
  return OWNS_UP.test(text) && !claimsNothingThere(text);
}

/**
 * NO CARD BELONGS HERE: the service is connected, the question needs none, or nothing this person
 * could connect would answer it. Held to raising none — a card for something else is the failure —
 * and to not looking twice for what one look answered.
 */
export function judgeNoCard(turn: ConnectTurn, about?: RegExp): Condition[] {
  const facts = connectFactsOf(turn);
  return [
    [
      `연결 카드를 띄움 — 권한 것: ${facts.cards.flat().join(", ") || "없음"}`,
      facts.cards.length === 0,
    ],
    lookedForAgain(facts, about),
  ];
}

/**
 * NOTHING HERE CAN BE CONNECTED FOR IT, OR NOBODY IS THERE TO PRESS A CARD: no card, and words that
 * say what could not be done. A Bot that goes to its browser instead is not judged here for going —
 * the page it reaches is a sign-in wall, and what it says after that is what is read.
 */
export function judgeSaysItCouldNot(
  turn: ConnectTurn,
  said: string,
  about?: RegExp,
): Condition[] {
  return [
    ...judgeNoCard(turn, about),
    ["아무 말도 하지 않음", said.trim().length > 0],
    [
      "보지 못한 것을 없다고 말함 — 연결되지 않은 것을 빈 것으로",
      !claimsNothingThere(said),
    ],
    [
      "하지 못했다는 말이 없음 — 무엇이 없거나 연결되지 않았는지",
      saysItCouldNot(said),
    ],
    ["알릴 것이 없다고 답함([SILENT])", !said.includes("[SILENT]")],
  ];
}
