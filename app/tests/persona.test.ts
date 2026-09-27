import { describe, expect, test } from "bun:test";
import {
  effectivePersona,
  PERSONAS,
  parsePersonaAnswer,
  STUDENT_STAGES,
  WORK_FIELDS,
} from "@shared/persona";
import { parseFirstTaskPress } from "../../server/src/agents/first-task";
import {
  COMPUTER_FIRST_TASK,
  type FirstTask,
  firstTaskPressBody,
  NO_CONNECTION_TASKS,
  PERSONA_TASKS,
  pickFirstTasks,
  SUPPORT_PROGRAMS_FIRST_TASK,
} from "../src/lib/agents/first-tasks";
import { ko } from "../src/lib/i18n-ko";
import { PERSONA_LABELS } from "../src/lib/persona/labels";

/**
 * WHO THE PERSON IS ORDERS THE ROW; IT NEVER TAKES ANYTHING OFF THE TABLE (2026-09-27).
 *
 * The owner: "학생이고 사장님이고간에 참고만 하는 거지 메뉴체계가 바뀌어선 안 돼." So the first chips
 * lead with the answer, and the tables every chip is drawn from are the same for everybody. These
 * tables are read through `t(variable)` — invisible to `i18n-coverage.test.ts` — so they are walked
 * here, the way `first-tasks.test.ts` walks its own.
 */

const nothing = { sites: [], accounts: [] };
const sentences = (tasks: FirstTask[]) =>
  tasks.flatMap((task) => (task.kind === "ask" ? [task.sentence] : []));

describe("the words", () => {
  test("every label, stage, field and persona sentence has Korean", () => {
    const keys = [
      ...Object.values(PERSONA_LABELS),
      ...STUDENT_STAGES.map((stage) => stage.name),
      ...WORK_FIELDS.map((field) => field.name),
      ...PERSONA_TASKS.student.map((task) => task.sentence),
      ...PERSONA_TASKS.worker.map((task) => task.sentence),
    ];
    expect(keys.filter((key) => !ko[key])).toEqual([]);
  });

  test("the four answers are the owner's four words", () => {
    expect(PERSONAS.map((persona) => ko[PERSONA_LABELS[persona]])).toEqual([
      "학생",
      "직장인",
      "사장님",
      "기타",
    ]);
  });

  test("a persona chip is a request a person could have typed, and says nothing about a shop", () => {
    for (const task of [...PERSONA_TASKS.student, ...PERSONA_TASKS.worker]) {
      expect(ko[task.sentence]).toMatch(/줘$/);
      expect(ko[task.sentence]).not.toContain("가게");
    }
  });

  test("the student follow-up starts at middle school: sign-up is 만 14세 이상", () => {
    const words = STUDENT_STAGES.map((stage) => ko[stage.name] ?? "");
    expect(words.some((word) => word.includes("초등"))).toBe(false);
  });
});

describe("the row, by who the person is", () => {
  test("a 학생 is led by the two study sentences, with the lookup and an office one after", () => {
    expect(sentences(pickFirstTasks(nothing, { persona: "student" }))).toEqual([
      PERSONA_TASKS.student[0]?.sentence,
      PERSONA_TASKS.student[1]?.sentence,
      COMPUTER_FIRST_TASK.sentence,
      PERSONA_TASKS.worker[0]?.sentence,
    ]);
  });

  test("a 직장인 is led by the two office sentences, with the lookup and a study one after", () => {
    expect(sentences(pickFirstTasks(nothing, { persona: "worker" }))).toEqual([
      PERSONA_TASKS.worker[0]?.sentence,
      PERSONA_TASKS.worker[1]?.sentence,
      COMPUTER_FIRST_TASK.sentence,
      PERSONA_TASKS.student[0]?.sentence,
    ]);
  });

  test("기타 leads with the lookup and one of each", () => {
    expect(sentences(pickFirstTasks(nothing, { persona: "other" }))).toEqual([
      COMPUTER_FIRST_TASK.sentence,
      PERSONA_TASKS.student[0]?.sentence,
      PERSONA_TASKS.worker[0]?.sentence,
      PERSONA_TASKS.student[1]?.sentence,
    ]);
  });

  test("사장님 and not-answered deal exactly the shop row they always did", () => {
    const shop = { kind: "food" as const, places: [] };
    const before = pickFirstTasks(nothing, { shop });
    expect(pickFirstTasks(nothing, { shop, persona: "owner" })).toEqual(before);
    expect(pickFirstTasks(nothing, { shop, persona: null })).toEqual(before);
    // And no persona sentence among them: a 사장님's padding is still the shop's.
    const personaSentences = new Set(
      [...PERSONA_TASKS.student, ...PERSONA_TASKS.worker].map(
        (task) => task.sentence,
      ),
    );
    expect(sentences(before).some((s) => personaSentences.has(s))).toBe(false);
  });

  test("every row is four sentences, one on the Bot's computer, and the way to 연결", () => {
    for (const persona of PERSONAS) {
      const tasks = pickFirstTasks(nothing, { persona });
      expect(sentences(tasks)).toHaveLength(4);
      expect(sentences(tasks)).toContain(COMPUTER_FIRST_TASK.sentence);
      expect(tasks.at(-1)).toEqual({ kind: "connect" });
    }
  });

  test("connected work still comes before the padding, and the lookup keeps its place", () => {
    const overview = {
      sites: [],
      accounts: [
        { id: "gmail", kind: "oauth", status: "connected" },
        { id: "google-calendar", kind: "oauth", status: "connected" },
      ],
    } as unknown as Parameters<typeof pickFirstTasks>[0];
    const row = sentences(pickFirstTasks(overview, { persona: "student" }));
    expect(row[0]).toBe(PERSONA_TASKS.student[0]?.sentence);
    expect(row).toContain(COMPUTER_FIRST_TASK.sentence);
    expect(row).toContain("Show me the mail nobody has answered.");
    expect(row).toHaveLength(4);
  });

  test("지원사업 is about a shop: never on a 학생's, 직장인's or 기타's row", () => {
    for (const persona of ["student", "worker", "other"] as const) {
      expect(
        sentences(
          pickFirstTasks(nothing, { persona, supportPrograms: true }),
        ).includes(SUPPORT_PROGRAMS_FIRST_TASK.sentence),
      ).toBe(false);
    }
  });

  test("the sets differ in order, never in what exists: every table is still offered to everyone", () => {
    // The shop padding is reachable from a student's row once it runs long, and the other way round.
    const all = (persona: (typeof PERSONAS)[number]) =>
      new Set(sentences(pickFirstTasks(nothing, { persona, count: 64 })));
    const everything = new Set([
      ...NO_CONNECTION_TASKS.map((task) => task.sentence),
      ...PERSONA_TASKS.student.map((task) => task.sentence),
      ...PERSONA_TASKS.worker.map((task) => task.sentence),
    ]);
    for (const persona of ["student", "worker", "other"] as const) {
      expect(all(persona)).toEqual(everything);
    }
  });

  test("every chip a persona row can draw is a press the server accepts", () => {
    const agentId = "agent_1f2e3d4c-aaaa-4bbb-8ccc-123456789abc";
    let checked = 0;
    for (const persona of PERSONAS) {
      for (const task of pickFirstTasks(nothing, { persona, count: 64 })) {
        const parsed = parseFirstTaskPress(
          firstTaskPressBody(
            task.kind === "connect"
              ? {
                  agentId,
                  kind: "connect",
                  pattern: null,
                  sentence: null,
                  via: null,
                  hint: null,
                }
              : {
                  agentId,
                  kind: "ask",
                  pattern: task.pattern,
                  sentence: task.sentence,
                  via: task.via,
                  hint: null,
                },
          ),
        );
        expect(parsed.ok).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
  });
});

describe("the effective persona", () => {
  test("what was pressed wins; a shop answered and nothing pressed reads as 사장님; nothing is unknown", () => {
    const food = { kind: "food" as const, places: [] };
    const empty = { kind: null, places: [] };
    expect(effectivePersona("student", food)).toBe("student");
    expect(effectivePersona(null, food)).toBe("owner");
    expect(effectivePersona(null, { kind: null, places: ["gmail"] })).toBe(
      "owner",
    );
    expect(effectivePersona(null, empty)).toBeNull();
    expect(effectivePersona(undefined, undefined)).toBeNull();
  });

  test("the door takes the four and null, and nothing else", () => {
    for (const persona of [...PERSONAS, null]) {
      expect(parsePersonaAnswer({ persona })).toEqual({
        ok: true,
        value: persona,
      });
    }
    for (const body of [{ persona: "teacher" }, {}, null, [], "student"]) {
      expect(parsePersonaAnswer(body).ok).toBe(false);
    }
  });
});
