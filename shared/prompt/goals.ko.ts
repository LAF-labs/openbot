/**
 * 목표에 이어진 루틴의 실행이 지시 뒤에 받는 한 문단 (muse-shape plan §3.4, phase 9).
 *
 * 소식의 좋아요 줄(`feed.ko.ts`), 지난번 답(`carriedInstruction`)과 같은 자리다: 사람이 쓴 지시는
 * 그대로 두고, 이 실행이 어느 목표를 점검하는지를 사실로 덧붙인다. 이 실행에는 그 목표 하나에만
 * 적히는 `log_progress`가 있다(`server/src/goals/tools.ts`, `withGoal`).
 *
 * 잴 것이 없는 점검도 한 줄을 남긴다 — 2026-09-27에 잰 것: "토익 800" 목표의 점검 루틴이 지시대로
 * "사장님에게 물어본다"를 하려다 화면 앞에 아무도 없어 아무것도 적지 않았고, 목표 화면에는 점검이
 * 있었다는 흔적조차 없었다. 보고가 없었다는 것도 기록이다.
 */
import { LOG_PROGRESS } from "../tools/goals";

export function goalCheckInText(goal: {
  id: string;
  title: string;
  target: string;
  dueOn?: string | null;
}): string {
  const due = goal.dueOn ? `, 마감 ${goal.dueOn}` : "";
  return [
    `이 루틴은 목표 "${goal.title}"(달성 기준: ${goal.target}${due})의 점검이다. 이 실행에는 이 목표에만 적히는 ${LOG_PROGRESS}가 있다(goal: ${goal.id}).`,
    "잴 수 있는 것은 재서 한 줄로 적는다 — 잰 값은 value에, 지금 흐름은 momentum에(on_track 잘 가고 있음, at_risk 조금 밀림, behind 늦어짐).",
    "화면 앞에 아무도 없으니 묻지 않는다. 잴 것이 없는 목표(이 사람의 보고가 있어야 아는 것)라면 kind note로 '이번 점검: 새 보고 없음'처럼 한 줄을 적고, 알려 주면 좋을 것을 답에 한 줄로 쓴다.",
  ].join(" ");
}
