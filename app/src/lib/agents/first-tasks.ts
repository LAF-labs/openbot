import {
  AGENT_PRESETS,
  shopWorkOrder,
  WORK_PATTERNS,
  type WorkPatternId,
} from "@/lib/agents/presets";
import type { AgentProfile } from "@/lib/agents/queries";
import type { ChannelSummary } from "@/lib/channels/queries";
import type { ConnectionsOverview } from "@/lib/connections/queries";
import { ko } from "@/lib/i18n-ko";
import { routineRequest } from "@/lib/routines/queries";
import {
  dailyPlaceById,
  EMPTY_SHOP,
  placeIsConnected,
  placeIsOffered,
  type ShopProfile,
} from "@/lib/shop/catalogue";
import { BUSINESS_SITES } from "@/lib/sites/catalogue";

/**
 * The first things worth asking a Bot that has never been asked anything.
 *
 * A new Bot arrives with a name and a face and an empty composer, and the honest state of the
 * person in front of it is "I don't know what to type". The launch definition (L3) is a useful
 * answer inside ten minutes of signing up, and the ten minutes are mostly spent on that blank.
 * So the empty conversation offers four sentences to press, chosen from the eight work patterns
 * by what this person has actually connected and by what the Bot has been told it is for — and a
 * fifth that turns the first of them into a morning routine.
 *
 * THE CONNECTION STATE DECIDES, NOT THE CATALOGUE. A chip for 스마트플레이스 in front of somebody
 * who has never signed the Bot's browser into it sends the Bot to a login wall it cannot get past,
 * and the first thing the product ever did for them is fail. A site is offered only while the
 * overview says `connected` — `needs_login` is a session that has lapsed and is exactly the case
 * the chip must not be drawn for — and an OAuth account only while it says `connected` rather than
 * `needs_reconnect`. With nothing connected, the chips are sentences a Bot can answer from its own
 * head, plus one that goes to the 연결 screen.
 *
 * THE ROLE IS A HINT, NOT A FILTER. A Bot whose card says 리뷰 답변 leads with a reviews sentence,
 * but the other three chips are still three other kinds of work: the card was pressed a minute ago
 * on a guess, and four chips about reviews would tell somebody the guess is binding.
 *
 * ONLY ONCE. The chips are for a Bot nobody has spoken to. A Bot with a conversation behind it has
 * shown what it can do, and a screen that keeps suggesting first tasks to somebody on their fifth
 * conversation is a screen that has not noticed them.
 *
 * THE SHOP ANSWERS ORDER, THEY DO NOT FILTER. What the person said on the first run — the trade and
 * the places they use every day (`shared/shop/catalogue.ts`) — puts those kinds of work after the
 * Bot's own role and before everything else, and puts a picked place's sentence ahead of another
 * connected site's in the same kind of work. The row is still four sentences. And a place they
 * picked that the Bot cannot use yet is the one thing worth doing before any of them, so its
 * connect chip goes first — only for a place this deployment can actually connect.
 *
 * Every sentence here is an English key with Korean in `i18n-ko.ts`, read through `t(variable)`
 * where it is drawn — invisible to `i18n-coverage.test.ts`, so `first-tasks.test.ts` walks these
 * tables the way `agent-presets.test.ts` walks the presets.
 */

export type FirstTask =
  | {
      kind: "ask";
      pattern: WorkPatternId;
      /** English key. `t()` it at the point of sending; the Bot is asked in Korean. */
      sentence: string;
      /** The connection that made this sentence answerable, or null when none is needed. */
      via: { kind: "site" | "account"; id: string } | null;
    }
  | {
      kind: "connect";
      /**
       * The daily place this chip is for — one the person picked on the first run or in Settings
       * that no door of is connected yet. Absent is the general "connect a site" chip.
       */
      place?: string;
    };

type Sentence = { pattern: WorkPatternId; sentence: string };

/**
 * How many sentence chips the empty conversation shows.
 *
 * Four, with the connect chip and the routine chip beside them making five or six pressable things.
 * Three read as a choice and was the first number tried; it left a Bot with one site connected
 * showing that site and two generic sentences, which is one kind of work and two fillers. Four is
 * still a short column: measured at 800px wide, a Korean sentence of eighteen characters fills
 * the card's width on its own, so the chips stack one under another, on a phone and here alike.
 */
export const FIRST_TASK_COUNT = 4;

/**
 * One sentence per pattern that a Bot can answer with nothing connected at all.
 *
 * In the order they are offered when nothing narrows it: the first four are what somebody with
 * nothing connected sees, so they are the four that are worth having beside anything. A role hint
 * moves its own pattern's sentence to the front and leaves the rest in this order.
 *
 * Every one of them is answerable from the model's own head in one turn — no site, no account, no
 * file. A sentence here that needs something the Bot does not have is a first task that fails.
 */
export const NO_CONNECTION_TASKS: readonly Sentence[] = [
  {
    pattern: "schedule",
    sentence: "Tell me today's date and this week's public holidays.",
  },
  {
    pattern: "reputation",
    sentence: "Write three short introductions for our shop.",
  },
  {
    pattern: "night-watch",
    sentence: "Make a checklist for opening up tomorrow morning.",
  },
  {
    pattern: "enquiries",
    sentence: "Draft a polite reply to a customer asking about a refund.",
  },
  {
    pattern: "settlement",
    sentence: "Make a simple table I can fill in with each day's sales.",
  },
  {
    pattern: "stock",
    sentence: "Make a checklist for counting the stock we use every week.",
  },
  {
    pattern: "approval",
    sentence:
      "Draft a notice about a holiday closure for me to check before it goes up.",
  },
  {
    pattern: "paperwork",
    sentence:
      "Tell me which receipts a small business has to keep, and for how long.",
  },
];

/**
 * The first thing to ask through each OAuth account, keyed by the catalogue key the overview
 * reports as the account's `id`.
 *
 * Sites carry their own `prompts` in `shared/sites/catalogue.ts`; the OAuth catalogue is the
 * server's and carries none, so the sentence lives here. Where a site already says the same thing
 * the key is reused rather than reworded — cafe24 is one shop whichever door the Bot comes in by.
 */
export const ACCOUNT_FIRST_TASKS: Readonly<Record<string, Sentence>> = {
  gmail: {
    pattern: "enquiries",
    sentence: "Show me the mail nobody has answered.",
  },
  "google-business-profile": {
    pattern: "reputation",
    sentence: "Sort out the reviews that came in this week.",
  },
  "google-calendar": {
    pattern: "schedule",
    sentence: "Tell me what is on the calendar tomorrow.",
  },
  "google-sheets": {
    pattern: "settlement",
    sentence: "Read my spreadsheet and tell me what stands out.",
  },
  "google-drive": {
    pattern: "paperwork",
    sentence: "Tell me which files were added to Drive this week.",
  },
  notion: {
    pattern: "paperwork",
    sentence: "Sum up what changed in Notion this week.",
  },
  cafe24: {
    pattern: "enquiries",
    sentence: "Sort out the orders that came in today.",
  },
};

type Candidate = Sentence & { via: NonNullable<FirstTaskAsk["via"]> };
type FirstTaskAsk = Extract<FirstTask, { kind: "ask" }>;

/**
 * Words on a Bot's card that say which kind of work it is for.
 *
 * For the card somebody typed themselves. A preset is matched exactly (below); this is for
 * "리뷰 답변 담당" written by hand. Substrings, lower-cased, walked in the patterns' own order, the
 * first hit wins. Deliberately short: "주문" is orders to a shop and purchase orders to a
 * supplier, and "답변" is a reply to a review as much as to an enquiry, so neither is on any
 * list, and a card that matches nothing simply gets the general four.
 */
const ROLE_WORDS: Readonly<Record<WorkPatternId, readonly string[]>> = {
  "night-watch": ["야간", "밤새", "당직", "감시", "overnight", "watch"],
  approval: ["결재", "승인", "검토", "approv", "before it goes out"],
  settlement: ["정산", "매출", "입금", "장부", "settlement", "reconcil"],
  enquiries: ["문의", "응대", "enquir", "inquir"],
  schedule: [
    "예약",
    "일정",
    "스케줄",
    "근무",
    "booking",
    "appointment",
    "calendar",
    "schedule",
  ],
  stock: ["재고", "발주", "stock", "inventory"],
  reputation: ["리뷰", "후기", "평판", "review"],
  paperwork: [
    "서류",
    "영수증",
    "세금",
    "세무",
    "계약",
    "receipt",
    "tax",
    "paperwork",
    "filing",
  ],
};

/**
 * The kind of work a Bot's card says it is for, or null when the card says nothing.
 *
 * A preset first. The intro card writes `t(preset.title)` and `t(preset.roleDescription)` onto the
 * profile, so the profile holds whichever language `t()` spoke that day — and the person may have
 * changed language since. Both forms the product has ever written are compared: the English key and
 * its Korean, read from the table directly rather than through `t()`, so the answer does not depend
 * on today's locale. Then the words, for a card written by hand.
 */
export function roleHint(
  profile: Pick<AgentProfile, "title" | "roleDescription">,
): WorkPatternId | null {
  const title = profile.title.trim();
  const role = profile.roleDescription.trim();
  if (!title && !role) return null;

  for (const preset of AGENT_PRESETS) {
    const titles = [preset.title, ko[preset.title]];
    const roles = [preset.roleDescription, ko[preset.roleDescription]];
    if ((title && titles.includes(title)) || (role && roles.includes(role))) {
      return preset.pattern;
    }
  }

  const text = `${title} ${role}`.toLowerCase();
  for (const pattern of WORK_PATTERNS) {
    if (ROLE_WORDS[pattern.id].some((word) => text.includes(word))) {
      return pattern.id;
    }
  }
  return null;
}

/**
 * The eight patterns: the hinted one first, then the shop's, then the rest in their own order.
 *
 * The Bot's own card outranks the shop: it is about THIS Bot, and a person who made a reviews Bot
 * for a restaurant wants reviews first, not the restaurant's settlement.
 */
function patternOrder(
  hint: WorkPatternId | null,
  shopPatterns: readonly WorkPatternId[],
): WorkPatternId[] {
  const order: WorkPatternId[] = [];
  const add = (id: WorkPatternId) => {
    if (!order.includes(id)) order.push(id);
  };
  if (hint) add(hint);
  for (const id of shopPatterns) add(id);
  for (const pattern of WORK_PATTERNS) add(pattern.id);
  return order;
}

/**
 * Where a connection stands among the places the person picked: its index in their pick order, or
 * past the end for a connection that belongs to no picked place.
 */
function pickedRank(
  via: Candidate["via"],
  placesInPickOrder: readonly string[],
): number {
  const index = placesInPickOrder.findIndex((id) =>
    dailyPlaceById(id)?.connections.some(
      (door) => door.kind === via.kind && door.id === via.id,
    ),
  );
  return index < 0 ? placesInPickOrder.length : index;
}

/**
 * The first place the person picked that this deployment could connect and nothing connects yet.
 *
 * `placeIsOffered` first: a place with no door on this deployment — no browser behind it, or a
 * vendor the fleet registered no application with — has nothing to press on 연결, and a chip that
 * leads there is a promise the screen cannot keep.
 */
function firstUnconnectedPlace(
  overview: Pick<ConnectionsOverview, "sites" | "accounts">,
  placesInPickOrder: readonly string[],
): string | null {
  for (const id of placesInPickOrder) {
    const place = dailyPlaceById(id);
    if (!place) continue;
    if (placeIsOffered(place, overview) && !placeIsConnected(place, overview)) {
      return id;
    }
  }
  return null;
}

/**
 * Everything this person has connected that has a first sentence to go with it — the places they
 * picked first, in the order they picked them, and everything else after in its own order.
 */
function connectedCandidates(
  overview: Pick<ConnectionsOverview, "sites" | "accounts">,
  placesInPickOrder: readonly string[] = [],
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const site of overview.sites) {
    if (site.status !== "connected") continue;
    const entry = BUSINESS_SITES.find((known) => known.id === site.id);
    const sentence = entry?.prompts[0];
    if (!entry || !sentence) continue;
    candidates.push({
      pattern: entry.category,
      sentence,
      via: { kind: "site", id: site.id },
    });
  }
  for (const account of overview.accounts) {
    if (account.kind !== "oauth" || account.status !== "connected") continue;
    const known = ACCOUNT_FIRST_TASKS[account.id];
    if (!known) continue;
    candidates.push({ ...known, via: { kind: "account", id: account.id } });
  }
  // Stable: with nothing picked every rank is the same, and the order is the one it always was.
  return candidates.sort(
    (a, b) =>
      pickedRank(a.via, placesInPickOrder) -
      pickedRank(b.via, placesInPickOrder),
  );
}

/**
 * The chips for this Bot, in the order they are drawn.
 *
 * DETERMINISTIC ON PURPOSE. The preset chips on the intro card are dealt at random and held in
 * state; these are not, because the same person opening the same screen twice should see the same
 * four, and because the routine chip repeats the first one — a sentence that moved between reloads
 * would make "the same sentence, every morning" a lie.
 *
 * One pattern at a time: the eight patterns are walked with the hinted one first, and the first
 * connected sentence under each is taken, then a second round for whatever is left. Four chips
 * that are all reviews read as a product about reviews. The same sentence is never offered twice,
 * whichever door it came through. What is still short is filled from the connection-free table,
 * the hinted pattern's sentence first; with nothing connected at all, the connect chip follows.
 */
export function pickFirstTasks(
  overview: Pick<ConnectionsOverview, "sites" | "accounts">,
  options: {
    hint?: WorkPatternId | null;
    count?: number;
    /** What the person answered about the business. Absent or empty changes nothing. */
    shop?: ShopProfile;
  } = {},
): FirstTask[] {
  const count = options.count ?? FIRST_TASK_COUNT;
  const shop = options.shop ?? EMPTY_SHOP;
  const shopPatterns = shopWorkOrder(shop).patterns;
  const order = patternOrder(options.hint ?? null, shopPatterns);
  const candidates = connectedCandidates(overview, shop.places);

  const picked: FirstTask[] = [];
  const taken = new Set<string>();
  const offer = (task: Sentence, via: FirstTaskAsk["via"]) => {
    if (picked.length >= count || taken.has(task.sentence)) return;
    taken.add(task.sentence);
    picked.push({ kind: "ask", ...task, via });
  };

  // `round` walks down each pattern's candidates; patterns that run out are simply skipped.
  for (let round = 0; picked.length < count; round += 1) {
    const before = picked.length;
    for (const pattern of order) {
      const candidate = candidates.filter((known) => known.pattern === pattern)[
        round
      ];
      if (candidate) offer(candidate, candidate.via);
    }
    if (picked.length === before) break;
  }

  /*
   * Padding, in tiers and otherwise in table order (`sort` is stable): the hinted pattern's
   * sentence, then the shop's kinds of work in the shop's own order, then the patterns nothing
   * above covers yet, then the ones something does. A review site connected and 소개 문구 beside it
   * is half a row about reviews; the hint leads only when no connected chip already speaks for it.
   */
  const covered = new Set(
    picked.map((task) => (task.kind === "ask" ? task.pattern : null)),
  );
  const tier = (task: Sentence) => {
    if (covered.has(task.pattern)) return 3;
    if (task.pattern === options.hint) return 0;
    const inShop = shopPatterns.indexOf(task.pattern);
    // Within the shop tier, the shop's own order: 1.0 for its first kind of work, under 2 for its last.
    return inShop < 0 ? 2 : 1 + inShop / (shopPatterns.length + 1);
  };
  const padding = [...NO_CONNECTION_TASKS].sort((a, b) => tier(a) - tier(b));
  for (const task of padding) offer(task, null);

  /*
   * A picked place nothing connects yet goes FIRST — the one act that turns the sentences after it
   * from generic into this shop's. It stands in for the general connect chip, which is for
   * somebody with nothing connected and nothing picked to point them at.
   */
  const unconnected = firstUnconnectedPlace(overview, shop.places);
  if (unconnected) return [{ kind: "connect", place: unconnected }, ...picked];
  if (candidates.length === 0) picked.push({ kind: "connect" });
  return picked;
}

/** The sentence the routine chip repeats: the first chip that asks something. */
export function routineSentence(tasks: readonly FirstTask[]): string | null {
  for (const task of tasks) {
    if (task.kind === "ask") return task.sentence;
  }
  return null;
}

/**
 * Whether this would be the first thing ever said to the Bot.
 *
 * A channel is created on the first send, so a channel holding the Bot is very nearly the same
 * fact — but not quite: a channel whose creation succeeded and whose first message did not is a
 * conversation with nothing in it, and the Bot in it has still never been asked anything. What
 * decides is whether anything was said.
 */
export function isFirstConversation(
  channels: readonly Pick<ChannelSummary, "agentIds" | "lastMessageAt">[],
  botId: string,
): boolean {
  return !channels.some(
    (channel) =>
      channel.agentIds.includes(botId) && channel.lastMessageAt !== null,
  );
}

/**
 * What is recorded when a chip is pressed: a browser event, and one row on the server.
 *
 * The event came first, on the reasoning that "did the chips shorten the first ten minutes" could
 * be answered from a console. It cannot be answered from the fleet that way, and the fleet is who
 * asks — laf-control's `insights` counts which of the eight kinds of work people pick, VM by VM —
 * so the press is also posted to `POST /api/me/first-task` (`server/src/agents/first-task.ts`).
 *
 * THE EVENT CARRIES THE SENTENCE'S KEY; THE REQUEST DOES NOT. `kind`, `pattern` and `via` already
 * name the sentence exactly — one per pattern with nothing connected, one per site, one per
 * account — so the server is given those and never a sentence, and a field that could someday hold
 * somebody's own words does not exist on the wire to hold them.
 */
export const FIRST_TASK_PRESSED = "laf:first-task-pressed";

export type FirstTaskPressed = {
  agentId: string;
  kind: "ask" | "routine" | "connect";
  pattern: WorkPatternId | null;
  /** The English key of the sentence, or null for the connect chip. */
  sentence: string | null;
  via: FirstTaskAsk["via"];
  /** What the Bot's card suggested, so the two can be compared later. */
  hint: WorkPatternId | null;
};

/** What `POST /api/me/first-task` is sent: the press without its sentence. */
export type FirstTaskPressBody = Omit<FirstTaskPressed, "sentence">;

export function firstTaskPressBody(
  detail: FirstTaskPressed,
): FirstTaskPressBody {
  return {
    agentId: detail.agentId,
    kind: detail.kind,
    pattern: detail.pattern,
    via: detail.via,
    hint: detail.hint,
  };
}

export function reportFirstTaskPressed(
  detail: FirstTaskPressed,
  // A parameter so a test can listen on a target of its own; the screen passes nothing.
  target: EventTarget | null = typeof window === "undefined" ? null : window,
  // `fetch` looked up at the moment of the press, and called as itself rather than detached.
  send: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    fetch(url, init),
): void {
  target?.dispatchEvent(
    new CustomEvent<FirstTaskPressed>(FIRST_TASK_PRESSED, { detail }),
  );
  /*
   * Not awaited, and nothing is said when it fails. The press has already done what the person
   * asked — the sentence is on its way to the Bot — and a count that did not land is a missing
   * count, not something to put in front of somebody on the first screen of their first Bot.
   * `keepalive` because the connect chip is a navigation, and the row should not depend on it.
   */
  void (async () => {
    try {
      await send("/api/me/first-task", {
        method: "POST",
        credentials: "include",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(firstTaskPressBody(detail)),
      });
    } catch {
      // See above: nothing to tell anybody.
    }
  })();
}

/** When the morning report arrives, on the wall clock of the person's own zone. */
export const MORNING_REPORT_TIME = "07:30";

export type MorningReport = {
  agentId: string;
  /** Already translated: it becomes the routine's own name, shown on every screen. */
  name: string;
  /** Already translated: the routine says this to the Bot every morning. */
  instruction: string;
  timeZone: string;
};

/**
 * The body `POST /api/routines` takes, built the way the Routines page builds its own.
 *
 * Nothing but the four fields the server reads. In particular no `days` — every day is the absence
 * of a restriction, and the server refuses an empty list on purpose — and nothing about the
 * webhook, whose token the server mints and shows once; this screen never draws that box.
 */
export function morningReportPayload(report: MorningReport) {
  return {
    agentId: report.agentId,
    name: report.name,
    instruction: report.instruction,
    schedule: {
      kind: "daily" as const,
      time: MORNING_REPORT_TIME,
      timeZone: report.timeZone,
    },
  };
}

/** Make the routine, through the same request and the same refusal table the Routines page uses. */
export async function makeMorningReport(report: MorningReport) {
  return routineRequest("/api/routines", {
    method: "POST",
    body: JSON.stringify(morningReportPayload(report)),
  });
}
