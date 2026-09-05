/**
 * The boundary a deployment gets before anybody writes one.
 *
 * WHAT WAS HERE BEFORE WAS `allow: ["true"]` AND NOTHING ELSE, and the README's promise — that a Bot
 * takes the wheel to a person when it reaches something it should not do alone — was true only after
 * an administrator had opened the Boundaries page and written a rule. Nobody writes that rule before
 * the first time it was needed. The other side is the same failure: a Bot that can look at a page and
 * touch nothing is not a product either, so this stays permissive and names the few things worth
 * stopping for, rather than starting from "nothing is allowed".
 *
 * It is also the shape of the risk this product is for. The MCP path has asked about money, external
 * effects and destruction since it existed (`plugins/store.ts`), so writing a page in Notion stopped
 * to ask while pressing 송금 in a bank's browser did not — and the second is where a small business
 * loses money.
 *
 * THE DEPLOYMENT EDITS THE SAVED POLICY, NOT THIS FILE. What is here is what a deployment starts
 * with; `/admin/boundaries` writes over it, the saved policy wins from then on, and `reset` on the
 * store is what comes back to this. Editing this file changes what a NEW deployment gets and nothing
 * about one that is already running. The two lists below are exported as data for exactly that
 * reason: a deployment that wants another bank or another word adds it on that page.
 *
 * The rules are CEL, in the same language an administrator writes in, and generated from the lists so
 * that the rule a person reads on the Boundaries page is the rule that ran.
 */
import type { ActionPolicy, PolicyContext } from "./policy";

/**
 * Words that make a button worth a question, in the two languages this product is used in.
 *
 * Matched as a case-insensitive substring of the element's accessible name — the label a person
 * reads, resolved by the server from its own snapshot, never from anything the model claimed it was
 * clicking. Substrings on purpose: "결제하기", "즉시 결제" and "카드 결제" are all 결제, and a list of
 * whole labels would be a list of one shop's spellings.
 *
 * It over-asks, and that is the direction chosen. "주문 내역" is not an order being placed and will
 * stop to ask anyway; the cost is one press of Allow, and the cost the other way is an order nobody
 * saw. A deployment that finds a particular word tiresome removes it on the Boundaries page.
 */
export const MONEY_WORDS: readonly string[] = [
  // 돈이 나가는 것
  "결제",
  "송금",
  "이체",
  "출금",
  "구매",
  "주문",
  // 되돌릴 수 없는 것
  "삭제",
  "탈퇴",
  // 남에게 나가는 것
  "전송",
  "보내기",
  "발송",
  "발행",
  // 사람이 서는 자리
  "승인",
  "확정",
  "pay",
  "send",
  "delete",
  "confirm",
  "submit order",
  "transfer",
  "checkout",
];

/**
 * Where pressing anything at all is worth a question.
 *
 * Banks, payment providers, the tax office and the two seller portals a Korean small business
 * actually settles through. On these, the label is not enough to judge by: a bank's confirm button
 * is often "확인" and its transfer button is often an icon, so the site itself is the signal.
 *
 * Written as a host and every subdomain of it. `pay.naver.com` therefore covers pay.naver.com and
 * nothing else under naver.com, which is the point — asking before every click on a portal site
 * would train somebody to press Allow without reading.
 */
export const MONEY_HOSTS: readonly string[] = [
  // 은행
  "kbstar.com",
  "shinhan.com",
  "wooribank.com",
  "hanabank.com",
  "nonghyup.com",
  "ibk.co.kr",
  "kakaobank.com",
  "tossbank.com",
  // 결제·송금
  "toss.im",
  "kakaopay.com",
  "naverpay.com",
  "pay.naver.com",
  // 세금
  "hometax.go.kr",
  // 정산이 일어나는 사장님용 포털. 장사하는 쪽 주소이고, 손님이 주문하는 주소가 아니다.
  "self.baemin.com",
  "wing.coupang.com",
];

/**
 * Words that mean a field is asking for something the Bot must never hold.
 *
 * A second signal beside `element.type`, and it earns its place: the type is read out of the page's
 * DOM and only for the main frame, so a password box inside a payment iframe arrives as an ordinary
 * textbox. The label is what is left, and a field labelled 비밀번호 is a field a Bot types a password
 * into whether or not anything told us its type.
 */
export const SECRET_FIELD_WORDS: readonly string[] = [
  "비밀번호",
  "비밀 번호",
  "암호",
  "password",
  "passcode",
  /*
   * The codes and numbers a checkout or a sign-in asks for beside the password. A one-time code is
   * `type="text"` and a card number is `type="tel"`, so the type says nothing about either, and
   * both used to be typed by the Bot and kept verbatim in the thread. They are the person's to
   * type, through the same door a password goes through.
   */
  "인증번호",
  "인증 번호",
  "일회용",
  "otp",
  "카드번호",
  "카드 번호",
  "cvc",
  "cvv",
  "보안코드",
  "보안 코드",
];

/**
 * How many identical attempts in a row are worth stopping for.
 *
 * Five, not ten. The count is a backstop against a model going round in circles, and every one of
 * those attempts is a real action on somebody's live website; by the tenth identical press of a
 * button the damage a loop can do has been done five times over. The preset on the Boundaries page
 * still offers ten as a `deny`, which is a different decision — this one only asks.
 */
export const REPEAT_ASK_AT = 5;

/**
 * A regex-safe spelling of one word, for a pattern that goes through CEL.
 *
 * Character classes rather than backslashes, and deliberately: cel-js does not process escapes inside
 * a string literal, so a backslash written here survives into the pattern, and the same string then
 * goes through JSON on its way to the database and back. `[.]` means the same thing at every layer
 * and cannot be broken by one of them. See `assertSimpleTerms` for what keeps this total.
 */
function regexSafe(term: string): string {
  return term.replace(/[^\p{L}\p{N} ]/gu, (character) => `[${character}]`);
}

/**
 * The terms are letters, digits, spaces and dots, and a test says so.
 *
 * `regexSafe` is only total over that alphabet, and a rule built from a term containing a quote would
 * produce a CEL expression that does not parse — which is an `ask` rule that throws, which asks about
 * everything. Exported so the test can walk the shipped lists rather than trusting them.
 */
export function isSimpleTerm(term: string): boolean {
  return /^[\p{L}\p{N} .]+$/u.test(term) && term.trim() === term;
}

/** `결제|송금|…`, for `matches(element.name, …)`. */
export function wordPattern(words: readonly string[]): string {
  return words.map(regexSafe).join("|");
}

/** `(^|[.])(kbstar[.]com|…)$` — the host itself or anything under it, and nothing that merely ends in it. */
export function hostPattern(hosts: readonly string[]): string {
  return `(^|[.])(${hosts.map(regexSafe).join("|")})$`;
}

/**
 * Pressing something whose label is about money, sending, deleting or confirming.
 *
 * `intent` rather than the tool name, so Enter and Space on a focused button are the same act as a
 * click — a form has more than one door and a rule naming `computer_click` covers one of them.
 */
export const MONEY_WORD_RULE = `intent == "activate" && matches(element.name, "${wordPattern(MONEY_WORDS)}")`;

/** Pressing anything at all on a site where money moves. */
export const MONEY_HOST_RULE = `intent == "activate" && matches(page.host, "${hostPattern(MONEY_HOSTS)}")`;

/** The same call, again and again. See REPEAT_ASK_AT. */
export const REPEAT_RULE = `repeat.count >= ${REPEAT_ASK_AT}`;

/**
 * Typing into a field that is asking for a secret. A refusal, not a question.
 *
 * Not an `ask`, because there is no answer that makes it right: whatever a person presses, the value
 * would still be the Bot's to have, and it arrived from a model that must not hold it. The Bot has a
 * door of its own for this — `computer_request_secret` puts the person's own keyboard on the field —
 * so the refusal has somewhere to send it, which is what makes a deny the kind thing here.
 */
export const SECRET_FIELD_RULE = `intent == "type" && (element.type == "password" || matches(element.name, "${wordPattern(SECRET_FIELD_WORDS)}"))`;

/**
 * What a deployment enforces when it has not said otherwise.
 *
 * Permissive at the bottom and explicit about it: everything not named above is allowed, recorded,
 * and visible in the audit trail. The `allow: ["true"]` line is a decision somebody wrote down rather
 * than a default that fell out of an empty list.
 */
/**
 * Handing one of the Bot's own files to a website.
 *
 * Every other rule here is about a label or a host, because the risk is in what a click does. This
 * one is about a direction: the workspace holds what a Bot has written down over every task it has
 * ever run, and an upload is the only call that takes a piece of that out and gives it to somebody
 * else. The button says nothing about it — a file input is usually called 파일 선택 — so there is
 * nothing for a rule about labels to see.
 */
export const UPLOAD_RULE = 'intent == "upload"';

export const DEFAULT_ACTION_POLICY: ActionPolicy = {
  deny: [SECRET_FIELD_RULE],
  ask: [MONEY_WORD_RULE, MONEY_HOST_RULE, UPLOAD_RULE, REPEAT_RULE],
  allow: ["true"],
};

const SECRET_NAMES = new RegExp(wordPattern(SECRET_FIELD_WORDS), "iu");

/**
 * Whether a control, by its label or its type, holds something the Bot must never be shown.
 *
 * The same two signals `SECRET_FIELD_RULE` refuses typing into, asked of a snapshot element on the
 * way back rather than of an action on the way in: a field the Bot may not fill is a field whose
 * contents it may not read either, and the snapshot is where those contents arrive.
 */
export function isSecretFieldElement(element: {
  name: string;
  type?: string | undefined;
}): boolean {
  return element.type === "password" || SECRET_NAMES.test(element.name);
}

/**
 * Whether the action being refused is a Bot typing into a secret field.
 *
 * Read off the action rather than off the rule that matched, because the fact the Bot needs — there
 * is another way to get this value into the page — is true whichever rule refused it, including one
 * a deployment wrote itself. See `laf:use_request_secret` in policy.ts.
 */
export function isSecretField(context: PolicyContext): boolean {
  if (context.intent !== "type") return false;
  if (context.element?.type === "password") return true;
  return SECRET_NAMES.test(context.element?.name ?? "");
}
