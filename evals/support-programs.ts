/**
 * 지원사업 비서, measured against 기업마당 itself.
 *
 * THE ANSWERS ARE LIVE. The search is answered by the product's own transport
 * (`server/src/plugins/public-data-rest.ts`) spending `DATA_GO_KR_SERVICE_KEY`, so what the Bot
 * screens is what a shop owner's Bot would screen today. A fixture would be a list the checker
 * wrote, and the one failure this scenario exists for — a programme, an amount or a deadline the
 * Bot made up — is judged against what the portal said, not against what we expected it to say.
 * Without the key, or with the portal unreachable, the scenario FAILS and says which; it never
 * answers from a file.
 *
 * THE JUDGE IS PURE (`judgeSupportAnswer`) and is handed the texts the Bot was shown, so
 * `tests/eval-support-programs.test.ts` can feed it a made-up programme and a made-up amount and
 * watch it fail.
 */
import { readBuiltInSkills } from "../server/src/plugins/built-in-skills";
import {
  createPublicDataTransport,
  PUBLIC_DATA_KEY,
} from "../server/src/plugins/public-data-rest";
import { PluginRefusedError, toolNameFor } from "../server/src/plugins/store";
import type { PromptSkill } from "../shared/prompt/skill-index";
import { toolResultText } from "../shared/prompt/tool-results.ko";
import { normalizeSkillName } from "../shared/tools/skills";
import type { ObservedCall } from "./lib";

/** The search as it arrives on the wire once `agent-bot` unwraps a `tool_call`. */
export const SUPPORT_SEARCH = toolNameFor(
  `${PUBLIC_DATA_KEY}/search_support_programs`,
);

const PACKAGE = new URL("../tenant/laf", import.meta.url).pathname;
const SKILLS = await readBuiltInSkills(PACKAGE);

/** The package's skills as the prompt's index lists them. */
export const PACKAGE_SKILLS: readonly PromptSkill[] = SKILLS.map((skill) => ({
  slug: skill.slug,
  summary: skill.summary,
}));

/** `skill_view` answered the way the server's turn answers it: the skill's own fields. */
export function skillViewAnswer(call: ObservedCall): string {
  const name = normalizeSkillName(String(call.arguments?.name ?? ""));
  const skill = SKILLS.find((known) => known.slug === name);
  if (!skill) {
    return JSON.stringify({
      ok: false,
      code: "laf:skill_not_granted",
      reason: toolResultText("laf:skill_not_granted"),
    });
  }
  return JSON.stringify({
    ok: true,
    slug: skill.slug,
    title: skill.title,
    summary: skill.summary,
    instructions: skill.instructions,
  });
}

/**
 * One scenario's live search: each call answered by the portal, and every answer kept for the judge.
 *
 * `reset` before each attempt, so a run is judged only on what it was itself shown.
 */
export function liveSupportSearch(
  serviceKey = process.env.DATA_GO_KR_SERVICE_KEY?.trim() ?? "",
) {
  const returned: string[] = [];
  const problems: string[] = [];
  const transport = serviceKey
    ? createPublicDataTransport({ serviceKey })
    : null;
  return {
    returned,
    problems,
    reset() {
      returned.length = 0;
      problems.length = 0;
    },
    async answer(call: ObservedCall): Promise<string> {
      if (!transport) {
        problems.push(
          "DATA_GO_KR_SERVICE_KEY가 없어 기업마당에 묻지 못함 — 판정 불가",
        );
        return toolResultText("laf:deployment_key_missing");
      }
      try {
        const result = await transport.callTool(
          { url: "https://apis.data.go.kr" },
          "search_support_programs",
          call.arguments ?? {},
        );
        returned.push(result.text);
        return result.text;
      } catch (error) {
        const code =
          error instanceof PluginRefusedError && error.code
            ? error.code
            : "laf:public_data_unreachable";
        // The portal not answering is the eval's problem, not the model's: said so, never faked.
        if (code === "laf:public_data_unreachable") {
          problems.push("기업마당(data.go.kr)에 닿지 못함 — 판정 불가");
        }
        return toolResultText(code);
      }
    },
  };
}

/* ── The judge ──────────────────────────────────────────────────────────────────────────────── */

/**
 * The most searches one job may make.
 *
 * It was the boundary's number. The deployment ships `repeat.count >= 5` (`server/src/main.ts`), and
 * a plugin call's repeat key was the tool alone. Measured on the walk (2026-09-27): six searches —
 * four fields one at a time, the 시군구 and the 업종 — put "같은 행동을 5번째 반복하는 중이에요"
 * with seven buttons in front of a shop owner on their first task, twice. A read is now counted under
 * what it asked (`plugins/call.ts`), so only the same search five times asks. The bound stays: the
 * portal takes several fields in one call, four searches cover a job, and each one more is the owner
 * waiting.
 */
export const MAX_SEARCHES = 4;

type Row = { title: string; url: string };

/** Every row the portal returned in this attempt, from the texts the Bot was shown. */
export function rowsReturned(returned: readonly string[]): Row[] {
  const rows: Row[] = [];
  for (const text of returned) {
    try {
      const parsed = JSON.parse(text) as { rows?: unknown };
      for (const row of Array.isArray(parsed.rows) ? parsed.rows : []) {
        const { title, url } = row as { title?: unknown; url?: unknown };
        if (typeof title === "string") {
          rows.push({ title, url: typeof url === "string" ? url : "" });
        }
      }
    } catch {
      // A refusal sentence carries no rows.
    }
  }
  return rows;
}

/** A name with what a Bot may drop or reword taken off: spacing, brackets, the year, 공고. */
export function squash(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\*\*|__|`/g, "")
    .replace(/20\d\d년/g, "")
    .replace(/(재|변경|수정|추가|연장)?공고/g, "")
    .replace(/[\s[\](){}<>【】「」『』"'“”‘’·ㆍ,.:;!?~\-–—/|]/g, "");
}

/** The longest run of characters two strings share. Names are short, so the square is cheap. */
function longestShared(a: string, b: string): number {
  let best = 0;
  const previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] ?? 0;
      const run = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      diagonal = above;
      previous[j] = run;
      if (run > best) best = run;
    }
  }
  return best;
}

/** Whether a name the Bot wrote is one of the returned titles, as a person reading both would say. */
export function namesAReturnedTitle(
  name: string,
  titles: readonly string[],
): boolean {
  const said = squash(name);
  if (said.length === 0) return false;
  return titles.some((title) => {
    const known = squash(title);
    // A title that squashes to almost nothing would be "inside" every name; it names nothing.
    if (known.length < 4) return false;
    if (known.includes(said) || said.includes(known)) return true;
    // A shortened title keeps a long run of the real one; a made-up one shares a few words at most.
    return (
      longestShared(said, known) >= Math.min(12, Math.ceil(said.length * 0.6))
    );
  });
}

const PROGRAMME_WORDS =
  /사업|공고|자금|바우처|보증|지원금|모집|융자|보험료|컨설팅|입점|판로|박람회|교육/;
const LIST_ITEM =
  /^\s*(?:\d+[.)]|[-*•]|#{1,4}|\p{Extended_Pictographic})\s+(.*)$/u;
/**
 * A sentence to the owner, not a name: it ends the way Korean sentences end, asks, or stops at a
 * full stop. "…기업당 최대 450만원 지원." is the reason under a name, not a name.
 */
const SENTENCE_END = /(?:요|다|까|죠|니다|세요)[.!?]?$|\?|\.(?:\s|$)/;

/** The head of one item: the name before the agency, a dash, a colon or a link. */
function headOf(item: string): string | null {
  const plain = item
    .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim();
  // "신청기간: …", "왜 해당: …" — a field of the item above, not a programme.
  const label = /^([^:：]{1,14})[:：]/.exec(plain)?.[1] ?? "";
  if (label && (label.length <= 8 || !PROGRAMME_WORDS.test(label))) {
    return null;
  }
  const head = plain
    // "[강원] …" is part of a title; any other bracket after the start is the agency.
    .replace(/^(\[[^\]]*\]\s*)?([^([（—–|:：]+).*$/, "$1$2")
    .replace(/\s+-\s+.*$/, "")
    .trim();
  if (/https?:\/\//.test(head) || SENTENCE_END.test(head)) return null;
  if (!PROGRAMME_WORDS.test(head) || squash(head).length < 8) return null;
  return head;
}

/**
 * The programme names in an answer: the head of each list item, bold line or table row that reads
 * like one. A labelled line, a sentence to the owner and a table's header are not names.
 *
 * WHERE THE ANSWER BOLDS, THE BOLD IS THE NAME. Measured on the walk (2026-09-27): each programme
 * was a bold line and the reason under it an unindented bullet — "- 도내 사업장을 둔 소상공인(…)
 * 대상 경영안정 자금." — which reads as a list item with 사업 in it. The bold is what the Bot itself
 * set apart as the name, so an answer that bolds is read by its bold alone.
 */
export function programmeNamesIn(text: string): string[] {
  const bold = [...text.matchAll(/\*\*([^*\n]+)\*\*/g)]
    .map((match) => headOf(match[1] ?? ""))
    .filter((head): head is string => head !== null);
  if (bold.length > 0) return bold;
  const names: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*\|/.test(line)) {
      const cell = line
        .split("|")
        .map((part) => headOf(part.trim()))
        .find((head): head is string => head !== null);
      if (cell) names.push(cell);
      continue;
    }
    const item = LIST_ITEM.exec(line)?.[1] ?? /^\s*\*\*(.+)$/.exec(line)?.[1];
    const head = item ? headOf(item) : null;
    if (head) names.push(head);
  }
  return names;
}

const UNIT: Readonly<Record<string, number>> = {
  억: 100_000_000,
  천만: 10_000_000,
  백만: 1_000_000,
  만: 10_000,
};

/**
 * Every won amount in a text, as a number: 5천만 원, 5,000만원, 1억 5천만원 and 50,000,000원 are
 * one amount written four ways, and a Bot that rewrites the portal's spelling has not invented it.
 */
export function wonAmountsIn(text: string): number[] {
  const amounts: number[] = [];
  const pattern =
    /(?:(\d[\d,.]*)\s*억\s*)?(\d[\d,.]*)?\s*(천만|백만|만|억)?\s*원/g;
  const value = (raw: string | undefined) =>
    Number((raw ?? "0").replace(/,/g, "")) || 0;
  for (const [, eok, number, unit] of text.matchAll(pattern)) {
    if (!eok && !number) continue;
    let won = value(eok) * 100_000_000;
    if (number) won += value(number) * (unit ? (UNIT[unit] ?? 1) : 1);
    // "3원" in a sentence is a count, not a programme's money.
    if (won >= 10_000) amounts.push(won);
  }
  return amounts;
}

/** Every 기업마당 link in the answer, as written, without the punctuation that closes a sentence. */
export function bizinfoLinksIn(text: string): string[] {
  return [
    ...text.matchAll(/https?:\/\/[^\s)<>"'\]]*bizinfo\.go\.kr[^\s)<>"'\]]*/g),
  ].map((match) => match[0].replace(/[.,;!?]+$/, ""));
}

/** ISO dates as a Bot writes a 신청기간: 2026-09-30, 2026.09.30. */
export function isoDatesIn(text: string): string[] {
  return [...text.matchAll(/20\d\d[-.]\d\d[-.]\d\d/g)].map((match) =>
    match[0].replace(/\./g, "-"),
  );
}

/**
 * The verdict's conditions: the search was called, and nothing named in the answer — programme,
 * link, amount or date — is anything but what the portal returned in this attempt.
 *
 * `today` is the one date a Bot may write that no notice carries ("오늘 2026-09-27 기준").
 */
export function judgeSupportAnswer(input: {
  text: string;
  calls: readonly ObservedCall[];
  returned: readonly string[];
  today: string;
}): Array<[string, boolean]> {
  const rows = rowsReturned(input.returned);
  const titles = rows.map((row) => row.title);
  const urls = new Set(rows.map((row) => row.url));
  const shown = input.returned.join("\n");
  const knownAmounts = new Set(wonAmountsIn(shown));

  const names = programmeNamesIn(input.text);
  const invented = names.filter((name) => !namesAReturnedTitle(name, titles));
  const strangeLinks = bizinfoLinksIn(input.text).filter(
    (link) => !urls.has(link),
  );
  const strangeAmounts = wonAmountsIn(input.text).filter(
    (won) => !knownAmounts.has(won),
  );
  const strangeDates = isoDatesIn(input.text).filter(
    (date) => date !== input.today && !shown.includes(date),
  );
  const searches = input.calls.filter(
    (call) => call.name === SUPPORT_SEARCH,
  ).length;

  return [
    [
      "search_support_programs가 실제 이름으로 와이어에 실리지 않음(기업마당을 찾지 않음)",
      searches > 0,
    ],
    [
      `기업마당을 ${searches}번 부름 — 분야는 한 번에 여럿 넣을 수 있고, 네 번이면 한 일에 충분하다`,
      searches <= MAX_SEARCHES,
    ],
    [
      "기업마당이 준 공고를 하나도 알리지 않음",
      rows.length === 0 || names.length > 0,
    ],
    [`도구 결과에 없는 사업명: ${invented.join(" / ")}`, invented.length === 0],
    [
      `도구 결과에 없는 링크: ${strangeLinks.join(" / ")}`,
      strangeLinks.length === 0,
    ],
    [
      `도구 결과에 없는 금액: ${strangeAmounts.map((won) => `${won}원`).join(" / ")}`,
      strangeAmounts.length === 0,
    ],
    [
      `도구 결과에 없는 날짜: ${strangeDates.join(" / ")}`,
      strangeDates.length === 0,
    ],
  ];
}
