/**
 * The four templates LAF registers under every channel it connects, written once.
 *
 * WHY LAF WRITES THEM AND NOT THE PERSON. An 알림톡 template is inspected by 카카오 before it can be
 * sent, which takes days and refuses anything that reads as advertising. A shop owner who had to
 * compose one would be waiting on an inspection they cannot interpret, for words this product could
 * have got right once for everybody. So these four are the product's, registered under each person's
 * 발신프로필 as they connect, and what varies between businesses travels as variables.
 *
 * THE TEXT IS THE CONTRACT. What is registered is what may be sent: 카카오 compares the message
 * against the approved body, and a single character that is not a variable makes the send fail. So
 * these strings are not copy to be tidied — changing one means a new inspection under every channel
 * that has already registered it, and the code stays the same while the words do not, which is why
 * `alimtalk_templates` reports a status per person rather than a fleet-wide yes.
 *
 * TWO AUDIENCES, AND THE BOUNDARY CARES WHICH. `owner` templates go to the person who owns this
 * deployment — the approval buzz, the "it is done" — and the outbox sends those without asking,
 * because telling somebody their own Bot is waiting is the notification, not an action. `customer`
 * templates leave the business and reach somebody else's phone; a Bot sending one goes through the
 * boundary as an external effect, every time.
 */

export type TemplateAudience = "owner" | "customer";

export type StandardTemplate = {
  /** LAF's own name for it. What a row, a tool argument and a policy rule all say. */
  code: string;
  /** What the vendor lists it as under the person's channel. */
  name: string;
  audience: TemplateAudience;
  /** The approved body, variables included. */
  content: string;
  /** Every `#{…}` the body carries, in the order they appear. Derived, never written twice. */
  variables: readonly string[];
};

/** Every `#{…}` in a template body, in order and without repeats. */
export function variablesOf(content: string): string[] {
  const found = content.match(/#\{[^}]+\}/g) ?? [];
  return [...new Set(found)];
}

function template(
  code: string,
  name: string,
  audience: TemplateAudience,
  content: string,
): StandardTemplate {
  return { code, name, audience, content, variables: variablesOf(content) };
}

export const STANDARD_TEMPLATES: readonly StandardTemplate[] = Object.freeze([
  /*
   * The one §5.7 is about: "봇 ○○이 승인을 기다립니다" on the phone in the owner's hand, at two in
   * the morning, when nobody is looking at the app. Its variables are deliberately two — what is
   * being asked and when — because everything else a card would show needs the app anyway.
   */
  template(
    "laf_approval",
    "LAF 승인 요청",
    "owner",
    "[LAF]\n봇이 승인을 기다리고 있습니다.\n\n내용: #{내용}\n요청 시각: #{시각}\n\n앱에서 확인해 주세요.",
  ),
  template(
    "laf_done",
    "LAF 작업 완료",
    "owner",
    "[LAF]\n봇이 맡은 일을 마쳤습니다.\n\n내용: #{내용}\n완료 시각: #{시각}",
  ),
  /*
   * The two that leave the business. `#{상호}` rather than a fixed shop name: the template is
   * inspected once per channel and the same approved body then serves whatever the shop is called,
   * including the day it is renamed.
   */
  template(
    "laf_reservation",
    "LAF 예약 확정 안내",
    "customer",
    "[#{상호}]\n예약이 확정되었습니다.\n\n예약자: #{고객명}\n일시: #{일시}\n인원: #{인원}\n\n변경이나 취소는 매장으로 연락해 주세요.",
  ),
  template(
    "laf_review",
    "LAF 이용 후기 요청",
    "customer",
    "[#{상호}]\n#{고객명}님, 오늘 이용해 주셔서 감사합니다.\n\n잠시 시간이 되신다면 이용 후기를 남겨 주세요.\n#{링크}",
  ),
]);

export function standardTemplate(code: string): StandardTemplate | null {
  return STANDARD_TEMPLATES.find((entry) => entry.code === code) ?? null;
}

/**
 * The variables this send is missing, or an empty list when it carries them all.
 *
 * Checked here rather than left to the vendor. A missing variable comes back from 카카오 as a
 * template mismatch — a sentence about the body not matching the approved one — which tells the
 * person nothing about the field a model forgot to fill in.
 *
 * Extra keys are dropped rather than refused: a model that adds `#{안내}` to a template that has no
 * such variable has made a harmless mistake, and refusing the send over it would stop a message that
 * is otherwise exactly right.
 */
export function missingVariables(
  entry: StandardTemplate,
  supplied: Record<string, string>,
): string[] {
  return entry.variables.filter((name) => !supplied[name]?.trim());
}

/**
 * A Bot's arguments, keyed the way the vendor expects.
 *
 * A model is asked for `{"내용": "…"}` rather than `{"#{내용}": "…"}`, because a tool schema full of
 * `#{}` is one a model fills in wrongly half the time. Both spellings are accepted on the way in and
 * only one goes out.
 */
export function withVariableBraces(
  supplied: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (value === null || value === undefined) continue;
    const name = key.startsWith("#{") ? key : `#{${key}}`;
    out[name] = String(value);
  }
  return out;
}
