/**
 * The main conversation's project tool, as the bridge and the store see it (record §3, piece 4-4;
 * `shared/tools/projects.ts`): behind the bridge and never at the head, found by the words a Bot
 * would look for it with, the mark and the one sentence a deleted project's copy is covered by —
 * and the words a question put to a project is carried in.
 */
import { describe, expect, test } from "bun:test";
import { FACTS } from "../evals/memory-days-facts";
import {
  earlierSummaryText,
  REMINDER_CLOSE,
  REMINDER_OPEN,
} from "../shared/prompt/context.ko";
import { TOOL_RESULT_KO } from "../shared/prompt/tool-results.ko";
import { TOOL_RESULT_CUT } from "../shared/spillover";
import {
  CORE_TOOL_NAMES,
  DEPLOYMENT_FAMILIES,
  deferredFamiliesLine,
  deferredToolsText,
  exposureOf,
  FAMILY_LABELS_KO,
  isDeferredToolName,
  oneLine,
  PAST_TALK_LOOKUP,
  searchTools,
  serverKeyOf,
} from "../shared/tools/bridge";
import { GOAL_TOOLS } from "../shared/tools/goals";
import {
  isProjectReadKind,
  isProjectToolName,
  PROJECT_ANSWER_MAX_CHARS,
  PROJECT_CONTENT_REMOVED,
  PROJECT_QUERY_READ_ONLY,
  PROJECT_QUESTION_MAX_CHARS,
  PROJECT_READ_KINDS,
  PROJECT_TOOLS,
  PROJECTS_FAMILY,
  projectQuestionText,
  projectsReadBy,
  READ_PROJECTS,
  REMOVED_PROJECT_RESULT,
  readsOnly,
  readsOnlyForwarded,
} from "../shared/tools/projects";

const [tool] = PROJECT_TOOLS;

describe("where the tool stands", () => {
  test("one tool, behind the bridge: its name in the context layer and nothing at the head", () => {
    expect(PROJECT_TOOLS).toHaveLength(1);
    expect(tool?.name).toBe(READ_PROJECTS);
    expect(READ_PROJECTS).toBe("mcp__projects__read");
    expect(isDeferredToolName(READ_PROJECTS)).toBe(true);
    expect(exposureOf(READ_PROJECTS)).toBe("deferred");
    expect(CORE_TOOL_NAMES.has(READ_PROJECTS)).toBe(false);
    expect(isProjectToolName(READ_PROJECTS)).toBe(true);
    expect(isProjectToolName("mcp__projects__write")).toBe(false);
  });

  test("it is named to the Bot under 프로젝트·지난 대화 검색, and counted as nobody's connection", () => {
    expect(serverKeyOf(READ_PROJECTS)).toBe(PROJECTS_FAMILY);
    expect(FAMILY_LABELS_KO[PROJECTS_FAMILY]).toBe("프로젝트·지난 대화 검색");
    expect(DEPLOYMENT_FAMILIES.has(PROJECTS_FAMILY)).toBe(true);
    expect(deferredToolsText([READ_PROJECTS])).toContain(
      `- 프로젝트·지난 대화 검색: ${READ_PROJECTS}`,
    );
    // A person with nothing connected is not told to look again among "connected services".
    expect(deferredFamiliesLine([READ_PROJECTS])).toBe(
      "지금 연결된 서비스는 없다.",
    );
  });

  test.each([
    "프로젝트",
    "프로젝트 요약",
    "다른 대화 검색",
    "지난 대화에서 찾기",
    "대화 기록 검색",
    "project summary",
    // The words the summary header sends a Bot looking with.
    PAST_TALK_LOOKUP,
    "요약에 없는 지난 일",
  ])("a Bot looking for it with %j finds it first", (query) => {
    const beside = [...GOAL_TOOLS, ...PROJECT_TOOLS];
    expect(searchTools(beside, query)[0]?.name).toBe(READ_PROJECTS);
  });

  test("a search's one line for it says what it is, whole", () => {
    const line = oneLine(tool?.description ?? "");
    expect(line).toBe(
      "이 대화의 지난 말과 이 사람의 프로젝트(따로 나눈 대화)를 읽는다.",
    );
  });
});

/*
 * THE WAY BACK TO WHAT THE SUMMARY LACKS. Told "모른다고 하거나 다시 확인한다", the Bot did not look in
 * its own past conversation: 0 of 9 real turns on 2026-10-12, 14 of 75 mornings in the sixty-night
 * walk (#200) — and every correct answer on those mornings came from the search. The search was
 * named to it as "프로젝트" and nothing else. Now the header names the tool as the list calls it,
 * the list calls it what the header says, and the tool's own words lead with this conversation's
 * past. Muse's route, as it describes it: summary lacks it → search memory, past conversation
 * first → read what is found → answer from it; say "I don't know" only after the search is empty.
 */
describe("the way back to what the summary lacks", () => {
  // A day whose digits no evaluation fact's value shape reads as its own (the test below).
  const header = earlierSummaryText("- 어제의 한 줄", "2026-09-25 (금)").split(
    "\n",
  )[0] as string;

  test("the header sends the Bot to the search by the name the tool list gives it, before 모른다", () => {
    const label = FAMILY_LABELS_KO[PROJECTS_FAMILY] ?? "";
    expect(label).toContain(PAST_TALK_LOOKUP);
    expect(header).toContain(
      `${PAST_TALK_LOOKUP}(${READ_PROJECTS}, kind search)`,
    );
    // What the summary already answers is answered from it — the control: no search for that.
    const answers = header.indexOf("요약에 있는 것은 그대로 답한다");
    const search = header.indexOf(READ_PROJECTS);
    // One empty search is not proof; the latest statement wins over what a search finds.
    const unknown = header.indexOf("두세 번 달리 찾아본 뒤에만 모른다고 한다");
    expect(header).toContain("가장 나중 것이 맞다");
    expect(answers).toBeGreaterThan(-1);
    expect(search).toBeGreaterThan(answers);
    expect(unknown).toBeGreaterThan(search);
    // And a project's conversation, which has no such tool, is told what to do without one.
    expect(header).toContain("그 도구가 목록에 없으면 바로 모른다고 한다");
    expect(header).not.toContain("다시 확인한다");
    // With nothing summarised there is no header, and so no sentence sending anyone anywhere.
    expect(earlierSummaryText("  ", "2026-09-25 (금)")).toBe("");
  });

  test("the tool's own words lead with this conversation's past, in the line and in the kinds", () => {
    expect(oneLine(tool?.description ?? "")).toContain("이 대화의 지난 말");
    const parameters = tool?.parameters as unknown as {
      properties: { kind: { description: string } };
    };
    const kind = parameters.properties.kind.description;
    expect(kind.startsWith("search 이 대화의 지난 말")).toBe(true);
    // Searching is said to be for what the summary and the conversation at hand do not hold.
    const description = tool?.description ?? "";
    expect(description).toContain("요약에도 지금 대화에도 없으면 kind search");
    expect(description.indexOf("kind search")).toBeLessThan(
      description.indexOf("kind summary"),
    );
  });

  /*
   * What a model is told never holds an evaluation's own answers (docs/laf/eval-pack.md, "모델에게
   * 주는 말에 평가의 답을 넣지 않는다"): the header, the label and the description, held against every
   * fact `eval:memory-days` asks for — no subject, no value, no old value of any of them.
   */
  test("none of the evaluation's facts is in what the Bot reads about the search", () => {
    const read = [
      header,
      FAMILY_LABELS_KO[PROJECTS_FAMILY] ?? "",
      tool?.description ?? "",
    ].join("\n");
    expect(FACTS.length).toBeGreaterThan(0);
    for (const fact of FACTS) {
      expect(fact.entity.test(read)).toBe(false);
      for (const value of fact.values) expect(value.test(read)).toBe(false);
      if (fact.stale) expect(fact.stale.test(read)).toBe(false);
    }
    // The check can see a fact: the fact's own line is caught by it.
    const [first] = FACTS;
    expect(first?.values.every((value) => value.test(first.said))).toBe(true);
  });
});

describe("what it is called with", () => {
  test("four readings in one tool, and the reading is the one thing every call says", () => {
    const parameters = tool?.parameters as unknown as {
      properties: Record<string, { enum?: readonly string[] }>;
      required: readonly string[];
    };
    expect(parameters.properties.kind?.enum).toEqual([...PROJECT_READ_KINDS]);
    expect([...PROJECT_READ_KINDS]).toEqual([
      "list",
      "search",
      "summary",
      "ask",
    ]);
    expect(parameters.required).toEqual(["kind"]);
    expect(Object.keys(parameters.properties).sort()).toEqual([
      "cursor",
      "kind",
      "project",
      "question",
      "terms",
    ]);
  });

  test.each([
    "write",
    "query",
    "constructor",
    "toString",
    "",
    "LIST",
    3,
    null,
    undefined,
    // A row that is an array is spread into arguments: the value here is the array `["list"]`.
    [["list"]],
  ])("%j is no reading", (value) => {
    expect(isProjectReadKind(value)).toBe(false);
  });

  test("it says it only reads: nothing in its words offers to act in a project", () => {
    expect(tool?.description).toContain("읽기만 한다");
    // Asking is not a way round that, and the words say so where a Bot reads them.
    expect(tool?.description).toContain(
      "ask로 물어도 그쪽은 아무것도 하지 않는다",
    );
  });
});

describe("a question put to a project", () => {
  const text = projectQuestionText("숙소는 어디로 정했어?");

  test("is the question first, then a note of this deployment's that it is not the person's", () => {
    expect(text.startsWith("숙소는 어디로 정했어?\n\n")).toBe(true);
    const note = text.slice(text.indexOf(REMINDER_OPEN));
    expect(note.endsWith(REMINDER_CLOSE)).toBe(true);
    expect(note).toContain("이 사람이 쓴 것이 아니다");
    // What the asked side is told before it reaches for a tool, so no step is spent finding out.
    expect(note).toContain("도구를 쓰지 않는다");
    expect(note).toContain("이 대화에 남지 않는다");
  });

  test("the refusal a call is answered with says what to do next", () => {
    expect(TOOL_RESULT_KO[PROJECT_QUERY_READ_ONLY]).toContain(
      "이 대화에 이미 있는 것만으로 바로 답한다",
    );
  });

  test("a question and its answer are bounded well inside what a result may hold", () => {
    expect(PROJECT_QUESTION_MAX_CHARS).toBeLessThanOrEqual(1_000);
    expect(PROJECT_ANSWER_MAX_CHARS).toBeLessThanOrEqual(TOOL_RESULT_CUT / 8);
  });
});

describe("the word a run says when it only reads its conversation", () => {
  test("is read back as said", () => {
    expect(readsOnly(readsOnlyForwarded())).toBe(true);
    expect(readsOnly({ ...readsOnlyForwarded(), device: {} })).toBe(true);
  });

  test.each([
    [{}],
    [{ readsOnly: "true" }],
    [{ readsOnly: 1 }],
    [{ readsOnly: false }],
    [{ readOnly: true }],
    [null],
    [undefined],
    ["readsOnly"],
    [[true]],
  ])("%j is an ordinary run", (forwarded) => {
    expect(readsOnly(forwarded)).toBe(false);
  });
});

describe("the mark on a stored result", () => {
  test("is read as the projects it names", () => {
    expect(projectsReadBy({ lafProjects: ["a", "b"] })).toEqual(["a", "b"]);
  });

  test.each([
    [undefined],
    [null],
    ["channel_a"],
    [{}],
    [{ lafProjects: "channel_a" }],
    [{ lafProjects: { 0: "channel_a" } }],
    [{ lafProjects: [] }],
  ])("%j names none", (message) => {
    expect(projectsReadBy(message)).toEqual([]);
  });

  test("what is not an id in the list is left out, and the rest stand", () => {
    expect(projectsReadBy({ lafProjects: ["a", 3, "", null, "b"] })).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("what stands where a deleted project's content was", () => {
  test("is a call that worked and whose content is gone — never a call that failed", () => {
    expect(JSON.parse(REMOVED_PROJECT_RESULT)).toEqual({
      ok: true,
      removed: true,
      note: TOOL_RESULT_KO[PROJECT_CONTENT_REMOVED],
    });
  });

  test("the sentence says the order — read, then deleted — and that the answer given then stands", () => {
    const sentence = TOOL_RESULT_KO[PROJECT_CONTENT_REMOVED] ?? "";
    expect(sentence).toContain("읽어 온 내용이 있었고");
    expect(sentence).toContain("그 뒤에");
    expect(sentence).toContain("고치지 않는다");
    expect(sentence).toContain("다시 확인할 수 없다");
  });

  test("every fact the tool answers with has a sentence", () => {
    for (const code of [
      "laf:project_read_invalid",
      "laf:project_not_found",
      "laf:project_ambiguous",
      "laf:project_empty",
      "laf:project_summary_partial",
      "laf:project_summary_unavailable",
      "laf:project_read_bare",
      "laf:project_busy",
      "laf:project_ask_unavailable",
      PROJECT_QUERY_READ_ONLY,
      PROJECT_CONTENT_REMOVED,
    ]) {
      expect(Object.hasOwn(TOOL_RESULT_KO, code)).toBe(true);
    }
  });
});
