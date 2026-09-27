/**
 * 아이디어 — things a Bot can do for somebody, written out so they can be pressed
 * (`~/laf/docs/muse-shape-plan-2026-09-27.md` §3.3, phase 5).
 *
 * WHAT A NEW PERSON IS MISSING is not a Bot that can do things; it is knowing what to ask. The first
 * chips answer that once, in an empty conversation. This is the same answer as a place of its own,
 * for as long as somebody wants it: a card says what the Bot will do, what it will make, and why it
 * is near the top for this person.
 *
 * A CATALOGUE IN CODE, AT NO MODEL COST. Muse ranks generated ideas per person; this is the layer
 * under that — the set a fresh account is shown — and nothing more. Nothing here calls a model until
 * a card is pressed, and a press only puts the sentence in the composer: nothing is sent.
 *
 * THE SAME SET FOR EVERYONE, ORDERED BY WHO THEY SAID THEY ARE (`shared/persona.ts`). A 사장님 sees
 * the shop's jobs first and a 학생 the study ones, and each can scroll to the other's; `orderIdeas`
 * never drops a card. What a deployment CANNOT do drops one — a card whose connection this
 * deployment offers no door to, or whose tool the Bot does not hold (`server/src/ideas/`) — and that
 * is the same for every persona.
 *
 * EVERY CARD IS SOMETHING A FRESH BOT CAN DO. The ones with no `needs` go to a public page on the
 * Bot's own computer (네이버 검색, 날씨, 네이버 쇼핑, 국세청's and 고용노동부's pages through the
 * 세금노무 skill) or come from the model's own head; the one that reads a file says so. A card with
 * `needs` is drawn with 연결하면 할 수 있어요 and leads to 연결 until one of them is connected — the way
 * the first chips treat a place somebody picked and has not connected.
 *
 * TWO KINDS, NOT THREE. The plan names ask, routine and connect; connect is not a kind of card here
 * but a state any card with `needs` is in until a connection answers it, so a card never changes
 * kind when somebody connects 배민.
 *
 * A ROUTINE'S SENTENCE CARRIES A TIME. `manage_routine` makes a routine only when a time is said, and
 * a sentence without one would be answered once and never again. So the composer gets "매일 아침
 * 8시에 …", which somebody can change before sending, and the card says so — the plan's "시간을 정해
 * 말씀해 주세요", said as the thing already done for them.
 *
 * WORDS ARE THE SURFACE'S. `title` (the Bot's voice), `makes` (what comes out) and `sentence` (the
 * person's voice, what lands in the composer) are English keys with Korean in
 * `app/src/lib/i18n-ko.ts`, read through `t(variable)` — so `app/tests/ideas.test.ts` walks them.
 * Where a first chip already says the sentence (`first-tasks.ts`), the key is the same one.
 *
 * NO IMPORTS BEYOND `shared/`: the server reads this table to decide what is on offer, and the app to
 * say it.
 */
import { type Category, categoryOrder, type Persona } from "../persona";

/** A connection that makes a card answerable. `id` is a site or OAuth catalogue key. */
export type IdeaNeed = { kind: "site" | "account"; id: string };

export type IdeaEntry = {
  /** Stable. What a dismissal latches on, as `idea:<key>`. */
  key: string;
  category: Category;
  /** Whom it is put first for. Ordering only: every persona is shown every card. */
  lead: readonly Persona[];
  /** `routine`: the sentence sets a time, and the Bot makes a routine of it. */
  kind: "ask" | "routine";
  /** One of these connected makes it answerable. Empty: nothing is needed. */
  needs: readonly IdeaNeed[];
  /** A tool the Bot has to hold — a grant the deployment makes, never one a person connects. */
  tool?: string;
  /** What the Bot will do, in its own voice. */
  title: string;
  /** What comes out of it. */
  makes: string;
  /** What goes into the composer, in the person's voice. */
  sentence: string;
};

/** The dismissal's key, on `laf_routine_suggestion_dismissals` beside the routine suggestions'. */
export const IDEA_DISMISSAL_PREFIX = "idea:";

/** The 기업마당 search, granted on the fleet's key (`server/src/plugins/public-data-rest.ts`). */
export const SUPPORT_PROGRAMS_TOOL_REF = "public-data/search_support_programs";

const site = (id: string): IdeaNeed => ({ kind: "site", id });
const account = (id: string): IdeaNeed => ({ kind: "account", id });

/** Where reviews come in: the delivery apps, 스마트플레이스 and the Google profile. */
const REVIEWS = [
  site("baemin-ceo"),
  site("coupangeats-store"),
  site("yogiyo-ceo"),
  site("naver-smartplace"),
  account("google-business-profile"),
];

/** Where money is settled: the delivery apps, the card gateway and the online stores. */
const SETTLEMENTS = [
  site("baemin-ceo"),
  site("coupangeats-store"),
  site("yogiyo-ceo"),
  site("tosspayments"),
  site("naver-smartstore"),
  site("coupang-wing"),
  site("cafe24-admin"),
  account("cafe24"),
];

/** Where orders are placed: the online stores. */
const ORDERS = [
  site("naver-smartstore"),
  site("coupang-wing"),
  site("cafe24-admin"),
  account("cafe24"),
];

/**
 * In the order a person with no answer yet reads them within a category. The owners' jobs are
 * `korean-smb-needs-2026-09.md` §7 — reviews, 지원사업, settlement, orders, the ledger and the tax
 * calendar — cut to what a Bot can do today: the ledger reads a file somebody attaches (a photo is
 * only its name to the model), and 발주확인 waits for the Commerce API.
 */
export const IDEAS: readonly IdeaEntry[] = [
  {
    key: "review-replies",
    category: "work",
    lead: ["owner"],
    kind: "routine",
    needs: REVIEWS,
    title: "I'll gather new reviews every morning and draft the replies",
    makes:
      "A list each morning with reply drafts. Nothing is posted until you say so.",
    sentence:
      "Every morning at 8, gather yesterday's new reviews and draft a reply to each.",
  },
  {
    key: "support-programs",
    category: "money",
    lead: ["owner"],
    kind: "ask",
    needs: [],
    tool: SUPPORT_PROGRAMS_TOOL_REF,
    title: "I'll find the support programmes your business could apply for",
    makes: "Notices with their deadlines and amounts. No login needed.",
    sentence:
      "Find the government support programmes our shop could apply for.",
  },
  {
    key: "settlement-check",
    category: "money",
    lead: ["owner"],
    kind: "routine",
    needs: SETTLEMENTS,
    title: "I'll check every Monday that your settlements came in right",
    makes: "A weekly message naming only what does not add up.",
    sentence:
      "Every Monday at 9am, check last week's settlements and tell me only what does not add up.",
  },
  {
    key: "orders-today",
    category: "work",
    lead: ["owner"],
    kind: "ask",
    needs: ORDERS,
    title: "I'll sort out today's orders",
    makes: "Orders by state, and the ones that need you.",
    sentence: "Sort out the orders that came in today.",
  },
  {
    key: "listing-check",
    category: "work",
    lead: ["owner"],
    kind: "ask",
    needs: [],
    title: "I'll check the hours and number Naver shows for your shop",
    makes: "What Naver shows, and anything that looks out of date.",
    sentence:
      "Search Naver for our shop and check the opening hours and phone number it shows. The shop's name: ",
  },
  {
    key: "store-intro",
    category: "work",
    lead: ["owner"],
    kind: "ask",
    needs: [],
    title: "I'll write three introductions for your shop",
    makes: "Three versions to choose from.",
    sentence: "Write three short introductions for our shop.",
  },
  {
    key: "sales-by-weekday",
    category: "money",
    lead: ["owner"],
    kind: "ask",
    needs: [],
    title: "Attach a sales file and I'll sort it by weekday",
    makes:
      "A table by weekday. Attach the Excel or CSV file with the paper clip.",
    sentence:
      "Sort the sales file I'm attaching by weekday, and tell me the busiest and quietest days.",
  },
  {
    key: "price-compare",
    category: "money",
    lead: ["owner"],
    kind: "ask",
    needs: [],
    title: "I'll compare prices on Naver Shopping",
    makes: "The five lowest prices, with links.",
    sentence:
      "Compare the five lowest prices on Naver Shopping for this product: ",
  },
  {
    key: "holiday-pay",
    category: "money",
    lead: ["owner"],
    kind: "ask",
    needs: [],
    title: "I'll work out weekly holiday pay by the official rules",
    makes: "The sum with every step shown, and the page it came from.",
    sentence:
      "Work out a part-timer's weekly holiday pay. Hourly wage: ○○ won. Hours a week: ○○.",
  },
  {
    key: "tax-dates",
    category: "money",
    lead: ["owner"],
    kind: "ask",
    needs: [],
    title: "I'll list the tax deadlines left this year",
    makes: "Dates read off the National Tax Service's own pages.",
    sentence:
      "From the National Tax Service's pages, list the tax filing deadlines left this year for a sole proprietor.",
  },
  {
    key: "unanswered-mail",
    category: "work",
    lead: ["worker"],
    kind: "ask",
    needs: [account("gmail")],
    title: "I'll pick out the mail that still needs a reply",
    makes: "One line on what each of them asks.",
    sentence: "Show me the mail nobody has answered.",
  },
  {
    key: "tomorrow-calendar",
    category: "life",
    lead: ["worker"],
    kind: "routine",
    needs: [account("google-calendar")],
    title: "I'll tell you tomorrow's schedule every evening",
    makes: "One message each evening.",
    sentence: "Every evening at 9, tell me what is on my calendar tomorrow.",
  },
  {
    key: "news-digest",
    category: "work",
    lead: ["worker"],
    kind: "routine",
    needs: [],
    title: "I'll sum up the news in your field in three lines every morning",
    makes: "Three lines and their links, each morning.",
    sentence: "Every morning at 8, sum up the news about ○○ in three lines.",
  },
  {
    key: "decline-mail",
    category: "relationships",
    lead: ["worker"],
    kind: "ask",
    needs: [],
    title: "I'll draft a polite email saying no",
    makes: "A draft to edit. Nothing is sent.",
    sentence: "Draft a polite email turning down a request.",
  },
  {
    key: "meeting-minutes",
    category: "work",
    lead: ["worker"],
    kind: "ask",
    needs: [],
    title: "I'll make you a template for meeting minutes",
    makes: "A template to copy.",
    sentence: "Make a template for meeting minutes.",
  },
  {
    key: "year-end-tax",
    category: "money",
    lead: ["worker"],
    kind: "ask",
    needs: [],
    title:
      "I'll list the year-end tax deductions to check, by the official rules",
    makes: "A checklist, each item with the page it came from.",
    sentence:
      "From the National Tax Service's pages, list the deductions an employee should check for the year-end tax settlement.",
  },
  {
    key: "study-plan",
    category: "study",
    lead: ["student"],
    kind: "ask",
    needs: [],
    title: "I'll plan your study backwards from the exam date",
    makes: "A table, day by day.",
    sentence: "Make me a study plan counting back from my exam date.",
  },
  {
    key: "word-quiz",
    category: "study",
    lead: ["student"],
    kind: "routine",
    needs: [],
    title: "I'll quiz you on ten English words every evening",
    makes: "A quiz in the conversation each evening.",
    sentence: "Every evening at 9, quiz me on ten English words.",
  },
  {
    key: "scholarships",
    category: "money",
    lead: ["student"],
    kind: "ask",
    needs: [],
    title: "I'll look for scholarships you can apply for now",
    makes: "A list by deadline, with links.",
    sentence:
      "Search Naver for scholarships a university student can apply for now, and list them by deadline.",
  },
  {
    key: "report-outline",
    category: "study",
    lead: ["student", "worker"],
    kind: "ask",
    needs: [],
    title: "I'll outline a report or an assignment",
    makes: "An outline and a first draft to build on.",
    sentence: "Outline a report on this topic and write a first draft: ",
  },
  {
    key: "monthly-budget",
    category: "money",
    lead: ["student", "other"],
    kind: "ask",
    needs: [],
    title: "I'll make a table for a month's spending",
    makes: "A table to fill in, with the totals.",
    sentence:
      "Make me a table for a month's spending. My income is ○○ won a month.",
  },
  {
    key: "weather-umbrella",
    category: "life",
    lead: ["other"],
    kind: "routine",
    needs: [],
    title:
      "I'll tell you the weather every morning, and whether to take an umbrella",
    makes: "One message each morning.",
    sentence:
      "Every morning at 7:30, tell me today's weather and whether I need an umbrella.",
  },
  {
    key: "weekend-outing",
    category: "life",
    lead: ["other", "student"],
    kind: "ask",
    needs: [],
    title: "I'll plan a weekend outing around the weather",
    makes: "The weekend's forecast and a half-day plan.",
    sentence:
      "Check this weekend's weather on Naver and plan a half-day outing near me.",
  },
  {
    key: "stretch-reminder",
    category: "health",
    lead: ["other", "worker"],
    kind: "routine",
    needs: [],
    title: "I'll remind you to stretch every afternoon",
    makes: "A short reminder with three stretches.",
    sentence:
      "Every afternoon at 3, remind me to stretch and suggest three simple stretches.",
  },
  {
    key: "thank-you-message",
    category: "relationships",
    lead: ["other"],
    kind: "ask",
    needs: [],
    title: "I'll write a thank-you or congratulations message",
    makes: "Three versions, from warm to formal.",
    sentence: "Write a message for this occasion in three tones: ",
  },
];

export function ideaByKey(key: string): IdeaEntry | undefined {
  return IDEAS.find((idea) => idea.key === key);
}

/**
 * The cards in the order this person reads them: the ones that lead for who they said they are,
 * then by the categories in their order (`categoryOrder`), then the table's own order; a card
 * somebody can do now before one that waits on a connection, inside each of those.
 *
 * DETERMINISTIC, AND NEVER A FILTER. The same person sees the same order twice, and every persona
 * gets back exactly the keys it was handed — `app/tests/ideas.test.ts` holds both.
 */
export function orderIdeas<T extends { key: string; ready?: boolean }>(
  cards: readonly T[],
  persona: Persona | null,
): T[] {
  const categories = categoryOrder(persona);
  const index = new Map(IDEAS.map((idea, at) => [idea.key, at]));
  const rank = (card: T) => {
    const idea = ideaByKey(card.key);
    return [
      idea && persona && idea.lead.includes(persona) ? 0 : 1,
      card.ready === false ? 1 : 0,
      idea ? categories.indexOf(idea.category) : categories.length,
      index.get(card.key) ?? IDEAS.length,
    ];
  };
  return [...cards].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let at = 0; at < left.length; at += 1) {
      const difference = (left[at] ?? 0) - (right[at] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
}
