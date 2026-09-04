/**
 * The Korean business sites a Bot signs into by being handed the wheel once.
 *
 * WHY THIS IS NOT A LIST OF API KEYS. Every service here would otherwise ask each shop for its own
 * developer registration — 스마트스토어 커머스API, 쿠팡 오픈API, 홈택스 전자세금계산서 —
 * which is a week of paperwork per site for somebody who does not write software, and for several
 * of them (배민, 요기요, 캐치테이블, 당근) there is no key to obtain at all. The Bot already drives
 * a real browser on the person's own VM, so the connection is the one a person already knows how to
 * make: open the site, log in, hand it back. The session then lives in the browser profile, which
 * is durable across restarts (`agent-computer/src/profiles.ts`).
 *
 * IT IS DATA, AND ONLY DATA. Every string here is an English key; the Korean is in
 * `app/src/lib/i18n-ko.ts` and `app/tests/site-catalogue.test.ts` walks this table to prove it is
 * there — `t(site.name)` is a variable call and the literal-scanning coverage test cannot see it,
 * the same trap `agent-presets.test.ts` was written for.
 *
 * IT LIVES IN `shared/` BECAUSE BOTH SIDES NEED THE SAME TABLE. The surface draws the cards; the
 * server matches the host on every successful navigation — a routine that opens 배민 at 6am is what
 * keeps `last_seen_at` honest, and it must decide "is this 배민, and does the page read as signed
 * in" with exactly the predicate the card was drawn from. Two copies of this table would disagree
 * within a month, and the disagreement would show up as a card claiming a login that expired.
 */

/**
 * The eight work patterns, as `app/src/lib/agents/presets.ts` names them.
 *
 * Repeated here rather than imported because `shared/` cannot reach into `app/`. Pinned by a test
 * that compares the two lists, so a pattern renamed on one side fails rather than drifting.
 */
export type SiteCategory =
  | "night-watch"
  | "approval"
  | "settlement"
  | "enquiries"
  | "schedule"
  | "stock"
  | "reputation"
  | "paperwork";

/**
 * What the person has to do, and whether it is once or every time.
 *
 * `login` is an ordinary id and password: done once, and the browser profile keeps it.
 * `certificate` is 공동인증서 or 간편인증 — the certificate lives on the person's own device and is
 * signed by a program outside the browser, so the container has neither (see
 * `docs/laf/browser-limits.md` §1). There is no "connect once" for those: the person authenticates
 * each time and the card has to say so instead of promising a connection it cannot keep.
 */
export type SiteHandoff = "login" | "certificate";

export type BusinessSite = {
  id: string;
  /** English key. Korean in `i18n-ko.ts`; this is never shown as-is on a Korean screen. */
  name: string;
  category: SiteCategory;
  /** Where the handoff starts. The Bot navigates here through the ordinary governed route. */
  loginUrl: string;
  /** The hosts that count as this site. A subdomain of one of these counts too. */
  hosts: readonly string[];
  /** One sentence: 연결하면 봇이 할 수 있는 일. English key. */
  what: string;
  handoff: SiteHandoff;
  /** Two or three first tasks, as the person would type them. English keys. */
  prompts: readonly string[];
  /**
   * Whether the page in front of the browser reads as signed in.
   *
   * Deliberately conservative: it answers false whenever it cannot tell. A card that wrongly says
   * 연결됨 sends somebody away believing a routine will work at 6am, and they find out it did not
   * when the morning digest is empty.
   */
  signedIn: (url: string, snapshotText: string) => boolean;
};

/** A logout control on the page is the strongest evidence there is. Nothing else beats it. */
const SIGNED_IN_WORDS = ["로그아웃", "Log out", "Sign out"] as const;

/** The login wall, in the words these sites actually put on it. */
const DEFAULT_LOGIN_WORDS = ["로그인", "Log in", "Sign in"] as const;

function containsAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

/** Host and path, or null for anything that is not a URL — `about:blank` included. */
function locationOf(url: string): { host: string; path: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return { host: parsed.host.toLowerCase(), path: parsed.pathname };
  } catch {
    return null;
  }
}

export function hostBelongsTo(host: string, hosts: readonly string[]): boolean {
  const lowered = host.toLowerCase();
  return hosts.some(
    (known) => lowered === known || lowered.endsWith(`.${known}`),
  );
}

/**
 * One row as it is written down, before its predicate is built from it.
 *
 * The two extra fields are what "signed in" means for that site. They are NOT repeated inside a
 * hand-written predicate: the hosts a site owns and the hosts its predicate tests were two lists
 * that had to agree, and a pair of lists that must agree is a pair of lists that will not.
 */
type SiteSpec = Omit<BusinessSite, "signedIn"> & {
  /** Path prefixes that mean the login wall is still on screen. */
  loginPaths?: readonly string[];
  /** Words that mean the same. Defaults to the three ways these sites say "log in". */
  loginWords?: readonly string[];
};

/**
 * The predicate every entry is built from: on its own host, past the login path, no login wall.
 *
 * Three checks in this order, and the order is the whole design:
 *
 *  1. **Is this even the site?** An id provider is a different host — 네이버 sends you to
 *     `nid.naver.com`, 카카오 to `accounts.kakao.com` — so "not on this site's hosts" already
 *     answers "not signed in", and it answers it for every login wall that lives somewhere else.
 *  2. **Is the login path still on the address bar?** The first signal: the URL left the login
 *     path.
 *  3. **Is a logout control on the page?** The second signal, and it OVERRIDES the login words
 *     below — a signed-in dashboard often carries the word 로그인 somewhere in a footer or a help
 *     menu, and a login wall never carries 로그아웃.
 */
function signedInWhen(spec: SiteSpec): BusinessSite["signedIn"] {
  return (url, snapshotText) => {
    const at = locationOf(url);
    if (!at) return false;
    if (!hostBelongsTo(at.host, spec.hosts)) return false;
    for (const prefix of spec.loginPaths ?? []) {
      if (at.path.startsWith(prefix)) return false;
    }
    if (containsAny(snapshotText, SIGNED_IN_WORDS)) return true;
    return !containsAny(snapshotText, spec.loginWords ?? DEFAULT_LOGIN_WORDS);
  };
}

/**
 * Fifteen sites, in the order the section draws them.
 *
 * Chosen as the ones a Korean small business actually signs into every morning, not as the ones
 * with the best APIs — which is close to the opposite list.
 */
const SITE_SPECS: readonly SiteSpec[] = [
  {
    id: "naver-smartstore",
    name: "Naver Smart Store Seller Centre",
    category: "enquiries",
    loginUrl: "https://sell.smartstore.naver.com",
    hosts: ["sell.smartstore.naver.com", "smartstore.naver.com"],
    what: "Read today's orders and the enquiries nobody has answered yet.",
    handoff: "login",
    prompts: [
      "Sort out the orders that came in today.",
      "Show me the enquiries nobody has answered.",
      "Tell me which products are about to run out.",
    ],
    loginPaths: ["/login"],
  },
  {
    id: "naver-smartplace",
    name: "Naver Smart Place",
    category: "reputation",
    loginUrl: "https://new.smartplace.naver.com",
    hosts: ["new.smartplace.naver.com", "smartplace.naver.com"],
    what: "Read the reviews on your shop's listing and check what it says about you.",
    handoff: "login",
    prompts: [
      "Sort out the reviews that came in this week.",
      "Check whether the opening hours on the listing are right.",
    ],
    loginPaths: ["/login"],
  },
  {
    id: "naver-booking-talk",
    name: "Naver Booking and Talk Partner Centre",
    category: "schedule",
    loginUrl: "https://partner.booking.naver.com",
    hosts: ["partner.booking.naver.com", "partner.talk.naver.com"],
    what: "Read tomorrow's bookings and the Talk messages waiting for a reply.",
    handoff: "login",
    prompts: [
      "Put tomorrow's bookings in order of time.",
      "Show me the Talk messages nobody has replied to.",
    ],
    loginPaths: ["/login"],
  },
  {
    id: "coupang-wing",
    name: "Coupang Wing",
    category: "stock",
    loginUrl: "https://wing.coupang.com",
    hosts: ["wing.coupang.com"],
    what: "Read what has to ship today and which products are blocked or out of stock.",
    handoff: "login",
    prompts: [
      "Sort out the orders that have to ship today.",
      "Check whether any product is blocked or out of stock.",
    ],
    loginPaths: ["/login", "/tenants/sfl-portal/login"],
  },
  {
    id: "baemin-ceo",
    name: "Baemin for Owners",
    category: "settlement",
    loginUrl: "https://ceo.baemin.com",
    hosts: ["ceo.baemin.com"],
    what: "Read yesterday's sales, the orders behind them and what is due to be settled.",
    handoff: "login",
    prompts: [
      "Sort out yesterday's sales and how many orders there were.",
      "Tell me what is due to be settled and when.",
    ],
    loginPaths: ["/login", "/self-service/login"],
  },
  {
    id: "coupangeats-store",
    name: "Coupang Eats Store",
    category: "night-watch",
    loginUrl: "https://store.coupangeats.com",
    hosts: ["store.coupangeats.com"],
    what: "Read yesterday's orders overnight and check the shop is open when it should be.",
    handoff: "login",
    prompts: [
      "Sort out the orders that came in yesterday.",
      "Check the shop's opening state is what it should be right now.",
    ],
    loginPaths: ["/login", "/merchant/login"],
  },
  {
    id: "yogiyo-ceo",
    name: "Yogiyo for Owners",
    category: "reputation",
    loginUrl: "https://ceo.yogiyo.co.kr",
    hosts: ["ceo.yogiyo.co.kr"],
    what: "Read new reviews and tell you which ones are worth a reply today.",
    handoff: "login",
    prompts: [
      "Sort out the new reviews and tell me which need a reply.",
      "Sort out yesterday's sales.",
    ],
    loginPaths: ["/login", "/account/login"],
  },
  {
    id: "hometax",
    name: "Hometax",
    category: "paperwork",
    loginUrl: "https://hometax.go.kr",
    hosts: ["hometax.go.kr", "www.hometax.go.kr", "teht.hometax.go.kr"],
    what: "Read what has been issued and what is due, once you have authenticated it yourself.",
    handoff: "certificate",
    prompts: [
      "Sort out the tax invoices issued this month.",
      "Tell me which filing deadlines are coming up.",
    ],
    /*
     * NO PATH TO TEST. 홈택스 is one WebSquare shell and the address barely changes between the
     * login screen and the signed-in one, so the words on the page are the only signal there is —
     * measured in `docs/laf/browser-limits.md` §3, where the shell read as 로그인·인증센터 before
     * anybody had authenticated.
     */
    loginWords: ["로그인", "공동·금융인증서", "간편인증"],
  },
  {
    id: "daangn-business",
    name: "Daangn Business",
    category: "reputation",
    loginUrl: "https://business.daangn.com",
    hosts: ["business.daangn.com"],
    what: "Read the reviews and enquiries left on your neighbourhood business page.",
    handoff: "login",
    prompts: [
      "Sort out the new reviews and enquiries.",
      "Tell me how this week's neighbourhood post did.",
    ],
    loginPaths: ["/login", "/signin"],
  },
  {
    id: "catchtable-ceo",
    name: "CatchTable for Owners",
    category: "schedule",
    loginUrl: "https://ceo.catchtable.co.kr",
    hosts: ["ceo.catchtable.co.kr"],
    what: "Read today's reservations, in order, and who did not turn up.",
    handoff: "login",
    prompts: [
      "Put today's reservations in order of time.",
      "Check whether anybody did not turn up.",
    ],
    loginPaths: ["/login"],
  },
  {
    id: "tosspayments",
    name: "Toss Payments Merchant Admin",
    category: "settlement",
    loginUrl: "https://dashboard.tosspayments.com",
    hosts: ["dashboard.tosspayments.com", "developers.tosspayments.com"],
    what: "Read yesterday's payments and cancellations and what is due to be settled.",
    handoff: "login",
    prompts: [
      "Sort out yesterday's payments and cancellations.",
      "Tell me what is due to be settled and when.",
    ],
    loginPaths: ["/login", "/signin"],
  },
  {
    id: "naver-searchad",
    name: "Naver Search Ads",
    category: "settlement",
    loginUrl: "https://searchad.naver.com",
    hosts: ["searchad.naver.com", "manage.searchad.naver.com"],
    what: "Read what the ads spent, what they brought in, and which campaigns have stopped.",
    handoff: "login",
    prompts: [
      "Sort out yesterday's ad spend and clicks.",
      "Tell me which campaigns have run out of budget.",
    ],
    loginPaths: ["/login"],
  },
  {
    id: "instagram",
    name: "Instagram on the web",
    category: "reputation",
    loginUrl: "https://www.instagram.com",
    hosts: ["instagram.com", "www.instagram.com"],
    what: "Read the comments and messages your shop's account has been left.",
    handoff: "login",
    prompts: [
      "Sort out the new comments and messages.",
      "Tell me how this week's posts did.",
    ],
    loginPaths: ["/accounts/login"],
  },
  {
    id: "kakao-channel",
    name: "KakaoTalk Channel Admin",
    category: "enquiries",
    loginUrl: "https://center-pf.kakao.com",
    hosts: ["center-pf.kakao.com"],
    what: "Read the chats waiting for a reply and how the channel is doing.",
    handoff: "login",
    prompts: [
      "Show me the chats nobody has replied to.",
      "Tell me how many new friends the channel got this week.",
    ],
    loginPaths: ["/login"],
  },
  {
    id: "cafe24-admin",
    name: "Cafe24 Shop Admin",
    category: "stock",
    loginUrl: "https://eclogin.cafe24.com/Shop/",
    /*
     * THE WHOLE DOMAIN, BECAUSE THE ADMIN IS NOT ON ONE HOST. A signed-in admin lands on the
     * shop's own `*.cafe24.com` address, which differs per mall. That means the login host
     * `eclogin.cafe24.com` is inside this list too, so the path below is what has to exclude it —
     * `/Shop/` is exactly where that login form lives.
     */
    hosts: ["cafe24.com"],
    what: "Read the mall's orders and which products are running low, for a mall not on the OAuth path.",
    handoff: "login",
    prompts: [
      "Sort out the orders that came in today.",
      "Tell me which products are running low.",
    ],
    loginPaths: ["/Shop/", "/login"],
    /* `eclogin` is a host, and the path check above cannot see it. */
    loginWords: ["로그인", "아이디 저장", "Log in"],
  },
];

/**
 * The catalogue, with each row's predicate built from that row's own hosts.
 *
 * `loginPaths` and `loginWords` stay on the entry rather than being stripped: they are what the
 * predicate MEANS for that site, and a reader working out why 홈택스 answers the way it does should
 * find the answer on the row rather than in a closure.
 */
export const BUSINESS_SITES: readonly BusinessSite[] = SITE_SPECS.map(
  (spec) => ({ ...spec, signedIn: signedInWhen(spec) }),
);

/** The site this URL belongs to, or null. What the gateway asks on every successful navigation. */
export function siteForUrl(url: string): BusinessSite | null {
  const at = locationOf(url);
  if (!at) return null;
  return (
    BUSINESS_SITES.find((site) => hostBelongsTo(at.host, site.hosts)) ?? null
  );
}

/** One site by id, or null for an id that is not in the table. */
export function siteById(id: string): BusinessSite | null {
  return BUSINESS_SITES.find((site) => site.id === id) ?? null;
}
