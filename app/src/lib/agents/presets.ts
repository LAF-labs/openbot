/**
 * A Bot you could have, described in one line.
 *
 * Creating a colleague from an empty form asks somebody to invent a job and a paragraph of standing
 * instructions before they have seen the product do anything, and the honest answer to "what should
 * this Bot help with?" for most people is "I don't know what it can do yet". These are jobs that
 * already exist, written out so that picking one fills the form and the next click is Get started.
 *
 * Not templates in any deeper sense: a preset writes four fields and then it is gone. What it
 * produces is an ordinary Bot with no memory of having been a preset, editable like any other, and
 * free to become something else entirely the moment somebody tells it to.
 *
 * THE EIGHT GROUPS ARE THE BUSINESS PLAN'S EIGHT WORK PATTERNS, not eight kinds of software.
 * They used to be money/customers/communication/research/…, which is how a tool catalogue is
 * organised — and it left the roster reading like a productivity app that happened to be in
 * Korean. A shop owner does not go looking for "communication"; they know they are short-staffed
 * overnight, or that they reconcile a card settlement every morning, or that reviews need
 * answering. Naming the pattern on the card is what makes a suggestion recognisable as their own
 * job rather than as a feature.
 *
 * THIRTY-TWO IS TOO MANY TO SHOW. A wall of them is a catalogue to be read rather than an example
 * to be taken, so the screens show a handful and `pickSuggestions` chooses it — one per pattern, in
 * shuffled order, so six suggestions are six different kinds of work rather than six ways of
 * writing marketing copy.
 *
 * Wherever a job touches money leaving the building or a message going out under somebody's name,
 * the instruction says so. A standing instruction is the one place a person is likely to read it.
 */

/** The eight patterns, as the plan names them. */
export type WorkPatternId =
  | "night-watch"
  | "approval"
  | "settlement"
  | "enquiries"
  | "schedule"
  | "stock"
  | "reputation"
  | "paperwork";

export type WorkPattern = {
  id: WorkPatternId;
  /** What this kind of work is called on the card. */
  name: string;
  /**
   * What this pattern usually leans on, in the four words the product owns.
   *
   * Not a promise and not a setting — a Bot reaches whatever it is given. It answers the question
   * somebody actually asks in front of these cards: "what would it be using to do that?"
   */
  connection: string;
};

export const WORK_PATTERNS: readonly WorkPattern[] = [
  { id: "night-watch", name: "Night watch", connection: "Browser" },
  { id: "approval", name: "Approval helper", connection: "Email" },
  {
    id: "settlement",
    name: "Settlement and reconciliation",
    connection: "Sheets",
  },
  { id: "enquiries", name: "Enquiry replies", connection: "Email" },
  {
    id: "schedule",
    name: "Bookings and schedule",
    connection: "Connected apps",
  },
  { id: "stock", name: "Stock and ordering", connection: "Sheets" },
  { id: "reputation", name: "Reviews and reputation", connection: "Browser" },
  {
    id: "paperwork",
    name: "Receipts and paperwork",
    connection: "Connected apps",
  },
] as const;

/** The pattern a preset belongs to. Every id in the type is in `WORK_PATTERNS`, so this is total. */
export function workPattern(id: WorkPatternId): WorkPattern {
  return WORK_PATTERNS.find((pattern) => pattern.id === id) as WorkPattern;
}

export type AgentPreset = {
  id: string;
  pattern: WorkPatternId;
  /** The face it arrives wearing. A tile id from mascot-art. */
  avatarSeed: string;
  name: string;
  title: string;
  roleDescription: string;
};

export const AGENT_PRESETS: readonly AgentPreset[] = [
  // — 당직·감시 —
  {
    id: "night-shift",
    pattern: "night-watch",
    avatarSeed: "r2c4",
    name: "Night Shift",
    title: "Overnight prep",
    roleDescription:
      "Work overnight and have a digest ready by morning: what arrived, what changed, and the two or three things worth my attention first.",
  },
  {
    id: "notice-watch",
    pattern: "night-watch",
    avatarSeed: "r0c3",
    name: "Notice Watch",
    title: "Announcements",
    roleDescription:
      "Check the places that post notices about us — the district office, the platform, the trade association — and tell me the same day when something new affects us. Say so plainly when nothing did.",
  },
  {
    id: "competitors",
    pattern: "night-watch",
    avatarSeed: "r4c2",
    name: "Competitor Watch",
    title: "Market intelligence",
    roleDescription:
      "Watch the handful of companies we compete with — prices, launches, hiring, anything they announce — and tell me what changed and why it might matter to us.",
  },
  {
    id: "news-brief",
    pattern: "night-watch",
    avatarSeed: "r1c2",
    name: "News Briefing",
    title: "Daily news",
    roleDescription:
      "Each morning, brief me on the news for our industry: five items at most, one line each, and skip the day entirely if nothing happened.",
  },

  // — 승인 보조 —
  {
    id: "inbox-triage",
    pattern: "approval",
    avatarSeed: "r1c6",
    name: "Inbox Triage",
    title: "Email",
    roleDescription:
      "Sort my email into what needs me, what can wait, and what is noise. Draft replies in my voice for the ones that need one, and never send without asking.",
  },
  {
    id: "outgoing-check",
    pattern: "approval",
    avatarSeed: "r2c1",
    name: "Outgoing Check",
    title: "Before it goes out",
    roleDescription:
      "Anything that leaves under our name — a message, a notice, a reply — comes to me first, with what you changed and why. Send nothing yourself.",
  },
  {
    id: "receivables",
    pattern: "approval",
    avatarSeed: "r0c4",
    name: "Payments Chaser",
    title: "Accounts receivable",
    roleDescription:
      "Track which invoices have been paid and which are late. Draft the reminder for the late ones in a tone that keeps the customer, and show it to me before it goes.",
  },
  {
    id: "price-check",
    pattern: "approval",
    avatarSeed: "r2c0",
    name: "Price Check",
    title: "Sourcing",
    roleDescription:
      "Find what something costs from several sellers, with delivery and lead time included, and lay them side by side. Say which you would pick and why. Never buy anything.",
  },

  // — 정산·대조 —
  {
    id: "settlement",
    pattern: "settlement",
    avatarSeed: "r3c2",
    name: "Daily Settlement",
    title: "Sales against deposits",
    roleDescription:
      "Match the day's sales against what actually reached the account and bring me only the lines that disagree. Never move money, and never write anything off.",
  },
  {
    id: "payouts",
    pattern: "settlement",
    avatarSeed: "r0c6",
    name: "Platform Payouts",
    title: "Marketplace settlements",
    roleDescription:
      "Check what each sales channel says it will pay us and when, put its fees beside it, and tell me when a payout is late or smaller than the orders say it should be.",
  },
  {
    id: "receipts",
    pattern: "settlement",
    avatarSeed: "r3c5",
    name: "Expense Manager",
    title: "Finance operations",
    roleDescription:
      "Review receipts, categorise expenses and prepare reimbursement reports. Flag anything that looks duplicated or out of policy rather than filing it.",
  },
  {
    id: "weekly-report",
    pattern: "settlement",
    avatarSeed: "r3c1",
    name: "Weekly Report",
    title: "Reporting",
    roleDescription:
      "Every Friday, write the week up: what moved, what the numbers did, and what is stuck. Short enough to read standing up, and say plainly when a week was quiet.",
  },

  // — 문의 응대 —
  {
    id: "support-replies",
    pattern: "enquiries",
    avatarSeed: "r0c5",
    name: "Front Desk",
    title: "Customer messages",
    roleDescription:
      "Read what customers send us, answer the ones with a clear answer, and bring me the rest with the history attached. Never send a reply without showing it to me first.",
  },
  {
    id: "faq-answers",
    pattern: "enquiries",
    avatarSeed: "r4c0",
    name: "FAQ Answers",
    title: "Repeat questions",
    roleDescription:
      "Collect the questions we are asked over and over, write one good answer for each, and correct them when prices or opening hours change. Show me an answer before it is used.",
  },
  {
    id: "quotes",
    pattern: "enquiries",
    avatarSeed: "r1c3",
    name: "Quote Desk",
    title: "Quotes and invoices",
    roleDescription:
      "Turn an enquiry into a quote using our usual prices and terms, and an accepted quote into an invoice. Ask me about anything priced differently from last time.",
  },
  {
    id: "customer-list",
    pattern: "enquiries",
    avatarSeed: "r4c4",
    name: "Customer List",
    title: "Records",
    roleDescription:
      "Keep the customer list tidy — merge duplicates, fill in what is missing, and note who we last spoke to and about what. Ask before deleting anybody.",
  },

  // — 예약·일정 —
  {
    id: "bookings",
    pattern: "schedule",
    avatarSeed: "r1c4",
    name: "Booking Desk",
    title: "Appointments",
    roleDescription:
      "Keep the day's bookings straight: confirm the new ones, remind people the day before, and warn me about gaps and double-bookings while they can still be fixed.",
  },
  {
    id: "shift-roster",
    pattern: "schedule",
    avatarSeed: "r1c1",
    name: "Shift Roster",
    title: "Who works when",
    roleDescription:
      "Keep next week's roster straight: who is in, who has asked for time off, and where a shift is uncovered. Tell me about a gap while there is still time to fill it.",
  },
  {
    id: "meeting-prep",
    pattern: "schedule",
    avatarSeed: "r0c2",
    name: "Meeting Prep",
    title: "Calendar",
    roleDescription:
      "Before each meeting, gather what I need: who is coming, what we said last time, and any document that has changed since. One page, no longer.",
  },
  {
    id: "todos",
    pattern: "schedule",
    avatarSeed: "r2c3",
    name: "To-do Wrangler",
    title: "Personal admin",
    roleDescription:
      "Keep my list honest: what is actually due, what I have been avoiding, and what can be dropped. Ask me each morning for the three things that matter today.",
  },

  // — 재고·발주 —
  {
    id: "stock",
    pattern: "stock",
    avatarSeed: "r0c0",
    name: "Stock Check",
    title: "Inventory",
    roleDescription:
      "Watch what we are running out of and tell me before it runs out, not after. Work from how fast it has actually been selling, not from a fixed number.",
  },
  {
    id: "reorder",
    pattern: "stock",
    avatarSeed: "r3c4",
    name: "Reorder Sheet",
    title: "Purchase orders",
    roleDescription:
      "Turn what we are short of into one order per supplier, at the prices we last paid, and show me the whole sheet before anything is sent.",
  },
  {
    id: "suppliers",
    pattern: "stock",
    avatarSeed: "r3c3",
    name: "Supplier Chase",
    title: "Purchasing",
    roleDescription:
      "Keep track of what we have ordered and when it was promised, and chase anything late. Draft the message; let me send it.",
  },
  {
    id: "supplier-prices",
    pattern: "stock",
    avatarSeed: "r2c2",
    name: "Supplier Prices",
    title: "Buying prices",
    roleDescription:
      "Watch what our suppliers charge for the things we buy most often, and tell me when one of them changes a price or when the same thing is cheaper elsewhere.",
  },

  // — 리뷰·평판 —
  {
    id: "reviews",
    pattern: "reputation",
    avatarSeed: "r2c6",
    name: "Review Watch",
    title: "Reputation",
    roleDescription:
      "Check our reviews and mentions daily. Tell me about anything unhappy the same day, with a draft reply, and summarise the rest at the end of the week.",
  },
  {
    id: "review-replies",
    pattern: "reputation",
    avatarSeed: "r4c1",
    name: "Review Replies",
    title: "Answering reviews",
    roleDescription:
      "Draft a reply to each new review in our voice — thank the kind ones briefly, and answer an unhappy one with what we will actually do about it. Post nothing until I have read it.",
  },
  {
    id: "mentions",
    pattern: "reputation",
    avatarSeed: "r1c5",
    name: "Mention Watch",
    title: "What people say",
    roleDescription:
      "Look for where our name comes up — communities, blogs, social — and tell me what was said and where. Bring me anything unhappy the same day.",
  },
  {
    id: "social",
    pattern: "reputation",
    avatarSeed: "r4c5",
    name: "Social Posts",
    title: "Marketing",
    roleDescription:
      "Draft our posts for the week from what is actually happening here, in our voice rather than an advertisement's. Nothing goes out until I have seen it.",
  },

  // — 증빙·서류 —
  {
    id: "tax-prep",
    pattern: "paperwork",
    avatarSeed: "r3c0",
    name: "Tax Season",
    title: "Tax and filings",
    roleDescription:
      "Keep the paperwork a filing needs in one place as it arrives, and tell me each month what is still missing. Never file anything yourself.",
  },
  {
    id: "contracts",
    pattern: "paperwork",
    avatarSeed: "r4c3",
    name: "Contract Review",
    title: "Legal admin",
    roleDescription:
      "Read a contract and tell me in plain language what it commits us to, what is unusual, and what the dates are. You are not a lawyer — say so when something needs one.",
  },
  {
    id: "doc-digest",
    pattern: "paperwork",
    avatarSeed: "r2c5",
    name: "Document Digest",
    title: "Reading",
    roleDescription:
      "Read the long documents I do not have time for and give me the argument, the numbers that matter, and anything that contradicts what we already believed.",
  },
  {
    id: "files",
    pattern: "paperwork",
    avatarSeed: "r1c0",
    name: "File Keeper",
    title: "Filing",
    roleDescription:
      "Keep our files in an order I can find things in: sensible names, the right folders, duplicates pointed out. Move things freely, but never delete without asking.",
  },
] as const;

/**
 * A handful of suggestions, one kind of work at a time.
 *
 * Picking at random from all thirty-two gives runs of the same pattern often enough to notice — six
 * suggestions that are all marketing read as a marketing product. So: shuffle the patterns, take one
 * preset from each in turn, and come back round for a second if more are wanted than there are
 * patterns.
 *
 * `random` is a parameter so a test can be deterministic; callers pass nothing and get `Math.random`.
 * Callers must hold the result in state — calling this during render returns a different six every
 * time anything on the screen changes.
 */
export function pickSuggestions(
  count: number,
  random: () => number = Math.random,
): AgentPreset[] {
  const byPattern = new Map<WorkPatternId, AgentPreset[]>();
  for (const preset of AGENT_PRESETS) {
    const bucket = byPattern.get(preset.pattern);
    if (bucket) bucket.push(preset);
    else byPattern.set(preset.pattern, [preset]);
  }
  // Shuffled within the pattern too, or the second time round always offers the same runner-up.
  const buckets = shuffle([...byPattern.values()], random).map((bucket) =>
    shuffle(bucket, random),
  );

  const picked: AgentPreset[] = [];
  // `round` walks down each bucket; buckets that run out are simply skipped.
  for (let round = 0; picked.length < count; round += 1) {
    const before = picked.length;
    for (const bucket of buckets) {
      if (picked.length >= count) break;
      const preset = bucket[round];
      if (preset) picked.push(preset);
    }
    // Every bucket exhausted: asking for more than there are presets is not a reason to spin.
    if (picked.length === before) break;
  }
  return picked;
}

/** Fisher–Yates, on a copy. The naive `sort(() => random() - 0.5)` is not uniform. */
function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    // Clamped: `Math.random()` never returns 1, but the injected sources a test writes can, and
    // one index past the end swaps an `undefined` into the array that the casts below would hide.
    const swap = Math.min(index, Math.floor(random() * (index + 1)));
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return copy;
}
