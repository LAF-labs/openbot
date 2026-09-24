/**
 * The rules a deployment's boundary starts with, and the lists they are built from.
 *
 * HERE RATHER THAN IN `server/src/computer/default-policy.ts`, since 2026-09-24, because the card a
 * person answers on has to know WHICH rule stopped the Bot. The server sends the expression that
 * matched, and the card used to print it as it arrived — `intent == "activate" && matches(page.host,
 * "(^|[.])(kbstar[.]com|…)$")` in a monospace line on a Korean screen, in front of a shop owner
 * deciding whether a click on toss.im was fine (UI/UX audit 0.5.3, item 3). The surface can only say
 * "돈이 오가는 사이트라서" if it can recognise that expression, and it can only recognise it by
 * comparing against the very string the server generated — so both read it from here.
 *
 * Recognised by exact equality and nothing looser. A deployment whose saved policy was written from
 * an older list, or whose administrator edited a rule, sends an expression this file does not
 * produce, and the card then says the generic thing ("a rule set here says to ask"). Guessing which
 * shipped rule an edited one "really" is would be the card explaining a boundary it has not read.
 *
 * THE DEPLOYMENT EDITS THE SAVED POLICY, NOT THIS FILE. What is here is what a deployment starts
 * with; `/admin/boundaries` writes over it. Editing a list below changes what a NEW deployment gets,
 * and changes the strings the card recognises — which is the reason not to reorder them casually.
 */

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
 *
 * THE ORDER IS PART OF THE RULE'S TEXT, and deployments running today hold that text in their saved
 * policy. Reordering would make the card stop recognising their rule; add to the end instead.
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
 * What each word is worried about, so the card can say why in words rather than by quoting the list.
 *
 * The four groups the comments in `MONEY_WORDS` already drew, as data. A word missing here is a word
 * the card explains in the general terms, which is still true — and a test says none is missing.
 */
export type MoneyWordKind = "money" | "irreversible" | "outward" | "confirm";

const MONEY_WORD_KINDS: Readonly<Record<string, MoneyWordKind>> = {
  결제: "money",
  송금: "money",
  이체: "money",
  출금: "money",
  구매: "money",
  주문: "money",
  pay: "money",
  "submit order": "money",
  transfer: "money",
  checkout: "money",
  삭제: "irreversible",
  탈퇴: "irreversible",
  delete: "irreversible",
  전송: "outward",
  보내기: "outward",
  발송: "outward",
  발행: "outward",
  send: "outward",
  승인: "confirm",
  확정: "confirm",
  confirm: "confirm",
};

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
  /*
   * 패스워드 was in neither this list nor the computer's, and it is the word a good share of
   * Korean sites write in place of 비밀번호. The auditor's one fixture page used it, and the value
   * a person typed rode out on the next snapshot through both nets (2026-09-10).
   */
  "패스워드",
  "패스 워드",
  "비번",
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
  "핀번호",
  "핀 번호",
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
 * and cannot be broken by one of them. See `isSimpleTerm` for what keeps this total.
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
 * Handing one of the Bot's own files to a website.
 *
 * Every other rule here is about a label or a host, because the risk is in what a click does. This
 * one is about a direction: the workspace holds what a Bot has written down over every task it has
 * ever run, and an upload is the only call that takes a piece of that out and gives it to somebody
 * else. The button says nothing about it — a file input is usually called 파일 선택 — so there is
 * nothing for a rule about labels to see.
 */
export const UPLOAD_RULE = 'intent == "upload"';

/**
 * Typing into a field that is asking for a secret. A refusal, not a question.
 *
 * Not an `ask`, because there is no answer that makes it right: whatever a person presses, the value
 * would still be the Bot's to have, and it arrived from a model that must not hold it. The Bot has a
 * door of its own for this — `computer_request_secret` puts the person's own keyboard on the field —
 * so the refusal has somewhere to send it, which is what makes a deny the kind thing here.
 */
export const SECRET_FIELD_RULE = `intent == "type" && (element.type == "password" || matches(element.name, "${wordPattern(SECRET_FIELD_WORDS)}"))`;

/** Which of the shipped `ask` rules an expression is, by name. */
export type ShippedAskRule = "money_word" | "money_host" | "upload" | "repeat";

const SHIPPED_ASK_RULES: ReadonlyMap<string, ShippedAskRule> = new Map([
  [MONEY_WORD_RULE, "money_word"],
  [MONEY_HOST_RULE, "money_host"],
  [UPLOAD_RULE, "upload"],
  [REPEAT_RULE, "repeat"],
]);

/**
 * Which shipped rule asked, or null for an expression this build did not write.
 *
 * Null covers an administrator's own rule, an edited copy of a shipped one and a policy saved from an
 * older list alike. See the top of this file for why nothing looser than equality is used.
 */
export function shippedAskRuleOf(
  expression: string | null | undefined,
): ShippedAskRule | null {
  if (!expression) return null;
  return SHIPPED_ASK_RULES.get(expression.trim()) ?? null;
}

/**
 * The word in a button's label that the money-word rule stopped for, and what it is worried about.
 *
 * Case-insensitive, as the rule's own match reads the label. The first word of `MONEY_WORDS` found,
 * in the list's order — "결제 취소" names 결제, which is what the rule saw first too. Undefined when
 * none is found, which happens when the label the card holds is not the one the server matched on;
 * the card then says the general reason rather than naming a word that was not there.
 */
export function moneyWordIn(
  label: string | undefined,
): { word: string; kind: MoneyWordKind | undefined } | undefined {
  const lowered = label?.toLowerCase() ?? "";
  if (!lowered) return undefined;
  const word = MONEY_WORDS.find((candidate) =>
    lowered.includes(candidate.toLowerCase()),
  );
  if (!word) return undefined;
  // A word with no group is explained in the general terms by the card, never filed under one.
  return { word, kind: MONEY_WORD_KINDS[word] };
}
