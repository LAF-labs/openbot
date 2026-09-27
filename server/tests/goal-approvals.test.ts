/**
 * A yes is read from the card's title only (2026-09-27 code sprint): a short goal title used to be
 * matched anywhere in any approved card, so a yes to "운동화 결제" could save the goal "운동".
 */
import { describe, expect, test } from "bun:test";
import { goalApprovals } from "../src/goals/tools";

describe("which yes saves which goal", () => {
  test("the card's own title saves the goal of that title, once", () => {
    const yeses = goalApprovals();
    yeses.approved({ title: "토익 800점 넘기기", details: [] });
    expect(yeses.spend("토익 800점 넘기기")).toBe(true);
    expect(yeses.spend("토익 800점 넘기기")).toBe(false);
  });

  test("a short title found inside another card's words is not a yes", () => {
    const yeses = goalApprovals();
    yeses.approved({
      title: "운동화 결제",
      summary: "운동할 때 신을 신발",
      details: [{ label: "금액", value: "89,000원" }],
    });
    expect(yeses.spend("운동")).toBe(false);
  });

  test("a word only in the details is not a yes", () => {
    const yeses = goalApprovals();
    yeses.approved({
      title: "이 목표로 할까요?",
      summary: "건강 챙기기",
      details: [{ label: "방법", value: "매일 만 보 걷기" }],
    });
    expect(yeses.spend("매일 만 보 걷기")).toBe(false);
  });

  test("the summary, when the title only asks, carries the yes", () => {
    const yeses = goalApprovals();
    yeses.approved({ title: "이 목표로 할까요?", summary: "12월 토익 800점" });
    expect(yeses.spend("12월 토익 800")).toBe(true);
  });

  test("the goal's words making up most of the card's title are a yes", () => {
    const yeses = goalApprovals();
    yeses.approved({ title: "목표: 토익 800점 넘기기" });
    expect(yeses.spend("토익 800점 넘기기")).toBe(true);
  });
});
