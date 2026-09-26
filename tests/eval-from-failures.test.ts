/**
 * `eval:from-failures`: the week's 못 끝냄 as scenario skeletons, and nothing from a conversation.
 *
 * A saved insights answer is the fleet's path in, and a file is anybody's to edit: every field of
 * one is planted here with a sentence, and the whole output is searched for it.
 */
import { describe, expect, test } from "bun:test";
import { sectionOf, stubsFrom, weekLines } from "../scripts/eval-from-failures";

const PLANTED = "김사장 010-2233-4455 비밀번호 hunter2";

const saved = {
  window: { days: 7 },
  turns: {
    endings: { finished: 6, unfinished: 2, stopped: 1, owner: PLANTED },
    inFlight: 1,
    byOrigin: { chat: [7, 5], routine: [2, 1], [PLANTED]: [1, 1] },
    firstAnswer: [
      [31, 4],
      [52, 2],
      [140, 1],
      [PLANTED, 9],
    ],
    approvals: [3, 2],
    work: { modelRequests: 21, toolCalls: 14, retries: PLANTED },
    reasons: [
      ["unfinished", "laf:agent_unreachable", "chat", 1],
      ["unfinished", "laf:step_not_returned", "chat", 1],
      ["unfinished", PLANTED, "chat", 5],
      [PLANTED, "laf:uncoded", "chat", 5],
    ],
    cost: { usd: 0.21, owners: 1, ownerDays: 2 },
    cache: [40_000, 30_000],
    unfinished: [
      ["2026-09-26", "chat", "laf:agent_unreachable", 1, 0, 0, 0, 4],
      ["2026-09-25", "routine", "laf:step_not_returned", 3, 2, 1, 1, 61],
      ["2026-09-25", "chat", PLANTED, 1, 1, 1, 1, 1],
      [PLANTED, "chat", "laf:uncoded", 1, 1, 1, 1, 1],
      ["2026-09-25", PLANTED, "laf:uncoded", 1, 1, 1, 1, 1],
      ["2026-09-25", "chat", "laf:uncoded", PLANTED, 1, 1, 1, 1],
      ["2026-09-25", "chat", "laf:uncoded", 1, 1, 1, 1],
    ],
  },
};

describe("eval:from-failures", () => {
  const section = sectionOf(JSON.parse(JSON.stringify(saved)));

  test("keeps only the cells whose every field is the statement's shape", () => {
    expect(section?.unfinished).toEqual([
      ["2026-09-26", "chat", "laf:agent_unreachable", 1, 0, 0, 0, 4],
      ["2026-09-25", "routine", "laf:step_not_returned", 3, 2, 1, 1, 61],
    ]);
    expect(section?.reasons).toHaveLength(2);
    expect(Object.keys(section?.byOrigin ?? {})).toEqual(["chat", "routine"]);
  });

  test("the week's numbers are read from the cells", () => {
    // 9 ended (the planted `owner` is zero), 6 finished; p50 of 3.1/3.1/3.1/3.1/5.2/5.2/14 s.
    expect(section && weekLines(section, 7)).toEqual([
      "// 9 turns ended, 1 still with a window. 끝남 67%.",
      "// First answer p50 3.1 s, p90 14.0 s. Approvals per turn 0.33.",
      "// Cost per owner per day $0.0300. Prompt read from the cache 75%.",
      "// Why not 끝남: laf:agent_unreachable ×1, laf:step_not_returned ×1.",
    ]);
  });

  test("one skeleton per unfinished turn, every one a TODO for a person", () => {
    if (!section) throw new Error("the section did not read");
    const stubs = stubsFrom(section.unfinished, {
      days: 7,
      to: "2026-09-26T12:00:00.000Z",
      zone: "Asia/Seoul",
      week: weekLines(section, 7),
    });
    expect(stubs).toContain('id: "failure-2026-09-26-1-agent-unreachable"');
    expect(stubs).toContain('id: "failure-2026-09-25-2-step-not-returned"');
    expect(stubs.match(/mode: "routine"/g)).toHaveLength(1);
    expect(stubs.match(/TODO: the owner's request/g)).toHaveLength(2);
    expect(stubs).toContain("2 turns ended 못 끝냄");
    expect(stubs).not.toContain("hunter2");
    expect(stubs).not.toContain("010-2233");
  });

  test("a file that is not an insights answer reads as nothing, not as zero", () => {
    expect(sectionOf(null)).toBeNull();
    expect(sectionOf({ turns: null })).toBeNull();
    expect(sectionOf({ turns: { endings: {} } })).toBeNull();
  });
});
