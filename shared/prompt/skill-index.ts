/**
 * 봇이 받은 스킬의 목차 — 프롬프트의 문맥 층에 들어가는 부분.
 *
 * 2026-09까지 스킬은 사람이 `/`로 골라 넣을 때만 봇에게 닿았고, 봇은 스킬이라는 것이 있는지도
 * 몰랐다. "재고 좀 정리해 줘"에 딱 맞는 스킬이 있어도 사람이 그 이름을 기억해 `/`를 쳐야 했다.
 * 여기서는 이름과 한 줄 설명만 보여 주고, 본문은 봇이 필요할 때 `skill_view`로 읽는다 — 본문을
 * 다 실으면 스킬 열 개가 프롬프트 만 토큰이 되고, 그 값을 매 턴 치른다(Hermes의 스킬 목차와
 * 같은 모양이다).
 *
 * 상한은 토큰이다. 정확한 토크나이저는 모델마다 다르므로 보수적으로 어림한다: 한글·한자 같은
 * 비ASCII 글자는 한 자에 한 토큰, ASCII는 넉 자에 한 토큰. 실제보다 많게 세므로 상한을 넘기는
 * 쪽으로 틀리지는 않는다.
 */

export type PromptSkill = {
  /** 사람이 `/` 뒤에 치는 이름. 배포 안에서 유일하다. */
  slug: string;
  /** 카탈로그와 `/` 메뉴에 뜨는 한 줄. */
  summary: string;
};

/** 목차 전체의 상한. 이보다 길면 뒤쪽 스킬은 개수만 말하고 이름은 skill_view에 맡긴다. */
export const SKILL_INDEX_MAX_TOKENS = 1_400;

/** 한 줄 설명의 길이. 요약은 한 줄이 원칙이지만 사람이 문단을 붙여 넣기도 한다. */
const SUMMARY_MAX_CHARS = 80;

/** 잘림 표시 한 줄이 들어갈 자리. 마지막 항목을 넣고 나서 표시할 자리가 없으면 안 된다. */
const TAIL_RESERVE_TOKENS = 24;

const HEADING =
  "네가 받은 스킬들. 이름과 한 줄 설명만 있다. 맞는 일이 오면 skill_view로 본문을 먼저 읽고, 읽은 대로 따른다:";

/** 보수적인 토큰 어림. 비ASCII 한 자 = 1, ASCII 넉 자 = 1. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 128) ascii += 1;
    else other += 1;
  }
  return other + Math.ceil(ascii / 4);
}

function oneLine(summary: string): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX_CHARS
    ? `${flat.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : flat;
}

/**
 * 목차 본문. 스킬이 없으면 빈 문자열 — 조립기가 빈 문단을 떨어뜨린다.
 *
 * 순서는 받은 그대로다. 앞에서부터 상한까지 넣고, 넘치는 것은 개수만 말한다: 봇이 이름을
 * 하나도 못 본 스킬은 없는 것과 같으므로, 있다는 사실이라도 남긴다.
 */
export function skillIndexText(skills: readonly PromptSkill[]): string {
  const entries = skills
    .filter((skill) => skill.slug.trim().length > 0)
    .map(
      (skill) =>
        `- /${skill.slug.trim()} — ${oneLine(skill.summary) || "(설명 없음)"}`,
    );
  if (entries.length === 0) return "";

  const lines = [HEADING];
  let spent = estimateTokens(HEADING);
  let shown = 0;
  for (const entry of entries) {
    // 줄바꿈 한 토큰까지 센다.
    const cost = estimateTokens(entry) + 1;
    if (spent + cost + TAIL_RESERVE_TOKENS > SKILL_INDEX_MAX_TOKENS) break;
    lines.push(entry);
    spent += cost;
    shown += 1;
  }
  const left = entries.length - shown;
  if (left > 0) {
    lines.push(`- …외 ${left}개. 이름을 알면 skill_view로 바로 읽을 수 있다.`);
  }
  return lines.join("\n");
}
