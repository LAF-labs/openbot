import { describe, expect, test } from "bun:test";
import {
  agreesWithTheCard,
  GANGNAM,
  HAEUNDAE,
  leavesItToTheCard,
  weatherAnswer,
} from "../evals/weather";

/**
 * THE JUDGE OF THE WEATHER SCENARIOS, JUDGED.
 *
 * The scenarios call a real model and never run in the gate, so a judge that could not fail would
 * pass every model for ever. The weather is drawn as a card (the owner, 2026-10-04), and the
 * answer under it is held to one sentence that leaves the forecast, and its source, to the card.
 * The answers below are the fleet's model's own, from the runs of 2026-10-04, and the ways the long
 * answer comes back.
 */

describe("an answer under the weather card", () => {
  test("is one sentence about what was asked", () => {
    for (const answer of [
      "사장님, 오늘은 맑고 선선한 하루예요.",
      "오늘 대구는 비 없이 구름만 조금 낀 정도예요",
      "지금 계신 곳은 비 없이 맑은 편이에요",
      "사장님, 서울 강남구 기준으로 지금은 맑고 선선해요.",
      "네, 내일 새벽에 비가 오니 우산 챙기는 게 좋아요",
      // Asked for a figure, the figure — and the date in brackets is not a second sentence.
      "내일 서울 최고 기온은 20도예요",
      "사장님, 내일(10/5 월) 부산 해운대는 맑다가 오후에 구름 많아지고 최고 31도까지 올라가요.",
    ]) {
      expect([answer, leavesItToTheCard(answer)]).toEqual([answer, true]);
    }
  });

  test("is not the forecast written out again: by its length, its lines or its figures", () => {
    for (const answer of [
      // The answer as it was before the card (the local stack's conversation, 2026-10-04).
      "인천은 지금 11.6도, 맑음, 비 없음이에요. 오늘 10/4(일) 최저 15도 / 최고 24도, 오전 구름많음·오후 흐림, 저녁 19~24시에 비 와요.",
      // Short, and still two figures.
      "오늘은 최저 12도, 최고 21도예요.",
      // One sentence to open, and the recital under it.
      "사장님, 서울 강남구 기준으로 오늘은 맑고 비 없이 선선해요.\n\n지금 17도 정도예요.",
      "오늘은 맑아요.\n내일은 흐려요.",
      "",
    ]) {
      expect([answer, leavesItToTheCard(answer)]).toEqual([answer, false]);
    }
  });

  /*
   * The first cut counted characters and figures only, and this passed it: two sentences and the
   * source, under a check that says "one sentence" in its own failure line (Codex on pull request
   * 62).
   */
  test("is not two sentences, and does not name the source the card already names", () => {
    for (const answer of [
      "오늘은 흐리고 비가 옵니다. 자세한 예보는 기상청 자료입니다.",
      "오늘은 맑아요! 내일은 비가 와요.",
      "오늘은 맑고 선선해요. 출처: 기상청",
      "기상청 예보로는 오늘 맑아요.",
      "오늘은 맑아요 (출처: 기상청)",
    ]) {
      expect([answer, leavesItToTheCard(answer)]).toEqual([answer, false]);
    }
  });

  /*
   * A sentence was split from the next only at a space, so two that follow one another with none
   * were one (Codex on pull request 62, a round later). What follows a mark decides: more words are
   * a second sentence; a digit is the rest of a figure; a closing bracket or quote, or another mark,
   * is the end of the same sentence.
   */
  test("counts a sentence that follows another with no space, and not the point inside a figure", () => {
    for (const answer of [
      "오늘은 맑아요.내일은 흐려요.",
      "오늘은 맑아요!내일은 비가 와요",
      "비는 안 와요?네, 안 와요.",
      // The closing quote or bracket ends the first sentence with its mark (review, round 5).
      "“오늘은 맑아요.” 내일은 흐려요.",
      "(오늘은 맑아요.) 내일은 흐려요",
      '"맑음"이에요."내일"은 흐려요.',
    ]) {
      expect([answer, leavesItToTheCard(answer)]).toEqual([answer, false]);
    }
    for (const answer of [
      "지금은 17.3도예요.",
      "내일 최고는 20.5도까지 올라가요",
      "우산은 안 챙기셔도 돼요!!",
      "오늘은 맑아요(내일은 흐려요.)",
      '네, "맑음"이에요.',
    ]) {
      expect([answer, leavesItToTheCard(answer)]).toEqual([answer, true]);
    }
  });
});

/*
 * THE SHAPE IS NOT THE TRUTH. One sentence with no figure and no source can still contradict the card
 * it stands under — "오늘은 폭설이에요" under a clear sky (Codex on pull request 62). The scenarios'
 * forecast is one sky: clear, clouds in the afternoon, nothing falling until the fourth day.
 */
describe("an answer that agrees with the card", () => {
  const card = weatherAnswer(GANGNAM, new Date("2026-10-04T03:00:00Z"), true);
  test("says something the card says", () => {
    for (const answer of [
      "사장님, 오늘은 맑고 선선한 하루예요.",
      "오늘 대구는 비 없이 구름만 조금 낀 정도예요",
      "지금 계신 곳은 비 없이 맑은 편이에요",
      "비는 안 와요, 우산은 두고 가셔도 돼요.",
      "오늘은 바람도 약하고 하늘이 맑아요",
      // The card's own figures, as written or rounded: the reading now, a day's low or high.
      "강남구는 지금 17.3도예요",
      "지금 17도 정도로 선선해요",
      "오늘 최고 21도, 최저 12도예요",
    ]) {
      expect([answer, agreesWithTheCard(answer, card)]).toEqual([answer, true]);
    }
    // 해운대's card holds 31 as tomorrow's high; 강남's does not, and the same sentence fails under it.
    const haeundae = weatherAnswer(
      HAEUNDAE,
      new Date("2026-10-04T03:00:00Z"),
      false,
    );
    for (const answer of [
      "내일 최고 31도까지 올라가요, 사장님.",
      "사장님, 내일(10/5 월) 부산 해운대는 최고 31도까지 올라가니 낮에는 덥겠네요.",
    ]) {
      expect([answer, agreesWithTheCard(answer, haeundae)]).toEqual([
        answer,
        true,
      ]);
      expect([answer, agreesWithTheCard(answer, card)]).toEqual([
        answer,
        false,
      ]);
    }
  });

  test("does not say weather the card does not show, or nothing about the weather at all", () => {
    for (const answer of [
      "오늘은 폭설이에요.",
      "오늘은 비가 와요.",
      "지금 눈이 내리고 있어요",
      "오후부터 비가 올 거예요, 우산 챙기세요.",
      "오늘은 흐려요.",
      "태풍이 올라오고 있어요",
      // Not wrong, and not the weather either: nothing in it is on the card.
      "오늘은 바깥일하기 무난한 날이에요.",
      "네, 확인했어요.",
      "",
      // A figure the card does not hold (review, round 7): 99 is nobody's temperature, 25 is not today's.
      "강남은 지금 99도예요.",
      "오늘 최고 25도까지 올라가요",
    ]) {
      expect([answer, agreesWithTheCard(answer, card)]).toEqual([
        answer,
        false,
      ]);
    }
  });
});
