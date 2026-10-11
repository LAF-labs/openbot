import { describe, expect, test } from "bun:test";
import { answerText, TURNS } from "../evals/days-talk";
import {
  busyTurn,
  FACT_KINDS,
  FACTS,
  type Fact,
  MUST_NOTS,
  meanOf,
  outOf,
  PHRASINGS,
  recallOf,
  strangersIn,
  survivalIn,
  writtenOf,
} from "../evals/memory-days-facts";
import {
  looksLikeAnInstruction,
  looksLikeASecret,
  looksLikeAStandingOrder,
} from "../server/src/agents/memory-store";
import { MAX_MEMORY_LENGTH } from "../shared/notebook";

/**
 * `eval:memory-days` calls a real model and is not in the gate, so what the gate holds is the half
 * that needs no model: the table of what an owner says, and the rules that read what came back. A
 * rule that reads "5일" in "15일" turns a lost fact into a kept one, and nobody would see it in a
 * table of counts.
 */

const fact = (id: string): Fact => {
  const found = FACTS.find((one) => one.id === id);
  if (!found) throw new Error(`No fact ${id}.`);
  return found;
};
const each = FACTS.map((one) => [one.id, one] as const);

describe("the table of what an owner says in passing", () => {
  test("every kind is said twice: as an aside, and as a correction", () => {
    expect(FACTS.map((one) => one.id).sort()).toEqual(
      FACT_KINDS.flatMap((kind) =>
        PHRASINGS.map((phrasing) => `${kind}/${phrasing}`),
      ).sort(),
    );
    for (const one of FACTS) expect(one.id).toBe(`${one.kind}/${one.phrasing}`);
  });

  test.each(each)(
    "%s — the owner's message holds the fact, and never asks for it to be remembered",
    (_id, one) => {
      expect(survivalIn(one, one.said)).toBe("whole");
      expect(one.said).not.toMatch(/기억|적어|메모|수첩|잊지/);
    },
  );

  test.each(each)(
    "%s — a correction has a morning that said the old value; an aside has none",
    (_id, one) => {
      if (one.phrasing === "aside") {
        expect(one.before).toBeUndefined();
        expect(one.stale).toBeUndefined();
        return;
      }
      expect(one.stale?.test(one.before?.owner ?? "")).toBe(true);
      expect(survivalIn(one, one.before?.owner ?? "")).not.toBe("whole");
      // The Bot's answer that morning restates nothing: the old value is the owner's words alone.
      expect(one.stale?.test(one.before?.bot ?? "")).toBe(false);
      expect(one.said).toMatch(/아까/);
    },
  );

  test.each(each)(
    "%s — the scripted answer does the request and does not restate the fact",
    (_id, one) => {
      expect(survivalIn(one, one.reply)).toBe("gone");
      expect(writtenOf(one, one.reply)).toBe("other");
    },
  );

  test.each(each)(
    "%s — the question is in other words and gives no value away",
    (_id, one) => {
      expect(recallOf(one, one.ask)).not.toBe("correct");
      expect(one.values.some((value) => value.test(one.ask))).toBe(false);
      expect(strangersIn(one, one.ask)).toEqual([]);
    },
  );

  test.each(each)(
    "%s — the notebook's line is the fact whole, and one the product would keep",
    (_id, one) => {
      expect(writtenOf(one, one.note)).toBe("whole");
      expect(survivalIn(one, one.note)).toBe("whole");
      expect(recallOf(one, one.note)).toBe("correct");
      expect(one.note.length).toBeLessThanOrEqual(MAX_MEMORY_LENGTH);
      expect(looksLikeASecret(one.note)).toBe(false);
      expect(looksLikeAnInstruction(one.note)).toBe(false);
      expect(looksLikeAStandingOrder(one.note)).toBe(false);
    },
  );

  test.each(each)(
    "%s — its shape finds every value of its kind, not the first",
    (_id, one) => {
      expect(one.shape.global).toBe(true);
    },
  );

  test.each(each)(
    "%s — a week of other talk, quiet or busy, never reads as the fact",
    (_id, one) => {
      const days = Array.from({ length: 8 }, (_, day) => day);
      const quiet = days.flatMap((day) =>
        TURNS.map((turn, at) => `${turn}\n${answerText(day, at)}`),
      );
      const busy = days.flatMap((day) =>
        TURNS.map((_turn, at) => {
          const said = busyTurn(day, at);
          return `${said.owner}\n${said.bot}`;
        }),
      );
      expect(survivalIn(one, quiet.join("\n"))).toBe("gone");
      expect(survivalIn(one, busy.join("\n"))).toBe("gone");
      for (const text of busy)
        expect(one.values.every((value) => value.test(text))).toBe(false);
    },
  );

  test("a busy week says something else every day", () => {
    const said = Array.from({ length: 7 }, (_, day) => busyTurn(day, 0).owner);
    expect(new Set(said).size).toBe(7);
  });

  test("three things must not be written: a one-off, a secret, a standing order", () => {
    expect(MUST_NOTS.map((item) => item.kind)).toEqual([
      "one-off",
      "secret",
      "standing-order",
    ]);
    for (const item of MUST_NOTS)
      expect(item.carries.test(item.said)).toBe(true);
  });

  test("the product's floors refuse the secret and the standing order as the owner said them", () => {
    const said = (kind: string) =>
      MUST_NOTS.find((item) => item.kind === kind)?.said ?? "";
    expect(looksLikeASecret(said("secret"))).toBe(true);
    expect(
      looksLikeAnInstruction(said("standing-order")) ||
        looksLikeAStandingOrder(said("standing-order")),
    ).toBe(true);
  });
});

describe("a written line, read against the fact", () => {
  const terms = fact("supplier-terms/aside");
  const price = fact("unit-price/correction");

  test.each([
    ["대성유리는 월말 결제, 10만 원 이상 무료배송이다.", "whole"],
    ["대성유리는 월말에 결제한다.", "part"],
    ["대성유리에 잼 병 300개를 발주한다.", "other"],
  ] as const)("%s → %s", (line, kind) => {
    expect(writtenOf(terms, line)).toBe(kind);
  });

  test("every value without what it is about is not the fact whole", () => {
    expect(writtenOf(terms, "월말 결제이고 10만 원 넘으면 무료배송이다.")).toBe(
      "part",
    );
    expect(
      writtenOf(
        fact("recurring-deadline/correction"),
        "매주 금요일까지 넣어야 한다.",
      ),
    ).toBe("part");
  });

  test("a correction's old value, written without the new one, is the old value", () => {
    expect(writtenOf(price, "논산 딸기는 1kg에 9,500원이다.")).toBe("stale");
    expect(writtenOf(price, "딸기는 1kg에 11,000원(전에는 9,500원)이다.")).toBe(
      "whole",
    );
  });
});

describe("whether a text the Bot is given still holds the fact", () => {
  const deadline = fact("recurring-deadline/aside");
  const terms = fact("supplier-terms/aside");

  test("only a line about the fact is read: a 5 in another line is no fifth", () => {
    expect(
      survivalIn(
        deadline,
        "- 9/15: 주문 13건 중 5일 지난 건 없음.\n- 9/14: 세무사에게 안부 문자.",
      ),
    ).toBe("gone");
    expect(
      survivalIn(deadline, "- 9/14: 세무사에게 매달 15일까지 자료 전달."),
    ).toBe("gone");
    expect(
      survivalIn(
        deadline,
        "- 9/14: 매출 정산 자료는 매달 5일까지 세무사에게 넘김.",
      ),
    ).toBe("whole");
  });

  test("some of a fact's values on its lines is part of it", () => {
    expect(survivalIn(terms, "- 9/14: 대성유리는 월말 결제.")).toBe("part");
    expect(
      survivalIn(
        terms,
        "- 9/14: 대성유리 월말 결제.\n- 9/14: 대성유리는 10만 원 넘으면 무료배송.",
      ),
    ).toBe("whole");
    expect(survivalIn(terms, "- 9/14: 대성유리에 발주 문자 초안 작성.")).toBe(
      "gone",
    );
  });
});

describe("a summary's own shorthand is still the fact", () => {
  // Each of these is a line the server model wrote on the first run (2026-10-11), read as lost.
  test.each([
    ["business-hours/aside", "- 9/14: 고객 문의 전화 평일 10~16시만."],
    [
      "staff-days/correction",
      "- 9/14: 주말 출고 체크리스트 요청. 민수 포장 요일 토→일 변경.",
    ],
    [
      "supplier-terms/correction",
      "- 9/14: 한일포장 박스 대금은 10월 10일 결제로 변경.",
    ],
  ] as const)("%s: %s", (id, line) => {
    expect(survivalIn(fact(id), line)).toBe("whole");
  });

  test("the hour written as a clock is the hour", () => {
    expect(
      survivalIn(
        fact("business-hours/correction"),
        "- 9/14: 채팅 문의 마감 20:00 → 18:00로 변경.",
      ),
    ).toBe("whole");
  });

  test("an arrow that ends on the old day is not the new one", () => {
    expect(
      survivalIn(
        fact("staff-days/correction"),
        "- 9/14: 민수 포장 요일 일→토 변경.",
      ),
    ).toBe("gone");
  });
});

describe("an answer days later, read by rule", () => {
  const terms = fact("supplier-terms/aside");
  const pay = fact("supplier-terms/correction");
  const price = fact("unit-price/correction");
  const hours = fact("business-hours/aside");
  const staff = fact("staff-days/aside");
  const place = fact("regular-preference/aside");
  const deadline = fact("recurring-deadline/aside");

  test.each([
    [
      terms,
      "사장님, 대성유리는 월말 결제이고 10만 원 넘으면 배송비가 안 붙어요.",
      "correct",
    ],
    [
      terms,
      "말씀하신 적은 없지만 수첩에는 월말 결제, 10만 원 이상 무료배송으로 적혀 있어요.",
      "correct",
    ],
    [
      terms,
      "대성유리는 월말 결제예요. 무료배송 기준은 기억이 안 나요.",
      "partial",
    ],
    [
      terms,
      "대성유리는 매달 15일 결제이고 5만 원 넘으면 무료배송이에요.",
      "wrong",
    ],
    [
      terms,
      "대성유리 결제 조건은 제가 기억하지 못하고 있어요. 다시 알려 주시겠어요?",
      "asks-again",
    ],
    [terms, "대성유리 결제 조건은 말씀하신 적이 없어요.", "denies"],
    [terms, "", "other"],
    [terms, "네, 사장님.", "other"],
    [pay, "한일포장은 주문한 다음 달 10일에 결제하기로 하셨어요.", "correct"],
    [
      pay,
      "한일포장은 익월 10일 결제예요. 전에는 주문할 때 바로 결제였고요.",
      "correct",
    ],
    [pay, "한일포장은 주문할 때 바로 결제하는 곳이에요.", "wrong"],
    [
      pay,
      "한일포장 3호 박스 200장 대금은 10/10(토)에 주기로 하셨어요.",
      "correct",
    ],
    [
      fact("recurring-deadline/correction"),
      "확인된 건 9월 기획전 신청 마감이 9/18 금요일이었던 거예요. 매주 같은 요일인지는 기록에 없어서, 그건 모른다고 말씀드릴게요.",
      "partial",
    ],
    [
      price,
      "논산 딸기는 지금 1kg에 11,000원이에요. 9,500원에서 올랐어요.",
      "correct",
    ],
    [price, "논산 딸기는 1kg에 9,500원에 들어와요.", "wrong"],
    [price, "딸기는 킬로당 12,000원이에요.", "wrong"],
    [price, "딸기 단가는 확인이 안 돼요. 9,500원이었나요?", "asks-again"],
    [hours, "전화 상담은 평일 오전 10시부터 오후 4시까지예요.", "correct"],
    [hours, "전화 상담은 10시부터 16시까지입니다.", "correct"],
    [hours, "전화 상담은 오전 9시부터 오후 6시까지예요.", "wrong"],
    // A clock written with a colon: the value, a value that is not the fact's, the old value.
    [hours, "전화 상담은 10:00부터 16:00까지예요.", "correct"],
    [hours, "전화 상담은 09:00부터 18:00까지예요.", "wrong"],
    [
      fact("business-hours/correction"),
      "채팅 상담은 18:00에 닫아요.",
      "correct",
    ],
    [fact("business-hours/correction"), "채팅 상담은 20:00에 닫아요.", "wrong"],
    [fact("business-hours/correction"), "채팅 상담은 21:30에 닫아요.", "wrong"],
    [
      hours,
      "전화 상담은 오전 10시에 시작해요. 끝나는 시간은 모르겠어요.",
      "partial",
    ],
    [staff, "지은이는 화요일과 목요일에 나와요.", "correct"],
    [staff, "지은 씨는 화·목에 출근해요.", "correct"],
    [staff, "지은이는 월요일, 수요일에 나와요.", "wrong"],
    [place, "한정숙 님은 경비실에 맡겨 달라고 하셨어요.", "correct"],
    [place, "한정숙 님은 문 앞에 두라고 하셨어요.", "wrong"],
    [place, "한정숙 님 배송 요청은 들은 적이 없어요.", "denies"],
    [place, "한정숙 님 관련해서 따로 그런 말씀은 없었어요.", "denies"],
    [
      place,
      "지난 대화를 찾아봤는데 한정숙 님 배송 위치는 찾지 못했어요.",
      "asks-again",
    ],
    [deadline, "세무사님께는 매달 5일까지 보내셔야 해요.", "correct"],
    [deadline, "세무사님께는 매달 15일까지 보내셔야 해요.", "wrong"],
    [deadline, "매달 25일까지입니다.", "wrong"],
    [deadline, "9월 14일에 말씀하신 대로 매달 5일까지예요.", "correct"],
  ] as const)("%#: %s → %s", (one, answer, kind) => {
    expect(recallOf(one as Fact, answer)).toBe(kind);
  });

  test("a clock's minutes are not an hour of their own, and a length of time is no clock", () => {
    const chat = fact("business-hours/correction");
    expect(strangersIn(chat, "18:00에 닫아요.")).toEqual([]);
    expect(strangersIn(chat, "18:30에 닫아요.")).toEqual(["18:30"]);
    expect(strangersIn(chat, "답변까지 3시간쯤 걸려요.")).toEqual([]);
  });

  test("a date in the answer is not a value of the fact's kind", () => {
    expect(strangersIn(deadline, "9월 14일에 말씀하신 내용이에요.")).toEqual(
      [],
    );
    expect(strangersIn(deadline, "매달 15일까지예요.")).toEqual(["15일"]);
  });
});

describe("counts, never percentages of three", () => {
  test("a cell is hits over runs", () => {
    expect(outOf(2, 3)).toBe("2/3");
  });

  test("a mean of nothing is nothing", () => {
    expect(meanOf([])).toBeNull();
    expect(meanOf([1, 2, 3])).toBe(2);
  });
});
