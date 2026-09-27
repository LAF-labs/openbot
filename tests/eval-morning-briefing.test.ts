import { describe, expect, test } from "bun:test";
import { BRIEFING_SKILL } from "../app/src/lib/agents/morning-briefing";
import type { ObservedCall, StreamEvent } from "../evals/lib";
import {
  briefingBackend,
  GMAIL_INSTRUCTION,
  GMAIL_SEARCH,
  judgeMondayBriefing,
  judgeTuesdayBriefing,
  lastAnswerOf,
  NOTHING_CONNECTED_INSTRUCTION,
  SUPPORT_KEY,
} from "../evals/morning-briefing";
import { SUPPORT_SEARCH } from "../evals/support-programs";
import { readBuiltInSkills } from "../server/src/plugins/built-in-skills";

/**
 * THE JUDGE OF THE 아침 브리핑 SCENARIOS, JUDGED.
 *
 * The scenarios call a real model and never run in the gate, so a judge that could not fail would
 * pass every model for ever. These hand it briefings written the ways a Bot writes them — and then
 * each thing it exists to catch: a padded answer, last week's notice again, another region's, a
 * programme nobody returned, a cursor left where it was, and on a Tuesday any word of 지원사업.
 */

const MONDAY = "2026-09-28";
const runAt = () => new Date("2026-09-27T22:30:40Z");

const call = (name: string, args: Record<string, unknown> = {}): ObservedCall =>
  ({
    id: `call_${name}`,
    name,
    rawArguments: JSON.stringify(args),
    arguments: args,
  }) as ObservedCall;

/** A Monday run that searched, noted the cursor and wrote `text`. */
function monday(
  text: string,
  options: { lastAt?: string | null; searches?: number } = {},
) {
  const backend = briefingBackend(MONDAY, runAt);
  const calls: ObservedCall[] = [];
  for (let at = 0; at < (options.searches ?? 1); at += 1) {
    const search = call(SUPPORT_SEARCH, { hashtags: "서울", field: "01,05" });
    backend.answer(search);
    calls.push(search);
  }
  const lastAt =
    options.lastAt === undefined ? "2026-09-27T11:00:00+09:00" : options.lastAt;
  if (lastAt !== null) {
    backend.answer(
      call("routine_note", { action: "watermark", key: SUPPORT_KEY, lastAt }),
    );
  }
  return judgeMondayBriefing({
    text,
    calls,
    returned: backend.returned,
    notepad: backend.notepad(),
    week: backend.week,
    weather: "20.8",
    place: "마포",
  });
}

const failed = (conditions: Array<[string, boolean]>) =>
  conditions.filter(([, ok]) => !ok).map(([label]) => label);

const GOOD_MONDAY = [
  "**9월 28일 (월) 아침 브리핑**",
  "**날씨** 서울 마포구 20.8° 흐림, 최저 18° / 최고 24°",
  "**새 지원사업**",
  "- [서울] 마포구 소상공인 온라인 판로 지원사업 참여 업체 모집 · 마감 2026-10-12 · https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000126700",
  "- 2026년 하반기 소상공인 스마트상점 기술보급사업 참여자 모집 공고 · 마감 2026-10-18",
].join("\n");

describe("the Monday judge", () => {
  test("passes a short briefing of this week's notices with the cursor moved", () => {
    expect(failed(monday(GOOD_MONDAY))).toEqual([]);
  });

  test("fails an answer past about ten lines", () => {
    const padded = `${GOOD_MONDAY}\n${Array.from({ length: 9 }, (_, i) => `- 참고 ${i}`).join("\n")}`;
    expect(failed(monday(padded)).join()).toContain("줄");
  });

  test("fails last week's notice reported again, even shortened", () => {
    const again = `${GOOD_MONDAY}\n- 서울시 소상공인 경영환경개선 지원사업 · 마감 2026-10-09`;
    expect(failed(monday(again)).join()).toContain("지난주에 알린 공고");
  });

  test("fails another region's notice", () => {
    const busan = `${GOOD_MONDAY}\n- [부산] 2026년 부산광역시 소상공인 특례보증 지원 공고`;
    expect(failed(monday(busan)).join()).toContain("다른 지역 공고");
  });

  test("fails a programme nobody returned", () => {
    const invented = `${GOOD_MONDAY}\n- 2026년 소상공인 배달비 지원사업 참여자 모집`;
    expect(failed(monday(invented)).join()).toContain(
      "도구 결과에 없는 사업명",
    );
  });

  test("fails a cursor left where it was, or written without a zone and refused", () => {
    expect(failed(monday(GOOD_MONDAY, { lastAt: null })).join()).toContain(
      "기준점을 옮기지 않음",
    );
    // The server's draft refuses a time with no zone, so the cursor never moves: failed the same way.
    expect(
      failed(monday(GOOD_MONDAY, { lastAt: "2026-09-27T11:00:00" })).join(),
    ).toContain("기준점을 옮기지 않음");
  });

  test("fails a Monday that never searched, and one that searched past four times", () => {
    expect(failed(monday(GOOD_MONDAY, { searches: 0 })).join()).toContain(
      "월요일인데 기업마당을 찾지 않음",
    );
    expect(failed(monday(GOOD_MONDAY, { searches: 5 })).join()).toContain(
      "5번",
    );
  });

  test("fails the weather of somewhere else, and a section nobody asked for", () => {
    const jeju = GOOD_MONDAY.replace("서울 마포구 20.8°", "제주시 26.1°");
    expect(failed(monday(jeju)).length).toBeGreaterThan(0);
    const orders = `${GOOD_MONDAY}\n특이사항 없음: 주문`;
    expect(failed(monday(orders)).join()).toContain("지시에 없는 항목");
  });
});

describe("the Tuesday judge", () => {
  const searched = [call(GMAIL_SEARCH, { query: "in:inbox is:unread" })];
  const GOOD_TUESDAY = [
    "**9월 29일 (화) 아침 브리핑**",
    "**날씨** 서울 마포구 20.8° 흐림, 최저 18° / 최고 24°",
    "특이사항 없음: 메일",
  ].join("\n");
  const tuesday = (text: string, calls = searched) =>
    failed(
      judgeTuesdayBriefing({ text, calls, weather: "20.8", place: "마포" }),
    );

  test("passes the weather and one line for a quiet inbox", () => {
    expect(tuesday(GOOD_TUESDAY)).toEqual([]);
  });

  test("fails any word of 지원사업, and a search for it", () => {
    expect(
      tuesday(
        `${GOOD_TUESDAY}\n지원사업: 오늘은 월요일이 아니라 건너뜀`,
      ).join(),
    ).toContain("화요일에 지원사업을 씀");
    expect(
      tuesday(GOOD_TUESDAY, [...searched, call(SUPPORT_SEARCH)]).join(),
    ).toContain("화요일에 기업마당을 찾음");
  });

  test("fails a heading drawn over an empty inbox, and an inbox never looked at", () => {
    const padded = GOOD_TUESDAY.replace(
      "특이사항 없음: 메일",
      "**답 안 한 메일**\n- 없음",
    );
    expect(tuesday(padded).join()).toContain("메일 항목을 세움");
    expect(tuesday(GOOD_TUESDAY, []).join()).toContain("메일을 확인하지 않음");
  });

  test("fails [SILENT]", () => {
    expect(tuesday("[SILENT]").join()).toContain("[SILENT]");
  });
});

describe("what the scenarios send", () => {
  test("the routine's delivered answer is the last message, not the narration before the tools", () => {
    const events: StreamEvent[] = [
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "날씨부터 " },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "볼게요" },
      { type: "TOOL_CALL_START", toolCallId: "c1" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "b", delta: "**브리핑**" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "b", delta: "\n날씨" },
    ];
    expect(lastAnswerOf(events)).toBe("**브리핑**\n날씨");
    expect(lastAnswerOf([])).toBe("");
  });

  test("the chip's own instruction, naming a skill the package ships", async () => {
    expect(NOTHING_CONNECTED_INSTRUCTION.split("\n")).toEqual([
      `오늘 아침 브리핑을 ${BRIEFING_SKILL} 스킬대로 한 메시지로 보내 줘:`,
      "- 오늘 날씨",
      "- 오늘이 월요일이면: 새 지원사업 (기업마당)",
    ]);
    expect(GMAIL_INSTRUCTION).toContain("- 답 안 한 메일 (Gmail)");

    const skills = await readBuiltInSkills(
      new URL("../tenant/laf", import.meta.url).pathname,
    );
    const skill = skills.find((known) => known.slug === BRIEFING_SKILL);
    expect(skill).toBeDefined();
    // The key the judge reads is the key the skill tells the Bot to write, and the tool it writes with.
    expect(skill?.instructions).toContain(SUPPORT_KEY);
    expect(skill?.instructions).toContain("routine_note");
    expect(skill?.instructions).toContain("월요일");
  });
});
