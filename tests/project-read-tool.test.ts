/**
 * The main conversation's project tool, as the bridge and the store see it (record §3, piece 4-4's
 * first part; `shared/tools/projects.ts`): behind the bridge and never at the head, found by the
 * words a Bot would look for it with, and the mark and the one sentence a deleted project's copy
 * is covered by.
 */
import { describe, expect, test } from "bun:test";
import { TOOL_RESULT_KO } from "../shared/prompt/tool-results.ko";
import {
  CORE_TOOL_NAMES,
  DEPLOYMENT_FAMILIES,
  deferredFamiliesLine,
  deferredToolsText,
  exposureOf,
  FAMILY_LABELS_KO,
  isDeferredToolName,
  oneLine,
  searchTools,
  serverKeyOf,
} from "../shared/tools/bridge";
import { GOAL_TOOLS } from "../shared/tools/goals";
import {
  isProjectReadKind,
  isProjectToolName,
  PROJECT_CONTENT_REMOVED,
  PROJECT_READ_KINDS,
  PROJECT_TOOLS,
  PROJECTS_FAMILY,
  projectsReadBy,
  READ_PROJECTS,
  REMOVED_PROJECT_RESULT,
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

  test("it is named to the Bot under 프로젝트, and counted as nobody's connection", () => {
    expect(serverKeyOf(READ_PROJECTS)).toBe(PROJECTS_FAMILY);
    expect(FAMILY_LABELS_KO[PROJECTS_FAMILY]).toBe("프로젝트");
    expect(DEPLOYMENT_FAMILIES.has(PROJECTS_FAMILY)).toBe(true);
    expect(deferredToolsText([READ_PROJECTS])).toContain(
      `- 프로젝트: ${READ_PROJECTS}`,
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
  ])("a Bot looking for it with %j finds it first", (query) => {
    const beside = [...GOAL_TOOLS, ...PROJECT_TOOLS];
    expect(searchTools(beside, query)[0]?.name).toBe(READ_PROJECTS);
  });

  test("a search's one line for it says what it is, whole", () => {
    const line = oneLine(tool?.description ?? "");
    expect(line).toBe("이 사람의 프로젝트(따로 나눈 대화)를 읽는다.");
  });
});

describe("what it is called with", () => {
  test("three readings in one tool, and the reading is the one thing every call says", () => {
    const parameters = tool?.parameters as unknown as {
      properties: Record<string, { enum?: readonly string[] }>;
      required: readonly string[];
    };
    expect(parameters.properties.kind?.enum).toEqual([...PROJECT_READ_KINDS]);
    expect([...PROJECT_READ_KINDS]).toEqual(["list", "search", "summary"]);
    expect(parameters.required).toEqual(["kind"]);
    expect(Object.keys(parameters.properties).sort()).toEqual([
      "cursor",
      "kind",
      "project",
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
      PROJECT_CONTENT_REMOVED,
    ]) {
      expect(Object.hasOwn(TOOL_RESULT_KO, code)).toBe(true);
    }
  });
});
