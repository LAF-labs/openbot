/**
 * 메인 대화가 프로젝트를 들여다보는 도구 하나 — 다리 뒤에 선다 (기록 §3, 조각 4-4의 첫 부분).
 *
 * 봇은 하나이고 프로젝트마다 컨텍스트가 따로다. 메인 대화의 봇은 프로젝트에서 나눈 말을 모른다.
 * 이 도구가 그것을 읽는 한 길이다: 어떤 프로젝트가 있는지(list), 어디서 무슨 말을 했는지(search —
 * 사람이 앱에서 쓰는 통합검색과 같은 검색), 한 프로젝트가 지금 어디까지 왔는지(summary). 읽기만
 * 한다. 프로젝트에서 무엇을 하게 하는 길은 여기 없다.
 *
 * 발자국 사다리(CLAUDE.md)에서 건너뛴 칸과 그 까닭:
 * - 있는 코드를 넓히기: 검색은 있는 것을 그대로 쓴다(`server/src/search/conversations.ts`). 봇에게
 *   닿는 길이 없었을 뿐이다.
 * - 스킬만: 스킬은 다른 대화의 기록을 읽지 못한다.
 * - 핵심 툴: 필요 없다. 다리가 있으니 이름만 맥락 층에 서고 머리(툴 목록)는 그대로다. 기록은 "메인
 *   대화의 처음부터 늘 있다"고 했다 — 첫 프로젝트와 함께 나타나는 도구는 쌓인 메인 대화 전체를 다시
 *   과금하기 때문이다. 다리 뒤의 이름은 프로젝트가 있든 없든 처음부터 서고, 머리는 한 번도 바뀌지
 *   않는다.
 *
 * 세 가지를 도구 하나로 묶은 것도 기록의 결정이다: 이름 하나가 맥락 층에 서고, 스키마는 한 번
 * 받는다.
 *
 * 프로젝트의 대화에는 서지 않는다. 프로젝트는 자기 기록을 이미 들고 있고, 다른 프로젝트를 읽는 것은
 * 메인만 한다.
 */
import { toolResultText } from "../prompt/tool-results.ko";
import { DEFERRED_TOOL_PREFIX } from "./bridge";
import type { JsonSchema } from "./standard-schema";

/** 이 도구가 선 무리의 키. `mcp__projects__read`의 `projects`. */
export const PROJECTS_FAMILY = "projects";

export const READ_PROJECTS = `${DEFERRED_TOOL_PREFIX}${PROJECTS_FAMILY}__read`;

export const PROJECT_READ_KINDS = ["list", "search", "summary"] as const;
export type ProjectReadKind = (typeof PROJECT_READ_KINDS)[number];

export const isProjectReadKind = (value: unknown): value is ProjectReadKind =>
  typeof value === "string" &&
  (PROJECT_READ_KINDS as readonly string[]).includes(value);

/** 검색 한 번이 돌려주는 줄 수. 사람의 화면은 서른 줄이고, 봇이 읽는 것은 매 턴 다시 읽힌다. */
export const PROJECT_SEARCH_HITS = 10;

export type ProjectTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export const PROJECT_TOOLS: readonly ProjectTool[] = Object.freeze([
  {
    name: READ_PROJECTS,
    description:
      "이 사람의 프로젝트(따로 나눈 대화)를 읽는다. 이 대화에서 나누지 않은 일을 물을 때 쓴다. 프로젝트 이름을 들었으면 kind summary에 그 이름을 project로 넣어 바로 읽는다 — 그 프로젝트가 어디까지 왔는지가 오고, 이름이 달라도 있는 프로젝트의 목록이 함께 온다. 어느 프로젝트인지 모르면 kind search로 낱말 하나를 찾는다: 이 대화의 지난 말과 모든 프로젝트에서 그 낱말이 나온 곳이 온다. kind list는 프로젝트 목록이다. 읽기만 한다 — 프로젝트에서 일을 시키지는 못한다.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: [...PROJECT_READ_KINDS],
          description:
            "list 프로젝트 목록, search 말 찾기, summary 한 프로젝트 요약",
        },
        terms: {
          type: "string",
          description:
            "search에서 찾을 낱말. 하나만 넣는 것이 가장 잘 찾는다 — 여럿을 띄어 쓰면 한 메시지에 모두 들어 있어야 한다",
        },
        project: {
          type: "string",
          description:
            "summary에서 읽을 프로젝트: 이 사람이 말한 프로젝트 이름, 또는 list나 search가 준 id",
        },
        cursor: {
          type: "string",
          description: "search의 다음 쪽: 앞 결과의 next를 그대로",
        },
      },
      required: ["kind"],
    },
  },
]);

export const isProjectToolName = (name: string): boolean =>
  name === READ_PROJECTS;

/**
 * 도구 결과에 적어 두는 표시: 이 결과가 어느 프로젝트의 내용을 옮겨 왔는지 (기록 §3 "메인에 옮겨진
 * 프로젝트 내용").
 *
 * 이 도구의 결과는 메인 대화의 메시지로 저장된다. 프로젝트를 지워도 그 사본은 메인에 남고, 그 뒤의
 * 모든 요청에 실린다. 그래서 결과마다 읽은 프로젝트를 적어 두고, 그 가운데 하나라도 없어졌으면
 * 본문을 정해진 문장으로 바꾼다 — 저장하는 곳에서(`server/src/runner/thread-store.ts`), 그리고
 * 프로젝트를 지울 때 이미 저장된 것에(`server/src/channels/deleting.ts`). 호출과 결과의 짝은 그대로
 * 남으므로 공급자가 받는 기록은 여전히 맞다.
 *
 * 저장소의 것이다. 봇에게 건네는 메시지에서는 뗀다(`turns/engine.ts` `forTheBot`).
 */
export type ProjectsMark = { lafProjects?: string[] };

/** 메시지에 적힌 프로젝트들. 표시가 없거나 모양이 다르면 빈 목록. */
export function projectsReadBy(message: unknown): string[] {
  if (message === null || typeof message !== "object") return [];
  const marked = (message as ProjectsMark).lafProjects;
  if (!Array.isArray(marked)) return [];
  return marked.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

/** 지운 프로젝트에서 온 결과가 서는 자리의 코드. */
export const PROJECT_CONTENT_REMOVED = "laf:project_content_removed";

/**
 * 지운 프로젝트의 내용이 있던 결과의 본문 — 저장하는 곳과 지우는 곳이 글자 하나까지 같은 것을 쓴다.
 *
 * 거절의 모양이 아니다. 그 호출은 그때 됐고, 봇은 그 결과로 답을 했다: `ok: false`로 두면 봇은
 * 지나간 제 답을 실패한 호출 위에 선 것으로 읽는다(위 문장의 주석). 됐던 호출이고, 내용만 없다.
 */
export const REMOVED_PROJECT_RESULT = JSON.stringify({
  ok: true,
  removed: true,
  note: toolResultText(PROJECT_CONTENT_REMOVED),
});
