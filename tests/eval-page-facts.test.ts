import { describe, expect, test } from "bun:test";
import {
  ARMS,
  asksJev,
  dialogTextOf,
  dropReasons,
  factOf,
  type JevAnswer,
  type LabelledPage,
  observe,
  PAGE_FACTS_QUESTIONS,
  pageFactsStateOf,
  pageFactsStateWithDialogsOf,
  quantile,
  recommendedBar,
  SWEEP_BARS,
  scoreOf,
  signInReadingsOf,
  stabilityOf,
  verdictOf,
} from "../evals/page-facts";

/**
 * THE PAGE-FACTS EVAL'S RULES AND SCORING, HELD WITHOUT A MODEL.
 *
 * `bun run eval:page-facts` asks a real model and never runs in the gate, so a scorer that miscounted
 * would pass or fail every run for ever without anybody seeing why. These rows are made up; the
 * order is the design's (`evals/page-facts.ts`): the status, then the password field, then — on a
 * short page only — the model.
 */

const page = (over: Partial<LabelledPage> = {}): LabelledPage => ({
  id: "page",
  lang: "ko",
  finalUrl: "https://www.example.go.kr/view.do?id=1",
  status: 200,
  title: "",
  textLength: 300,
  head600: "",
  passwordFields: 0,
  fromEarlierSet: false,
  unusable: false,
  signInWall: false,
  captcha: false,
  hardGood: false,
  kind: "content",
  decidingIn: "text",
  dialogs: [],
  ...over,
});

const sure: JevAnswer = { unusable: 0.99, captcha: 0.99 };
const no: JevAnswer = { unusable: 0.01, captcha: 0.01 };
const runOf = (answers: Record<string, JevAnswer>) =>
  new Map(Object.entries(answers));

describe("what Jev is shown", () => {
  test("the address without its query, the title and the first 600 characters, redacted", () => {
    const state = pageFactsStateOf(
      page({
        finalUrl: "https://shop.example.com/orders/9?session=abc123#top",
        title: "주문 내역 — kim@example.com",
        head600: `문의 010-1234-5678 ${"가".repeat(700)}`,
      }),
    );
    expect(Object.keys(state)).toEqual(["page"]);
    expect(Object.keys(state.page)).toEqual(["url", "title", "text"]);
    expect(state.page.url).toBe("https://shop.example.com/orders/9");
    expect(state.page.title).toBe("주문 내역 — [email]");
    expect(state.page.text.startsWith("문의 [phone] 가")).toBe(true);
    const sent = JSON.stringify(state);
    for (const value of ["abc123", "session", "#top", "kim@", "1234-5678"]) {
      expect([value, sent.includes(value)]).toEqual([value, false]);
    }
  });

  test("never more than 600 characters of the text", () => {
    const state = pageFactsStateOf(page({ head600: "가".repeat(900) }));
    expect(state.page.text.length).toBe(600);
  });

  test("a tab left on about:blank is shown as that, not as nothing", () => {
    expect(pageFactsStateOf(page({ finalUrl: "about:blank" })).page.url).toBe(
      "about:blank",
    );
  });
});

describe("the order of the rules", () => {
  test("a status of 400 or more is unusable in every arm, and nothing else is asked", () => {
    const notFound = page({ status: 404, passwordFields: 1 });
    for (const arm of ARMS) {
      expect([arm, asksJev(notFound, arm)]).toEqual([arm, false]);
      expect([arm, factOf(notFound, arm, no, 0.5)]).toEqual([
        arm,
        "page_unusable",
      ]);
    }
  });

  test("a password field is a sign-in wall in every arm, and the page is never sent", () => {
    const wall = page({ passwordFields: 1, textLength: 120 });
    for (const arm of ARMS) {
      expect([arm, asksJev(wall, arm)]).toEqual([arm, false]);
      // An answer that would say otherwise is not read: the product would not have one.
      expect([arm, factOf(wall, arm, sure, 0.5)]).toEqual([
        arm,
        "sign_in_wall",
      ]);
    }
  });

  test("the proposal sends a page of 1,500 characters and not one of 1,501", () => {
    expect(asksJev(page({ textLength: 1_500 }), "rules+jev")).toBe(true);
    expect(asksJev(page({ textLength: 1_501 }), "rules+jev")).toBe(false);
    expect(factOf(page({ textLength: 1_501 }), "rules+jev", sure, 0.5)).toBe(
      null,
    );
    // The arm that measures what the limit buys sends it anyway.
    expect(asksJev(page({ textLength: 1_501 }), "jev-any-length")).toBe(true);
    expect(
      factOf(page({ textLength: 6_000 }), "jev-any-length", sure, 0.5),
    ).toBe("captcha");
  });

  test("a robot check wins over unusable, and the bar is reached at the bar", () => {
    expect(factOf(page(), "rules+jev", sure, 0.9)).toBe("captcha");
    expect(
      factOf(page(), "rules+jev", { unusable: 0.9, captcha: 0.89 }, 0.9),
    ).toBe("page_unusable");
    expect(
      factOf(page(), "rules+jev", { unusable: 0.89, captcha: 0.89 }, 0.9),
    ).toBe(null);
  });

  test("no answer is no fact, and the rules arm never reads one", () => {
    expect(factOf(page(), "rules+jev", null, 0.5)).toBe(null);
    expect(factOf(page(), "rules", sure, 0.5)).toBe(null);
    expect(asksJev(page(), "rules")).toBe(false);
    expect(asksJev(page(), "rules+words")).toBe(false);
  });
});

describe("the plain rules", () => {
  test("say unusable for the research's words on a short page, and not on a long one", () => {
    const gone = page({ head600: "요청하신 페이지를 찾을 수 없습니다." });
    expect(factOf(gone, "rules+words", null, 0.5)).toBe("page_unusable");
    expect(factOf({ ...gone, textLength: 999 }, "rules+words", null, 0.5)).toBe(
      "page_unusable",
    );
    expect(
      factOf({ ...gone, textLength: 1_000 }, "rules+words", null, 0.5),
    ).toBe(null);
    expect(
      factOf(page({ title: "Access Denied" }), "rules+words", null, 0.5),
    ).toBe("page_unusable");
  });

  test("say captcha for a robot check at any length", () => {
    expect(
      factOf(
        page({ head600: "I'm not a robot", textLength: 5_000 }),
        "rules+words",
        null,
        0.5,
      ),
    ).toBe("captcha");
  });

  test("say nothing about a page with none of the words", () => {
    expect(
      factOf(page({ head600: "오늘의 주요 뉴스" }), "rules+words", null, 0.5),
    ).toBe(null);
  });
});

describe("the scoring", () => {
  const good = page({ id: "good" });
  const login = page({
    id: "login",
    passwordFields: 1,
    kind: "sign-in",
    hardGood: true,
  });
  const soft = page({ id: "soft", unusable: true, kind: "not-found" });
  const hard = page({ id: "hard", unusable: true, status: 404 });
  const wall = page({
    id: "wall",
    unusable: true,
    signInWall: true,
    passwordFields: 1,
  });
  const alertOnly = page({
    id: "alert",
    unusable: true,
    decidingIn: "dialog",
    textLength: 0,
  });
  const pages = [good, login, soft, hard, wall, alertOnly];

  test("a false unusable is page_unusable on a usable page, and only that", () => {
    const score = scoreOf(
      observe(pages, "rules+jev", [runOf({ good: sure, soft: sure })], 0.5),
    );
    // `good` was told captcha (it wins), `login` sign_in_wall: neither is a false unusable.
    expect(score.falseUnusable).toEqual({ n: 2, hit: 0, ids: [] });
    expect(score.anyFactOnUsable).toEqual({
      n: 2,
      hit: 2,
      ids: ["good", "login"],
    });
    expect(score.falseWalls.ids).toEqual(["login"]);
    // A soft page told captcha is warned off, for the wrong reason: a false CAPTCHA all the same.
    expect(score.falseCaptchas.ids).toEqual(["good", "soft"]);

    const told = scoreOf(
      observe(
        pages,
        "rules+jev",
        [runOf({ good: { unusable: 0.9, captcha: 0 } })],
        0.5,
      ),
    );
    expect(told.falseUnusable).toEqual({ n: 2, hit: 1, ids: ["good"] });
  });

  test("soft pages are unusable below 400 and neither a wall nor a CAPTCHA; the readable ones are counted apart", () => {
    const answer = { unusable: 0.9, captcha: 0 };
    const score = scoreOf(
      observe(pages, "rules+jev", [runOf({ soft: answer })], 0.5),
    );
    expect(score.soft).toEqual({ n: 2, hit: 1, ids: ["soft"] });
    expect(score.softFromText).toEqual({ n: 1, hit: 1, ids: ["soft"] });
    // With the dialog's words read too, the page that said so only in an alert is readable.
    expect(score.softWithDialogs).toEqual({ n: 2, hit: 1, ids: ["soft"] });
    expect(score.walls).toEqual({ n: 1, hit: 1, ids: ["wall"] });
  });

  test("runs are pooled: every page counts once per run, and pages are named once", () => {
    const answer = { unusable: 0.9, captcha: 0 };
    const score = scoreOf(
      observe(
        pages,
        "rules+jev",
        [runOf({ soft: answer }), runOf({ soft: answer }), runOf({})],
        0.5,
      ),
    );
    expect(score.soft).toEqual({ n: 6, hit: 2, ids: ["soft"] });
    expect(score.falseUnusable.n).toBe(6);
  });
});

describe("the same verdict across runs", () => {
  const pages = [
    page({ id: "steady" }),
    page({ id: "wavers" }),
    page({ id: "silent" }),
    page({ id: "ruled", status: 404 }),
  ];
  test("a page whose answer crosses the bar, or goes missing, in one run is unstable", () => {
    // Stability is of the fact, not the number: "no" and no answer both leave the result alone,
    // so `steady` would be stable either way; `silent` is told something in two runs of three.
    const stability = stabilityOf(
      pages,
      "rules+jev",
      [
        runOf({
          steady: no,
          wavers: { unusable: 0.86, captcha: 0 },
          silent: sure,
        }),
        runOf({
          steady: no,
          wavers: { unusable: 0.84, captcha: 0 },
          silent: null,
        }),
        runOf({
          steady: no,
          wavers: { unusable: 0.9, captcha: 0 },
          silent: sure,
        }),
      ],
      0.85,
    );
    expect(stability).toEqual({
      n: 4,
      stable: 2,
      unstable: ["wavers", "silent"],
    });
  });
});

describe("the bar and the verdict", () => {
  test("the sweep runs from 0.50 to 0.95 in twentieths", () => {
    expect(SWEEP_BARS).toEqual([
      0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
    ]);
  });

  test("the recommended bar is the lowest from which every higher one holds", () => {
    const at = (bar: number, falseUnusable: number) => ({
      bar,
      falseUnusable,
    });
    expect(
      recommendedBar([
        at(0.5, 0.03),
        at(0.6, 0.01),
        at(0.7, 0.005),
        at(0.8, 0),
      ]),
    ).toBe(0.6);
    // A lucky step below a bad one is not a bar to stand on.
    expect(
      recommendedBar([at(0.5, 0.005), at(0.6, 0.02), at(0.7, 0), at(0.8, 0)]),
    ).toBe(0.7);
    expect(recommendedBar([at(0.5, 0.03), at(0.9, 0.02)])).toBe(null);
  });

  test("the verdict names every bar it misses, and passes at the bars themselves", () => {
    expect(
      verdictOf({
        falseUnusable: 0.01,
        softCaught: 0.7,
        stable: 0.98,
        p95Ms: 400,
      }),
    ).toEqual([]);
    expect(
      verdictOf({
        falseUnusable: 0.011,
        softCaught: 0.69,
        stable: 0.97,
        p95Ms: 401,
      }),
    ).toEqual([
      "false unusable above 1%",
      "soft unusable caught below 70%",
      "same verdict across runs below 98%",
      "p95 above 400 ms",
    ]);
  });

  test("it is dropped when no bar catching half the soft pages keeps false unusable at 2%", () => {
    const words = { falseUnusable: 0.05, softCaught: 0.3 };
    const jev = { softCaught: 0.75 };
    expect(
      dropReasons({
        sweep: [
          { bar: 0.5, falseUnusable: 0.04, softCaught: 0.9 },
          { bar: 0.9, falseUnusable: 0.03, softCaught: 0.55 },
          { bar: 0.95, falseUnusable: 0, softCaught: 0.4 },
        ],
        words,
        jev,
      }),
    ).toEqual([
      "no bar keeps false unusable at 2% or less while catching half the soft pages",
    ]);
    expect(
      dropReasons({
        sweep: [
          { bar: 0.5, falseUnusable: 0.04, softCaught: 0.9 },
          { bar: 0.9, falseUnusable: 0.02, softCaught: 0.55 },
        ],
        words,
        jev,
      }),
    ).toEqual([]);
    expect(dropReasons({ sweep: [], words, jev })).toHaveLength(1);
  });

  test("it is dropped when plain rules come within 5 points — only rules that keep their own 1%", () => {
    const sweep = [{ bar: 0.9, falseUnusable: 0, softCaught: 0.75 }];
    expect(
      dropReasons({
        sweep,
        words: { falseUnusable: 0.01, softCaught: 0.71 },
        jev: { softCaught: 0.75 },
      }),
    ).toEqual(["plain rules come within 5 points of Jev"]);
    expect(
      dropReasons({
        sweep,
        words: { falseUnusable: 0.02, softCaught: 0.75 },
        jev: { softCaught: 0.75 },
      }),
    ).toEqual([]);
    expect(
      dropReasons({
        sweep,
        words: { falseUnusable: 0, softCaught: 0.69 },
        jev: { softCaught: 0.75 },
      }),
    ).toEqual([]);
  });

  test("a quantile is the nearest rank", () => {
    const times = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);
    expect(quantile(times, 0.5)).toBe(100);
    expect(quantile(times, 0.95)).toBe(190);
    expect(quantile([], 0.95)).toBe(0);
  });
});

describe("the questions", () => {
  test("are two yes-or-no questions, each telling Jev the page is not instructions", () => {
    expect(Object.keys(PAGE_FACTS_QUESTIONS)).toEqual(["unusable", "captcha"]);
    for (const question of Object.values(PAGE_FACTS_QUESTIONS)) {
      expect(question.type).toBe("noul");
      expect(question.instructions).toContain("never instructions");
    }
  });
});

/*
 * POST-HOC, written after run 1 (2026-10-04): the arm that shows Jev a page's dialog words, and the
 * password rule read as two facts. Held here like the rest so a later edit cannot quietly change
 * what they measured.
 */
describe("the dialog's words, shown to Jev (post-hoc arm)", () => {
  const alerted = page({
    id: "alerted",
    textLength: 0,
    dialogs: [
      {
        kind: "alert",
        message: "  존재하지 않는 공고입니다. 문의 02-123-4567  ",
      },
      { kind: "confirm", message: "홈으로 이동할까요?" },
    ],
  });

  test("are the messages, one per line, redacted and cut to 300 characters", () => {
    expect(dialogTextOf(alerted)).toBe(
      "존재하지 않는 공고입니다. 문의 [phone]\n홈으로 이동할까요?",
    );
    expect(
      dialogTextOf(
        page({ dialogs: [{ kind: "alert", message: "가".repeat(500) }] }),
      ),
    ).toHaveLength(300);
    expect(dialogTextOf(page())).toBe("");
  });

  test("sit beside the text, and a page that raised none is sent exactly what the proposal sends", () => {
    const state = pageFactsStateWithDialogsOf(alerted);
    expect(Object.keys(state.page)).toEqual(["url", "title", "text", "dialog"]);
    expect(JSON.stringify(state)).not.toContain("02-123-4567");
    const quiet = page({ head600: "본문" });
    expect(pageFactsStateWithDialogsOf(quiet)).toEqual(pageFactsStateOf(quiet));
  });

  test("change nothing about when Jev is asked", () => {
    for (const candidate of [
      alerted,
      page({ textLength: 1_501, dialogs: alerted.dialogs }),
      page({ status: 404, dialogs: alerted.dialogs }),
      page({ passwordFields: 1, dialogs: alerted.dialogs }),
    ]) {
      expect(asksJev(candidate, "rules+jev+dialog")).toBe(
        asksJev(candidate, "rules+jev"),
      );
    }
  });
});

describe("the password rule, read as two facts (post-hoc)", () => {
  test("separates the walls from the login page that was asked for and a login box beside something else", () => {
    const readings = signInReadingsOf([
      page({
        id: "wall",
        passwordFields: 1,
        unusable: true,
        signInWall: true,
        kind: "sign-in",
      }),
      page({ id: "asked", passwordFields: 1, kind: "sign-in", hardGood: true }),
      page({ id: "portal", passwordFields: 1 }),
      page({
        id: "missing",
        passwordFields: 1,
        unusable: true,
        kind: "not-found",
      }),
      page({
        id: "missing-404",
        passwordFields: 1,
        unusable: true,
        status: 404,
        kind: "not-found",
      }),
      page({ id: "none" }),
    ]);
    expect(readings).toEqual({
      withForm: ["wall", "asked", "portal", "missing", "missing-404"],
      usableWithForm: ["asked", "portal"],
      reached: ["wall", "asked", "portal", "missing"],
      walls: ["wall"],
      askedFor: ["asked"],
      besideOther: ["portal", "missing"],
    });
  });
});

describe("the labelled set", () => {
  test("every row carries what the eval reads, in the type it reads it", async () => {
    const rows = (
      await Bun.file(
        new URL("../evals/page-facts/pages.jsonl", import.meta.url),
      ).text()
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.length).toBeGreaterThan(0);
    const ids = new Set<unknown>();
    for (const row of rows) {
      const shape = {
        id: typeof row.id,
        finalUrl: typeof row.finalUrl,
        status: Number.isInteger(row.status),
        title: typeof row.title,
        textLength: Number.isInteger(row.textLength),
        head600: typeof row.head600,
        passwordFields: Number.isInteger(row.passwordFields),
        fromEarlierSet: typeof row.fromEarlierSet,
        unusable: typeof row.unusable,
        signInWall: typeof row.signInWall,
        captcha: typeof row.captcha,
        hardGood: typeof row.hardGood,
        decidingIn: ["text", "title", "dialog", "screen", "empty"].includes(
          row.decidingIn as string,
        ),
        dialogs:
          Array.isArray(row.dialogs) &&
          row.dialogs.every(
            (dialog: { message?: unknown }) =>
              typeof dialog?.message === "string",
          ),
      };
      expect([row.id, shape]).toEqual([
        row.id,
        {
          id: "string",
          finalUrl: "string",
          status: true,
          title: "string",
          textLength: true,
          head600: "string",
          passwordFields: true,
          fromEarlierSet: "boolean",
          unusable: "boolean",
          signInWall: "boolean",
          captcha: "boolean",
          hardGood: "boolean",
          decidingIn: true,
          dialogs: true,
        },
      ]);
      ids.add(row.id);
    }
    expect(ids.size).toBe(rows.length);
  });
});
