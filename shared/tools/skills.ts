/**
 * 봇이 스스로 스킬을 찾아 읽는 툴 — 카탈로그 하나.
 *
 * 프롬프트는 받은 스킬의 이름과 한 줄만 보여 준다(`shared/prompt/skill-index.ts`); 본문은 이
 * 툴로 읽는다. 사람이 `/`로 넣은 스킬은 여전히 실행 앞에 그대로 붙고, 이 툴은 그 옆의 두 번째
 * 문이다 — 사람이 이름을 기억하지 못해도 봇이 맞는 것을 찾아 읽는다.
 *
 * 받은 스킬이 하나도 없는 봇에게는 등록되지 않는다. 툴은 하나하나가 매 턴 값을 치르고, 읽을
 * 것이 없는 문을 그려 두는 것은 모델이 없는 문을 두드리게 하는 일이다(CLAUDE.md의 발자국
 * 사다리). 표면(`app/src/lib/copilot/skill-tools.tsx`)과 무인 실행(`runner/unattended.ts`)이
 * 같은 객체를 등록하고, 본문과 감사 행은 서버의 `viewSkill` 한 곳이 답한다.
 */
import type { JsonSchema } from "./standard-schema";

export type SkillTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export const SKILL_VIEW: SkillTool = {
  name: "skill_view",
  description:
    "네가 받은 스킬의 본문을 읽는다. 프롬프트의 스킬 목록에 있는 이름을 그대로 넣는다(앞의 /는 있어도 없어도 된다). " +
    "그 일을 시작하기 전에 한 번 읽고, 읽은 대로 따른다. 사람이 /로 직접 넣은 스킬은 이미 네 앞에 있으니 다시 읽지 않는다.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "스킬 이름. 목록에 적힌 그대로. 예: 재고정리",
      },
    },
    required: ["name"],
  },
};

export const SKILL_TOOLS: readonly SkillTool[] = [SKILL_VIEW];

/** 모델이 넣은 이름을 목록의 slug와 맞춰 본다: 앞의 /, 양끝 공백, 대소문자는 뜻이 아니다. */
export function normalizeSkillName(name: string): string {
  return name.trim().replace(/^\/+/, "").trim().toLowerCase();
}
