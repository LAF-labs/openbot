import { describe, expect, test } from "bun:test";
import type { FeedPage, FeedPost } from "../../shared/feed";
import type { GoalView } from "../../shared/goals";
import {
  cardToDraw,
  DRAWABLE_ANYWHERE,
} from "../src/components/gallery/gallery-card";
import type { GoalsAnswer } from "../src/lib/goals/queries";
import { cardWhen, feedCard, goalsCard, madeCard } from "../src/lib/home/cards";
import type { MadeItem, MadePage } from "../src/lib/made/queries";

/*
 * 홈'S FIRST CARDS — WHAT EACH SAYS, AND THAT IT SAYS NOTHING WHEN THERE IS NOTHING (2026-10-10,
 * `docs/laf/redesign-2026-10.md` §1 and §2, piece 3-4).
 *
 * 소식, 목표 and 만든 것 stand under 오늘 in the panel at the left of the window, each as the one
 * fact its page would have opened on. What that fact is — and above all that a card with nothing
 * to say is not drawn, and that an answer of the wrong shape is "nothing to say" and never a throw
 * into the panel 오늘 is in — is decided here, away from any screen.
 */

const post = (over: Partial<FeedPost> = {}): FeedPost => ({
  id: "p-1",
  agentId: "bot-1",
  routineId: null,
  topic: "weather",
  title: "이번 주 날씨: 주말에 비",
  body: "…",
  sources: [],
  createdAt: "2026-10-10T06:30:00.000Z",
  seen: false,
  liked: false,
  ...over,
});

const feed = (posts: FeedPost[]): FeedPage => ({
  posts,
  next: null,
  unseen: 0,
  routines: [],
});

const goal = (over: Partial<GoalView> = {}): GoalView => ({
  id: "g-1",
  agentId: "bot-1",
  category: "study",
  title: "토익 800점 달성",
  target: "12월 말까지 800점",
  measure: { unit: "점", start: 720, goal: 800 },
  dueOn: "2026-12-31",
  status: "active",
  momentum: null,
  createdAt: "2026-10-10T06:41:00.000Z",
  updatedAt: "2026-10-10T06:41:00.000Z",
  lastEntryAt: null,
  entryCount: 0,
  latestValue: null,
  routines: [],
  ...over,
});

const goals = (list: GoalView[]): GoalsAnswer => ({
  goals: list,
  active: list.filter((one) => one.status === "active").length,
});

const made = (items: MadeItem[]): MadePage => ({ items, next: null });

const item = (over: Partial<MadeItem> = {}): MadeItem => ({
  tool: "showChecklist",
  shelf: "checklist",
  title: "이사 준비",
  at: "2026-10-10T06:51:00.000Z",
  channelId: "c-1",
  messageId: "m-1",
  ...over,
});

/** An answer of some other shape, handed where a typed one is expected: what a broken server sends. */
const wrong = <T>(value: unknown) => value as T;

describe("소식's card", () => {
  test("says the newest post's title, and when it was written while none are unseen", () => {
    expect(
      feedCard(feed([post(), post({ id: "p-2", title: "지원 사업 공고" })]), 0),
    ).toEqual({
      at: "2026-10-10T06:30:00.000Z",
      card: null,
      count: null,
      line: "이번 주 날씨: 주말에 비",
      note: null,
      // A post has no place of its own: the card is the way to 소식 and nothing else.
      thing: null,
    });
  });

  test("says how many are unseen in place of the time, while any are", () => {
    expect(feedCard(feed([post()]), 3)).toEqual({
      at: null,
      card: null,
      count: 3,
      line: "이번 주 날씨: 주말에 비",
      note: null,
      thing: null,
    });
  });

  test("is not drawn before there is a post — whatever the count says", () => {
    expect(feedCard(feed([]), 0)).toBeNull();
    expect(feedCard(feed([]), 4)).toBeNull();
    expect(feedCard(undefined, undefined)).toBeNull();
    // A post with no title has nothing to put on the line.
    expect(feedCard(feed([post({ title: "   " })]), 1)).toBeNull();
  });

  test.each([
    ["no number at all", undefined],
    ["zero", 0],
    ["a negative", -2],
    ["not a number", Number.NaN],
    ["a string", wrong<number>("3")],
  ])("a count that is %s is no count: the time stands there", (_, unseen) => {
    expect(feedCard(feed([post()]), unseen)?.count).toBeNull();
    expect(feedCard(feed([post()]), unseen)?.at).toBe(
      "2026-10-10T06:30:00.000Z",
    );
  });
});

describe("목표's card", () => {
  test("says the first goal in progress, how many there are, and its number where it has one", () => {
    const card = goalsCard(
      goals([
        goal({ id: "g-0", status: "done", title: "끝낸 목표" }),
        goal(),
        goal({ id: "g-2", title: "매일 30분 걷기", measure: null }),
      ]),
    );
    expect(card).toEqual({
      at: null,
      card: null,
      count: 2,
      line: "토익 800점 달성",
      note: "Now 720 · goal 800점",
      // The line names one goal, and opens that one — not the done goal listed before it.
      thing: { id: "g-1", kind: "goal" },
    });
  });

  test("a goal the answer gave no id is still named, and the card is then the way to its page only", () => {
    const card = goalsCard(
      wrong<GoalsAnswer>({
        goals: [{ status: "active", title: "책 12권 읽기", id: 12 }],
      }),
    );
    expect(card?.line).toBe("책 12권 읽기");
    expect(card?.thing).toBeNull();
  });

  test("a goal with nothing to count has no second line", () => {
    expect(goalsCard(goals([goal({ measure: null })]))?.note).toBeNull();
  });

  test("the last value logged is the number it says", () => {
    expect(goalsCard(goals([goal({ latestValue: 765 })]))?.note).toBe(
      "Now 765 · goal 800점",
    );
  });

  test("is not drawn while nothing is in progress: a goal that is done or dropped is on its page", () => {
    expect(goalsCard(goals([]))).toBeNull();
    expect(
      goalsCard(
        goals([
          goal({ status: "done" }),
          goal({ id: "g-2", status: "dropped" }),
        ]),
      ),
    ).toBeNull();
    expect(goalsCard(undefined)).toBeNull();
  });
});

describe("만든 것's card", () => {
  test("says the newest thing's title, and when it was made", () => {
    expect(
      madeCard(made([item(), item({ title: "예전 것", messageId: "m-0" })])),
    ).toEqual({
      at: "2026-10-10T06:51:00.000Z",
      card: null,
      count: null,
      line: "이사 준비",
      note: null,
      // Where it was handed over: the conversation, at that message — the newest thing's, not
      // the one before it.
      thing: { channelId: "c-1", kind: "made", messageId: "m-1" },
    });
  });

  test.each([
    ["no message", { messageId: "" }],
    ["no conversation", { channelId: "  " }],
    ["a message that is not a name", { messageId: wrong<string>(7) }],
  ])(
    "a thing with %s has nowhere of its own to open: both, or the page",
    (_, over) => {
      const card = madeCard(made([item(over)]));
      expect(card?.line).toBe("이사 준비");
      expect(card?.thing).toBeNull();
    },
  );

  test("a thing the Bot gave no title is called by its kind, as its page calls it", () => {
    expect(madeCard(made([item({ title: null })]))?.line).toBe("Checklist");
    expect(madeCard(made([item({ title: "  " })]))?.line).toBe("Checklist");
  });

  test("is not drawn before anything is made, or for a thing with neither a title nor a kind this build knows", () => {
    expect(madeCard(made([]))).toBeNull();
    expect(madeCard(undefined)).toBeNull();
    expect(
      madeCard(made([item({ title: null, tool: "showSomethingNew" })])),
    ).toBeNull();
    // A table of names is read by the key it is asked for: `constructor` is not a kind.
    expect(
      madeCard(made([item({ title: null, tool: "constructor" })])),
    ).toBeNull();
  });
});

describe("the made thing itself, for 홈 to draw", () => {
  test("a card the server sent the arguments of is handed on by its name, with them", () => {
    const args = {
      title: "이사 준비",
      items: [{ text: "박스 사기", done: true }],
    };
    expect(madeCard(made([item({ args })]))?.card).toEqual({
      args,
      name: "showChecklist",
    });
  });

  test.each([
    ["none were sent", undefined],
    ["they are a list", wrong<Record<string, unknown>>([1])],
    ["they are a word", wrong<Record<string, unknown>>("x")],
  ])("there is no card to draw where %s: the line stands", (_, args) => {
    const card = madeCard(made([item(args === undefined ? {} : { args })]));
    expect(card?.card).toBeNull();
    expect(card?.line).toBe("이사 준비");
  });
});

describe("a gallery card drawn where there is no conversation", () => {
  test("what only shows can be drawn anywhere; what asks, reads the deployment's data or acts cannot", () => {
    expect(DRAWABLE_ANYWHERE).toEqual([
      "showAreaChart",
      "showBarChart",
      "showChecklist",
      "showLineChart",
      "showMetrics",
      "showNotice",
      "showPieChart",
      "showProgress",
      "showQuote",
      "showRecord",
    ]);
    for (const name of [
      "askApproval",
      "askChoice",
      "showActivityReport",
      "showFile",
      "constructor",
      "__proto__",
    ]) {
      expect({ name, drawn: cardToDraw(name, {}) }).toEqual({
        name,
        drawn: null,
      });
    }
    expect(cardToDraw(7, {})).toBeNull();
  });

  test("what it was called with is checked against the card's own schema before anything is drawn", () => {
    const good = cardToDraw("showChecklist", {
      title: "이사 준비",
      items: [{ text: "박스 사기", done: true }],
    });
    expect(good?.props.title).toBe("이사 준비");
    for (const args of [
      null,
      "x",
      [],
      { title: "이사 준비", items: "많음" },
      { title: "이사 준비", items: [{ text: 5, done: true }] },
    ]) {
      expect({ args, drawn: cardToDraw("showChecklist", args) }).toEqual({
        args,
        drawn: null,
      });
    }
  });
});

describe("an answer of the wrong shape", () => {
  /*
   * The cards are in the panel's own seam, with 오늘. A throw here would blank what is waiting on
   * the person because a list of made things came back malformed.
   */
  test.each([
    ["null", null],
    ["a string", "posts"],
    ["a number", 7],
    ["an empty object", {}],
    ["a list where a record belongs", []],
    ["its list as a record", { posts: {}, goals: {}, items: {} }],
    ["its list as a string", { posts: "x", goals: "x", items: "x" }],
    [
      "a list of things that are not records",
      { posts: [1], goals: [null], items: ["x"] },
    ],
    [
      "records whose fields are other things",
      {
        posts: [{ title: 5, createdAt: {} }],
        goals: [{ status: "active", title: ["x"], measure: "many" }],
        items: [{ title: {}, tool: 9, at: [] }],
      },
    ],
  ])("%s is nothing to say, and nothing is thrown", (_, answer) => {
    expect(feedCard(wrong<FeedPage>(answer), 2)).toBeNull();
    expect(goalsCard(wrong<GoalsAnswer>(answer))).toBeNull();
    expect(madeCard(wrong<MadePage>(answer))).toBeNull();
  });

  test("a goal whose number is not a number still has its title", () => {
    const card = goalsCard(
      wrong<GoalsAnswer>({
        goals: [{ status: "active", title: "책 12권 읽기", measure: "many" }],
      }),
    );
    expect(card?.line).toBe("책 12권 읽기");
    expect(card?.note).toBeNull();
  });
});

describe("when, at a card's right end", () => {
  const now = new Date(2026, 9, 10, 15, 0, 0);

  test("the minute if it was today, the date if it was not", () => {
    const today = cardWhen(new Date(2026, 9, 10, 6, 30).toISOString(), now);
    const earlier = cardWhen(new Date(2026, 9, 6, 17, 5).toISOString(), now);
    // The same instant, as this runtime's own clock writes a time and a date.
    expect(today).toBe(
      new Date(2026, 9, 10, 6, 30).toLocaleTimeString("en", {
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    expect(earlier).toBe(
      new Date(2026, 9, 6, 17, 5).toLocaleDateString("en", {
        month: "short",
        day: "numeric",
      }),
    );
    expect(today).not.toBe(earlier);
  });

  test("the same hour on another day is a date, not that hour", () => {
    expect(cardWhen(new Date(2026, 9, 9, 15, 0).toISOString(), now)).toBe(
      new Date(2026, 9, 9).toLocaleDateString("en", {
        month: "short",
        day: "numeric",
      }),
    );
    expect(cardWhen(new Date(2025, 9, 10, 15, 0).toISOString(), now)).toBe(
      new Date(2025, 9, 10).toLocaleDateString("en", {
        month: "short",
        day: "numeric",
      }),
    );
  });

  test("nothing for a time that is not one", () => {
    expect(cardWhen(null, now)).toBe("");
    expect(cardWhen("", now)).toBe("");
    expect(cardWhen("soon", now)).toBe("");
  });
});
