/**
 * 툴 결과 안에 들어 있는 지시문 — 이것도 프롬프트다.
 *
 * "A person has control of the computer right now. Do not retry…"는 오류 메시지처럼 생겼지만
 * 오류가 아니라 모델에게 하는 말이고, 실제로 그렇게 쓰였다(에이전트 컴퓨터가 재시도 루프를
 * 끊으려고 문장을 다듬었다). §4 원칙 2가 말하는 대로 서버와 서비스는 **사실 코드**를 보내고,
 * 모델이 읽는 한국어 문장은 여기에 산다. 표면이 사람에게 보여 줄 한국어는 `t()`가 따로 갖는다 —
 * 같은 사실을 두 독자가 다르게 읽어야 하기 때문이다.
 *
 * 코드를 쓰는 곳: `agent-computer/src/control.ts`(제어 보유), `runner/unattended.ts`(예산·종료·
 * 대기), `app/src/lib/copilot/computer-tools.tsx`(대기·비밀값·인계).
 *
 * 아직 코드가 아닌 곳: `agent-computer/src/index.ts:250,276`의 스테일 ref와 예산 문장. 그 파일은
 * 지금 다른 작업이 고치고 있어 건드리지 않았다. 옮길 때 `laf:stale_refs`가 여기 있다.
 */

/** 모델이 읽는 사실 코드. `laf:` 접두사는 영어 문장이 실수로 가질 수 없는 표식이다. */
export const TOOL_RESULT_KO: Record<string, string> = {
  /*
   * 재시도 루프를 이름으로 금지한다. "기다려라"만 두었을 때 추론 모델이 같은 클릭을 다시
   * 누르는 것이 여섯 번 중 한 번 측정됐다(glm-5.3-flash 판정일). 게이트웨이는 어차피 거절하고,
   * 이 문장은 봇이 그 턴을 "못 한다"를 증명하는 데 쓰는 대신 "기다리는 중"이라고 말하게 한다.
   */
  "laf:human_has_control":
    "지금은 사람이 컴퓨터를 잡고 있다. 이 행동을 다시 시도하지 마라 — 같은 거절이 돌아온다. 기다리는 중이라고 말하고, 제어가 돌아왔다는 말을 들은 다음에 다시 행동한다.",

  "laf:stale_refs":
    "페이지가 바뀌어서 지금 들고 있는 ref는 더 이상 맞지 않는다. computer_snapshot을 다시 찍고 새 ref로 하라.",

  "laf:tool_budget_spent":
    "이 실행은 툴 예산을 다 썼다. 지금까지 찾아낸 것으로 답해라.",

  "laf:run_over": "이 실행은 끝났다. 더 실행되는 것은 없다.",

  "laf:nobody_answered":
    "허가해 줄 사람이 지금 없어서 요청이 대기 중이고, 그래서 이 행동은 일어나지 않았다. 무엇을 기다리고 있었는지 말하고 멈춰라. 다른 길로 돌아가지 마라.",

  "laf:person_declined": "사람이 그것을 거절했다.",

  "laf:stopped": "사람이 정지를 눌러 이 실행은 중단됐다.",

  "laf:computer_unreachable": "봇의 컴퓨터에 닿지 못했다.",

  "laf:secret_entered":
    "사람이 그 값을 칸에 직접 입력했다. 값은 페이지로 바로 들어갔고 너는 무엇인지 듣지 못했다. 제출이 필요하면 네가 직접 눌러라.",

  "laf:secret_not_entered":
    "아무도 그 값을 입력하지 않았다. 다른 방법으로 그 값을 묻지 마라.",

  "laf:request_cancelled": "그 요청은 취소됐다.",

  "laf:control_returned":
    "사람이 일을 마치고 제어를 돌려줬다. 사람이 조작하는 동안 페이지가 바뀌었을 수 있으니 computer_snapshot을 새로 찍어라.",

  "laf:nobody_took_control":
    "아무도 제어를 가져가지 않았다. 네가 대신 해 보려 하지 말고, 아직 무엇이 필요한지 말해라.",

  /*
   * 예산 때문에 잘린 앞쪽 툴 결과에 붙는다. 조용히 자르면 모델은 없어진 절반을 "그런 내용이
   * 없었다"로 읽는다 — 코워커 답변을 자를 때 이미 배운 것과 같은 이유로, 잘렸다고 말한다.
   */
  "laf:tool_result_trimmed":
    "[앞부분만 남기고 잘렸다. 지금 필요하면 그 페이지를 다시 열어서 읽어라.]",

  // 자기 자신을 고치는 툴들이 되돌려받는 것. 핸들러 안의 영어 문장을 대신한다.
  "laf:profile_updated":
    "네 프로필을 고쳤다. 이것이 이제부터 네 상시 설정이다.",
  "laf:routine_saved":
    "루틴을 저장했다. 이제부터 혼자 돈다. 사람은 루틴 화면에서 보고 고칠 수 있다.",
  "laf:routine_deleted": "그 루틴을 지웠다.",
  "laf:routine_paused": "그 루틴을 멈췄다.",
  "laf:routine_resumed": "그 루틴을 다시 돌린다.",
  "laf:remembered": "기억했다. 다음 대화에서도 이것을 알고 있다.",
  "laf:profile_no_fields":
    "바꿀 것을 하나도 주지 않아서 아무것도 바뀌지 않았다.",
  "laf:profile_invalid":
    "그 프로필 값은 받아들여지지 않았다. 이름과 직함은 짧게, 설명은 한두 문장으로.",
  "laf:profile_not_found": "그 봇을 찾을 수 없다.",
  "laf:routine_needs_name": "루틴에는 이름이 필요하다.",
  "laf:routine_needs_instruction":
    "루틴이 매번 무엇을 할지 한 줄로 적어야 한다.",
  "laf:routine_needs_schedule":
    "루틴에는 언제 도는지가 필요하다. 사람이 시각이나 주기를 말하지 않았다면 그것은 루틴이 아니라 네 직무이니 update_profile로 적어라.",
  "laf:routine_needs_id": "어떤 루틴인지 id로 말해야 한다.",
  "laf:routine_needs_enabled":
    "멈출지 다시 돌릴지를 enabled로 말해야 한다(false면 멈춤, true면 재개).",
  "laf:routine_unknown_action":
    "루틴에 무엇을 할지 말해라: create, update, delete 중 하나.",
  "laf:routine_not_found": "그 루틴은 더 이상 없다.",
  "laf:routine_cap_reached": "루틴 수가 한도에 닿아 더 만들 수 없다.",
  "laf:routine_incomplete": "봇과 일정을 먼저 정해야 한다.",
  "laf:no_bot_here": "이 대화에는 기억을 맡길 봇이 없다.",
  "laf:memory_empty": "적을 내용이 비어 있다.",
  "laf:memory_too_long": "한 번에 기억하기에는 너무 길다. 한 문장으로 줄여라.",
  /*
   * 비밀은 기억에도 들어가면 안 된다.
   *
   * 프롬프트가 "적지 마라"라고 말하지만 프롬프트는 경계가 아니다. 기억은 매 턴 앞에 다시 서는
   * 글이고, 거기 한 번 들어간 비밀번호는 그 뒤의 모든 대화와 모든 방과 모든 루틴이 읽는다.
   */
  "laf:memory_looks_like_a_secret":
    "그 문장은 비밀번호나 카드번호나 계좌번호처럼 보여서 적지 않았다. 비밀값은 기억하지 않는다 — 필요하면 그때 사람에게 computer_request_secret으로 부탁해라.",
};

/** 코드에 해당하는 모델용 문장. 모르는 코드는 그대로 돌려준다 — 사실은 사실이므로 삼키지 않는다. */
export function toolResultText(code: string): string {
  return TOOL_RESULT_KO[code] ?? code;
}
