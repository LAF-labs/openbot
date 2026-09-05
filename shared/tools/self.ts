/**
 * 봇이 자기 자신에게 쓰는 세 가지 — 카탈로그 하나.
 *
 * `update_state` 하나가 옵션 아홉 개와 모드 enum 하나를 들고 프로필과 루틴을 겸했다. 유효성
 * 규칙은 핸들러 안에 영어 문장으로 있었고, 설명 산문은 1,500자였다. 그 산문은 2026-09-01 오후
 * 평가 세 번(FAIL → FAIL → PASS) 사이에 다듬어져 같은 커밋에 들어갔다 — n=3으로는 90%와 99%를
 * 가를 수 없으므로, 그 문장들이 무엇을 고쳤는지는 사실 아무도 모른다.
 *
 * 그래서 둘로 가른다. 경계는 산문이 아니라 **툴 이름**이 긋는다: 프로필은 프로필 툴이, 루틴은
 * 루틴 툴이. 남는 산문은 툴마다 한두 문장이고, 그중 한 문장은 실제로 터졌던 실패를 막는다 —
 * "영수증 정리를 맡아줘"(맡겨진 일 = 직무)가 `remember`로 새는 것.
 *
 * 유효성은 서버가 코드로 검사하고 `laf:` 사실 코드로 답한다. 핸들러 안의 영어 문장은 없다.
 *
 * `manage_routine`의 스키마가 `oneOf`가 아닌 이유: 판별자(`action`)는 있지만 가지는 평평하게
 * 폈다. 여러 공급자가 중첩된 `oneOf`에서 인자 조립을 틀리고, 어차피 무엇이 빠졌는지는 서버가
 * 사실 코드로 답한다. 판별은 모델을 위한 것이고 검증은 서버의 것이다.
 */
import type { JsonSchema } from "./standard-schema";

export type SelfTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): JsonSchema => ({ type: "object", properties, required });

export const UPDATE_PROFILE: SelfTool = {
  name: "update_profile",
  description:
    "네가 **무엇인지**를 바꾼다: 네 이름, 직함, 무엇을 하는 봇인지, 얼마나 깊이 생각하는지. " +
    "'앞으로 X를 맡아줘', '이제부터 네가 X를 해' 처럼 너에게 맡겨진 일은 네 직무이므로, 기억할 것처럼 들려도 여기다. " +
    "바뀌는 것만 보낸다. 이것은 너를 고치고 다른 누구도 고치지 않는다.",
  parameters: object({
    name: { type: "string", description: "네 새 이름" },
    title: {
      type: "string",
      description: "짧은 역할 이름. 예: '재무 운영'",
    },
    description: {
      type: "string",
      description: "네가 무엇을 하는 봇인지 한두 문장. 상시 직무로 쓴다",
    },
    effort: {
      type: "string",
      enum: ["quick", "balanced", "thorough"],
      description:
        "답하기 전에 얼마나 깊이 생각할지. 일이 꼼꼼해야 하면 올리고, 깊이보다 속도가 중요하면 내린다",
    },
  }),
};

export const MANAGE_ROUTINE: SelfTool = {
  name: "manage_routine",
  description:
    "일정에 맞춰 저절로 도는 일을 만들고, 멈추거나 다시 돌리고, 지운다. " +
    "사람이 실제로 시각이나 요일이나 주기를 말했을 때만 쓴다 — 시간이 붙지 않은 일은 루틴이 아니라 네 직무이므로 update_profile로 간다. " +
    "이름이나 지시를 바꾸려면 지우고 새로 만든다.",
  parameters: object(
    {
      action: {
        type: "string",
        enum: ["create", "update", "delete"],
        description:
          "create: 새 루틴을 만든다(name, instruction, schedule 필요). update: 잠시 멈추거나 다시 돌린다(routineId와 enabled 필요). delete: 지운다(routineId 필요).",
      },
      routineId: {
        type: "string",
        description: "고치거나 지울 루틴의 id. update와 delete에 필요",
      },
      name: { type: "string", description: "루틴 이름. create에 필요" },
      instruction: {
        type: "string",
        description:
          "그 시각마다 무엇을 할지, 미래의 너에게 쓰듯이. create에 필요",
      },
      enabled: {
        type: "boolean",
        description: "update일 때: true면 다시 돌리고 false면 멈춘다",
      },
      schedule: {
        type: "object",
        description: "언제 도는지. create에 필요",
        properties: {
          kind: { type: "string", enum: ["daily", "interval"] },
          time: {
            type: "string",
            description: "벽시계 기준 HH:MM. daily일 때",
          },
          timeZone: {
            type: "string",
            description: "그 시각이 쓰인 IANA 시간대. 예: Asia/Seoul",
          },
          days: {
            type: "array",
            items: { type: "number" },
            description: "도는 요일. 0이 일요일. 비우면 매일",
          },
          minutes: {
            type: "number",
            description: "몇 분마다. interval일 때",
          },
        },
        required: ["kind"],
      },
    },
    ["action"],
  ),
};

export const REMEMBER: SelfTool = {
  name: "remember",
  description:
    "이 사람에 대해 오래 참인 사실 **하나**를 적어 둔다. 다음 대화에서도 알고 있으려고 쓴다. " +
    "가게가 어떻게 돌아가는지, 영업시간, 누구와 거래하는지, 일하는 방식에 대한 취향 같은 것. 한 번에 하나, 네 말로. " +
    "너에게 맡겨진 일은 여기가 아니다 — '앞으로 X를 맡아줘'는 네 직무가 바뀐 것이고 update_profile로 간다. " +
    // 실측: 직무를 update_profile에 쓰고 나서 같은 사실을 여기에 한 번 더 적는 턴이 3분의 1.
    "직무를 update_profile에 적었다면 같은 내용을 여기에 또 적지 마라. 한 번이면 된다. " +
    // 서버가 지시문 모양을 거절한다(laf:memory_looks_like_instruction). 어떻게 쓰면 통과하는지 한 줄.
    "지시가 아니라 사실로 적는다: '항상 존댓말을 써라'가 아니라 '사장님은 존댓말을 선호한다'. " +
    "비밀번호, 카드번호, 로그인 칸에 입력된 값은 적지 않는다.",
  parameters: object(
    {
      fact: {
        type: "string",
        description: "기억할 한 가지를, 미래의 너에게 쓰는 짧은 문장으로",
      },
    },
    ["fact"],
  ),
};

export const SELF_TOOLS: readonly SelfTool[] = [
  UPDATE_PROFILE,
  MANAGE_ROUTINE,
  REMEMBER,
];
