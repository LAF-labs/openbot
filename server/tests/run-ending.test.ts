/**
 * How a run's ending is read for the owner: 끝남, 못 끝냄, 멈춤, 사장님 차례, and the code beside it.
 */
import { describe, expect, test } from "bun:test";
import {
  codeOf,
  ENDING_CODE_SOURCE,
  ENDING_CODES,
  type EndingFacts,
  endingOf,
  STEP_NOT_RETURNED,
  WITH_PERSON,
  WITH_WINDOW,
} from "../src/telemetry/run-ending";

const facts = (over: Partial<EndingFacts>): EndingFacts => ({
  status: "done",
  error: null,
  personNeeded: false,
  emptyAnswer: false,
  awaiting: false,
  approvalsOpen: 0,
  ...over,
});

describe("the ending", () => {
  test("a run that answered is 끝남, with no code", () => {
    expect(endingOf(facts({}))).toEqual({ ending: "finished", code: null });
  });

  test("an answer that came back empty twice is 못 끝냄", () => {
    expect(endingOf(facts({ emptyAnswer: true }))).toEqual({
      ending: "unfinished",
      code: ENDING_CODES.emptyAnswer,
    });
  });

  test("a routine that stopped for a person is the owner's turn, not a failure", () => {
    expect(endingOf(facts({ awaiting: true }))).toEqual({
      ending: "owner",
      code: ENDING_CODES.approvalUnanswered,
    });
  });

  test("a failure is 못 끝냄, coded from its text", () => {
    expect(endingOf(facts({ status: "error", error: "fetch failed" }))).toEqual(
      { ending: "unfinished", code: ENDING_CODES.unreachable },
    );
  });

  test("a Stop somebody pressed is 멈춤", () => {
    expect(endingOf(facts({ status: "stopped" }))).toEqual({
      ending: "stopped",
      code: ENDING_CODES.stopped,
    });
  });

  test("a step that never came back is 못 끝냄 — unless it was waiting on the owner", () => {
    const lost = facts({ status: "stopped", error: STEP_NOT_RETURNED });
    expect(endingOf(lost)).toEqual({
      ending: "unfinished",
      code: STEP_NOT_RETURNED,
    });
    expect(endingOf({ ...lost, approvalsOpen: 1 })).toEqual({
      ending: "owner",
      code: ENDING_CODES.approvalUnanswered,
    });
    expect(endingOf({ ...lost, personNeeded: true })).toEqual({
      ending: "owner",
      code: ENDING_CODES.personNeeded,
    });
    // Could not read the questions: not counted as the owner's.
    expect(endingOf({ ...lost, approvalsOpen: null })).toEqual({
      ending: "unfinished",
      code: STEP_NOT_RETURNED,
    });
  });

  test("a step with a window has no ending yet, and says whose it is", () => {
    expect(endingOf(facts({ status: "waiting" }))).toEqual({
      ending: null,
      code: WITH_WINDOW,
    });
    expect(endingOf(facts({ status: "waiting", personNeeded: true }))).toEqual({
      ending: null,
      code: WITH_PERSON,
    });
  });
});

describe("a code out of a failure's text", () => {
  const shape = new RegExp(ENDING_CODE_SOURCE);

  test("the Bot's own code is taken out of the sentence around it", () => {
    expect(
      codeOf(
        "The Bot's service refused: laf:turn_rate_limited (사장님 가게 매출 3,200,000원)",
      ),
    ).toBe("laf:turn_rate_limited");
  });

  test("everything else is a class, never the text", () => {
    expect(codeOf("connect ECONNREFUSED 127.0.0.1:4561")).toBe(
      ENDING_CODES.unreachable,
    );
    expect(codeOf("The routine did not finish in time")).toBe(
      ENDING_CODES.deadline,
    );
    expect(codeOf("stream ended before RUN_FINISHED")).toBe(
      ENDING_CODES.streamEnded,
    );
    expect(codeOf("주문번호 88123 고객 김철수 010-1234-5678")).toBe(
      ENDING_CODES.uncoded,
    );
    expect(codeOf(null)).toBeNull();
    expect(codeOf("")).toBeNull();
  });

  test("every code the ending writes has the one shape", () => {
    for (const code of [
      ...Object.values(ENDING_CODES),
      STEP_NOT_RETURNED,
      WITH_PERSON,
      WITH_WINDOW,
    ]) {
      expect([code, shape.test(code)]).toEqual([code, true]);
    }
  });
});
