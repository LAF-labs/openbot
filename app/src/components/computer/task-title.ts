/**
 * WHAT A BROWSING CARD IS CALLED: THE SITE A PERSON WOULD NAME, AND WHAT THEY ASKED FOR THERE.
 *
 * MEASURED ON 2026-09-24 (UI/UX audit, item 13): the cards were titled `search.naver.com`,
 * `search.shopping.naver.com · search.n…`, and — for every task that opened no page of its own —
 * "봇의 브라우저". The banner said `yes24.com · 다음에 할 일을 고르는 중`. None of it says what the task
 * was, and a host name is how a machine names a place, not how a shop owner does.
 *
 * So the title is "네이버 쇼핑 · 원두 1kg 가격 비교": the site's name, then the person's own request,
 * shortened. The request is theirs and needs no guessing; the site's name comes from two tables —
 * the business sites a Bot signs into (`shared/sites/catalogue.ts`, the 연결 screen's names) and the
 * everyday places below — and a host neither knows is shown as the host, which is still true.
 *
 * Every name here is an English key read through `t()` on a variable, which the literal-scanning
 * coverage test cannot see: `app/tests/browsing-card-title.test.ts` walks the table instead.
 */
import { siteForUrl } from "@shared/sites/catalogue";
import { LEADING_SKILL } from "@/components/channels/composer/draft";
import { t } from "@/lib/i18n";

/**
 * Everyday sites a Bot is asked to look things up on, by the name people use for them.
 *
 * Most specific first: `search.shopping.naver.com` is 네이버 쇼핑 before it is 네이버. A host
 * counts when it is one of these or under one.
 */
export const EVERYDAY_SITES: readonly {
  hosts: readonly string[];
  name: string;
}[] = [
  { hosts: ["shopping.naver.com"], name: "Naver Shopping" },
  { hosts: ["map.naver.com"], name: "Naver Map" },
  { hosts: ["weather.naver.com"], name: "Naver Weather" },
  { hosts: ["news.naver.com"], name: "Naver News" },
  { hosts: ["blog.naver.com"], name: "Naver Blog" },
  { hosts: ["cafe.naver.com"], name: "Naver Cafe" },
  { hosts: ["naver.com"], name: "Naver" },
  { hosts: ["map.kakao.com"], name: "Kakao Map" },
  { hosts: ["daum.net"], name: "Daum" },
  { hosts: ["google.com", "google.co.kr"], name: "Google" },
  { hosts: ["youtube.com"], name: "YouTube" },
  { hosts: ["coupang.com"], name: "Coupang" },
  { hosts: ["11st.co.kr"], name: "11st" },
  { hosts: ["gmarket.co.kr"], name: "Gmarket" },
  { hosts: ["auction.co.kr"], name: "Auction" },
  { hosts: ["ssg.com"], name: "SSG.COM" },
  { hosts: ["musinsa.com"], name: "Musinsa" },
  { hosts: ["yes24.com"], name: "YES24" },
  { hosts: ["kyobobook.co.kr"], name: "Kyobo Book Centre" },
  { hosts: ["aladin.co.kr"], name: "Aladin" },
  { hosts: ["toss.im"], name: "Toss" },
  { hosts: ["weather.go.kr"], name: "Korea Meteorological Administration" },
  { hosts: ["gov.kr"], name: "Government24" },
  { hosts: ["letskorail.com", "korail.com"], name: "Korail" },
];

function under(host: string, hosts: readonly string[]): boolean {
  return hosts.some((known) => host === known || host.endsWith(`.${known}`));
}

/** The name a person would call a host by, in their language; the host itself when unknown. */
export function siteNameOf(host: string): string {
  const lowered = host.toLowerCase();
  const business = siteForUrl(`https://${lowered}/`);
  if (business) return t(business.name);
  const everyday = EVERYDAY_SITES.find((site) => under(lowered, site.hosts));
  return everyday ? t(everyday.name) : lowered.replace(/^www\./, "");
}

/**
 * The sites a task went to, named, once each: `naver.com` and `search.naver.com` are one 네이버.
 */
export function siteNamesOf(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map(siteNameOf))];
}

/**
 * A request's closing words, which say "please" and nothing about the task. Only the 해 of a 하다
 * verb goes: "비교해 줘" is a 비교, and "알려줘" is nothing at all.
 */
const REQUEST_ENDING =
  /\s*(?:좀\s*)?(?:(?:해|알려|찾아|봐)\s?(?:줘|줄래|주세요|줄래요|주실래요|줄\s?수\s?있어|주겠니)|부탁해(?:요)?|부탁드려요|줘|주세요)$/;

/**
 * The person's request, as the second half of a title: its first sentence, no skill chip, no
 * "please", and no "…에서" naming the site the first half already names.
 *
 * The first sentence because a request is often several — what to do, then how to go about it —
 * and the first is the one that says what the task is.
 *
 * Null when nothing is left, so the title falls back to the site alone rather than a dangling dot.
 */
export function taskOf(
  asked: string | undefined,
  site: string | null,
): string | null {
  if (!asked) return null;
  let text = (asked.split("\n").find((line) => line.trim()) ?? "").trim();
  text = text.split(/(?<=[.?!])\s+/)[0] ?? text;
  text = text.replace(LEADING_SKILL, "");
  /*
   * An address the request starts with is the site half already, said the machine's way:
   * "httpbin.org · https://httpbin.org/forms/post 열어서 이름 칸에 …" (measured 2026-09-25).
   */
  text = text.replace(LEADING_ADDRESS, "");
  if (site) {
    const at = ASKED_PLACE.exec(text);
    if (at && samePlace(site, at[1] ?? "")) text = text.slice(at[0].length);
  }
  text = text.replace(/[\s.!?~。…]+$/u, "");
  text = text.replace(REQUEST_ENDING, "").trim();
  if (FOLLOW_UP_ONLY.test(text)) return null;
  return text || null;
}

/**
 * A request that only points back at the one before it — "다시", "한 번 더", "그거 계속" — says
 * nothing about the task, and the card read "네이버 · 다시" (UX review 0.5.4, item 11). The site
 * alone is the truer title.
 */
const FOLLOW_UP_ONLY =
  /^(?:(?:그럼|그러면|아까|방금|그|그거|그것|이거|이것)\s*)?(?:다시|한\s?번\s?더|또|계속|이어서|마저|재시도)(?:\s*(?:해|해봐|해볼래|하자|시도))?$/;

/** A request that starts with the address it goes to, and the verb that opens it. */
const LEADING_ADDRESS =
  /^https?:\/\/\S+\s*(?:(?:을|를)\s*)?(?:(?:열어서|열고|열어|들어가서|접속해서)\s+)?/;

/** "네이버 쇼핑에서 …": the place a request names, with its 홈페이지/사이트/앱 and 에서. */
const ASKED_PLACE = /^(.{1,24}?)(?:\s*(?:홈페이지|사이트|앱))?에서\s+/;

const squash = (value: string) => value.replace(/\s+/g, "").toLowerCase();

/**
 * Whether the place a person named is the site the Bot went to: the same name, or a part of it the
 * person named more exactly. MEASURED 2026-09-25 on MiMo: "네이버 쇼핑에서 크라프트 봉투 …" went to
 * `search.naver.com`'s price comparison, and the card read "네이버 · 네이버 쇼핑에서 …".
 */
function samePlace(site: string, place: string): boolean {
  const named = squash(place);
  return (
    named.length > 0 &&
    (squash(site).includes(named) || named.startsWith(squash(site)))
  );
}

/**
 * The title: "site · task", either half alone when that is all there is, or null for neither —
 * the card then says what it has always said when it knows nothing.
 */
export function taskTitle(
  hosts: readonly string[],
  asked: string | undefined,
): string | null {
  const visited = siteNamesOf(hosts).at(-1) ?? null;
  /*
   * The person's own name for the place when it is the same site, named more exactly: they said
   * 네이버 쇼핑, and 네이버 is where its price comparison lives.
   */
  const place = ASKED_PLACE.exec(asked?.trim() ?? "")?.[1]?.trim();
  const site =
    visited && place && squash(place).startsWith(squash(visited))
      ? place
      : visited;
  const task = taskOf(asked, site);
  const title = [site, task].filter(Boolean).join(" · ");
  return title || null;
}

/**
 * One line of what the Bot said, for a place that has room for one: its first line, without the
 * markdown marks a bubble would have drawn.
 */
export function plainLine(text: string): string {
  const first =
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  return first
    .replace(/^(?:#+|[-*•]|\d+\.)\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

/** What the Bot said, whole, without the marks a bubble would have drawn. */
export function plainText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s+/, "").replace(/\*\*|__|`/g, ""))
    .join("\n")
    .trim();
}
