/**
 * 목표의 툴 넷 — 다리 뒤에 선다 (muse-shape plan §3.4, phase 9).
 *
 * 발자국 사다리(CLAUDE.md)에서 건너뛴 칸과 그 까닭:
 * - 있는 코드를 넓히기: 루틴은 일정이지 상태가 있는 결과가 아니고, 수첩 줄에는 상태도 진행도 없다.
 *   어느 쪽을 구부려도 둘 다 거짓말을 하게 된다.
 * - 스킬만: 스킬은 순서를 일러 줄 수 있어도 상태와 기록을 남기지 못한다.
 * - 핵심 툴: 필요 없다. 다리가 있으니 이름만 맥락 층에 서고 머리(툴 목록)는 그대로다.
 *
 * 이름이 `mcp__goals__…`인 것은 다리가 연결된 서비스의 툴을 가르는 모양이 그것이기 때문이다
 * (`bridge.ts`의 `isDeferredToolName`, `FAMILY_LABELS_KO`의 "목표"). 연결된 서비스는 아니다 — 이
 * 배포의 서버가 직접 실행한다(`server/src/goals/tools.ts`). 그래서 대화의 머리는 목표가 생기기 전과
 * 바이트까지 같다(`eval:cache`로 잰다).
 *
 * 저장은 사람의 예 뒤에만: `save_goal`은 이번 턴에 사람이 예를 누른 askApproval 카드가 없으면, 또는
 * 그 카드에 이 제목이 없으면 거절된다(`laf:goal_needs_yes`). 설명에도 적지만, 막는 것은 코드다.
 */
import { CATEGORIES } from "../persona";
import {
  ENTRY_KINDS,
  GOAL_ENTRY_MAX,
  GOAL_TARGET_MAX,
  GOAL_TITLE_MAX,
  MOMENTUMS,
} from "../goals";
import { DEFERRED_TOOL_PREFIX } from "./bridge";
import type { JsonSchema } from "./standard-schema";

/** 목표 툴이 선 무리의 키. `mcp__goals__save_goal`의 `goals`. */
export const GOALS_FAMILY = "goals";

const named = (bare: string) =>
  `${DEFERRED_TOOL_PREFIX}${GOALS_FAMILY}__${bare}`;

export const SAVE_GOAL = named("save_goal");
export const UPDATE_GOAL = named("update_goal");
export const LOG_PROGRESS = named("log_progress");
export const LIST_GOALS = named("list_goals");

export type GoalTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

const CATEGORY_WORDS =
  "work 일·가게, study 공부·성장, money 돈·세금, health 건강, relationships 관계, life 생활, other 기타";

const measure = {
  type: "object",
  description: "지켜볼 숫자가 있으면: unit 단위, start 지금 값, goal 목표 값",
  properties: {
    unit: { type: "string" },
    start: { type: "number" },
    goal: { type: "number" },
  },
};

export const GOAL_TOOLS: readonly GoalTool[] = Object.freeze([
  {
    name: SAVE_GOAL,
    description:
      "목표를 목표 화면에 저장한다. 먼저 askApproval 카드로 이 제목·달성 기준·마감을 보여 주고, 사람이 예를 누른 뒤에만 부른다. 카드에 없는 제목이나 예가 없는 저장은 거절된다.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: CATEGORIES.map((one) => one.id),
          description: CATEGORY_WORDS,
        },
        title: {
          type: "string",
          description: `카드에 보여 준 제목 그대로, ${GOAL_TITLE_MAX}자까지`,
        },
        target: {
          type: "string",
          description: `무엇이 되면 달성인지, ${GOAL_TARGET_MAX}자까지`,
        },
        dueOn: { type: "string", description: "마감 YYYY-MM-DD. 없으면 뺀다" },
        measure,
      },
      required: ["category", "title", "target"],
    },
  },
  {
    name: UPDATE_GOAL,
    description:
      "사람이 말한 대로 목표를 고친다: 제목·달성 기준·마감·숫자, 또는 점검 루틴을 잇는다(routine에 루틴 이름). 완료·그만두기는 사람이 목표 화면에서 한다.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "list_goals의 id" },
        title: { type: "string" },
        target: { type: "string" },
        dueOn: { type: "string", description: "YYYY-MM-DD" },
        measure,
        routine: {
          type: "string",
          description: "이 목표를 점검할 루틴의 이름",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: LOG_PROGRESS,
    description: `목표에 진행을 한 줄 적는다: 사람이 말한 진행("오늘 30분 했어")이나 점검 루틴이 확인한 것. ${GOAL_ENTRY_MAX}자까지.`,
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "list_goals의 id" },
        text: {
          type: "string",
          description: "무엇을 했는지·무엇을 확인했는지 한 줄",
        },
        value: { type: "number", description: "목표의 숫자로 잰 값이 있으면" },
        momentum: {
          type: "string",
          enum: [...MOMENTUMS],
          description:
            "지금 흐름: on_track 잘 가고 있음, at_risk 조금 밀림, behind 늦어짐",
        },
        kind: {
          type: "string",
          enum: [...ENTRY_KINDS],
          description: "기본 check_in",
        },
      },
      required: ["goal", "text"],
    },
  },
  {
    name: LIST_GOALS,
    description:
      "이 사람의 진행 중인 목표를 id·제목·달성 기준·마감·최근 흐름과 함께 본다.",
    parameters: { type: "object", properties: {} },
  },
]);

export const isGoalToolName = (name: string): boolean =>
  GOAL_TOOLS.some((tool) => tool.name === name);
