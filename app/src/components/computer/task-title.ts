/**
 * WHAT A BROWSING CARD IS CALLED: THE SITE A PERSON WOULD NAME, AND WHAT THE BOT LOOKED UP THERE.
 *
 * MEASURED ON 2026-09-24 (UI/UX audit, item 13): the cards were titled `search.naver.com`,
 * `search.shopping.naver.com · search.n…`, and — for every task that opened no page of its own —
 * "봇의 브라우저". The banner said `yes24.com · 다음에 할 일을 고르는 중`. None of it says what the task
 * was, and a host name is how a machine names a place, not how a shop owner does.
 *
 * So the title is "네이버 쇼핑 · 원두 1kg": the site's name, then what the Bot looked up there
 * (`taskTitle` below says why not the person's sentence). The site's name comes from two tables —
 * the business sites a Bot signs into (`shared/sites/catalogue.ts`, the 연결 screen's names) and the
 * everyday places below — and a host neither knows is shown as the host, which is still true.
 *
 * Every name here is an English key read through `t()` on a variable, which the literal-scanning
 * coverage test cannot see: `app/tests/browsing-card-title.test.ts` walks the table instead.
 */
import { siteForUrl } from "@shared/sites/catalogue";
import { t } from "@/lib/i18n";
import { ko } from "@/lib/i18n-ko";

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
  // Before 토스: the owner's own card read "tossinvest.com · 테슬라" (2026-10-03).
  { hosts: ["tossinvest.com"], name: "Toss Securities" },
  { hosts: ["toss.im"], name: "Toss" },
  { hosts: ["weather.go.kr"], name: "Korea Meteorological Administration" },
  { hosts: ["gov.kr"], name: "Government24" },
  { hosts: ["letskorail.com", "korail.com"], name: "Korail" },
];

function under(host: string, hosts: readonly string[]): boolean {
  return hosts.some((known) => host === known || host.endsWith(`.${known}`));
}

/** The name a host is known by in the two tables, as its English key; null where neither has it. */
function siteKeyOf(host: string): string | null {
  const lowered = host.toLowerCase();
  const business = siteForUrl(`https://${lowered}/`);
  if (business) return business.name;
  return (
    EVERYDAY_SITES.find((site) => under(lowered, site.hosts))?.name ?? null
  );
}

/** The name a person would call a host by, in their language; the host itself when unknown. */
export function siteNameOf(host: string): string {
  const key = siteKeyOf(host);
  return key ? t(key) : host.toLowerCase().replace(/^www\./, "");
}

/**
 * Every way a site is written here: its name in each language this app speaks.
 *
 * What a Bot looked up is in the language it searched in, which need not be the reader's: a Korean
 * screen whose Bot searched for "Toss Securities", an English one whose Bot searched for 토스증권.
 */
function everyNameOf(host: string): string[] {
  const key = siteKeyOf(host);
  if (key === null) return [siteNameOf(host)];
  return [key, ko[key], t(key)].filter(
    (name): name is string => typeof name === "string" && name !== "",
  );
}

/**
 * The sites a task went to, named, once each: `naver.com` and `search.naver.com` are one 네이버.
 */
export function siteNamesOf(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map(siteNameOf))];
}

/**
 * THE TITLE: "site · what was looked up there", either half alone when that is all there is, or
 * null for neither — the card then says what it has always said when it knows nothing.
 *
 * THE SECOND HALF IS WHAT THE BOT LOOKED UP, NOT WHAT THE PERSON SAID. It used to be the person's
 * request, shortened, and a person does not always ask: on the first-hour walk (2026-09-27) the
 * owner said where the shop was, the Bot went to look up the weather there, and the card read
 * "네이버 · 우리 가게는 춘천 효자동에 있는 한식당이에요" — a sentence about the shop, over a search
 * for the weather. What the Bot searched for, or the page it opened, is what the card is a picture
 * of (`lookedUpOf` in `lib/computer/browsing.ts`); with neither, the site alone is the truer title.
 */
export function taskTitle(
  hosts: readonly string[],
  lookedUp: string | undefined,
): string | null {
  const site = siteNamesOf(hosts).at(-1) ?? null;
  const title = [site, lookedUp?.trim() || null].filter(Boolean).join(" · ");
  return title || null;
}

/** One name written two ways is one name: width, case and the spaces inside it aside. */
function isSameName(one: string, other: string): boolean {
  const fold = (name: string) =>
    name.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return fold(one) === fold(other);
}

/**
 * THE CARD'S OWN TWO LINES: where, small, and what, as the title.
 *
 * {@link taskTitle} is one line for a place that has one — the banner. On the card that line put
 * the site first and gave it the title's weight, so the thing a person asked about came second and
 * was the part cut off: "tossinvest.com · 테슬라". And where the Bot had searched for the site
 * itself the card said it twice: "tossinvest.com · 토스증권" (the owner's screenshot, 2026-10-03).
 *
 * So the title is what was looked up, and the site is the small line above it. With nothing looked
 * up — or only the site's own name — the site is the title and nothing is said above it.
 */
export function taskHeading(
  hosts: readonly string[],
  lookedUp: string | undefined,
): { site: string | null; title: string | null } {
  const site = siteNamesOf(hosts).at(-1) ?? null;
  const what = lookedUp?.trim() || null;
  if (what === null || site === null)
    return { site: null, title: what ?? site };
  // In whichever language it was looked up in: the reader's, or the other (review, round 2).
  const names = hosts
    .filter((host) => siteNameOf(host) === site)
    .flatMap(everyNameOf);
  if (names.some((name) => isSameName(what, name))) {
    return { site: null, title: site };
  }
  return { site, title: what };
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
