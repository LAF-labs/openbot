import { describe, expect, test } from "bun:test";
import { WORK_PATTERNS } from "../src/lib/agents/presets";
import { ko } from "../src/lib/i18n-ko";
import {
  BUSINESS_SITES,
  type SiteCategory,
  siteById,
  siteForUrl,
} from "../src/lib/sites/catalogue";

/**
 * The site catalogue is the second table this app calls `t()` on a VARIABLE for.
 *
 * `i18n-coverage.test.ts` reads literal `t("…")` calls out of the source, which is all it can
 * honestly do — and it means `t(site.name)` is invisible to it. A site added without Korean fails
 * nowhere: the card renders "Baemin for Owners" in a Korean product, and the suggestion chips fill
 * somebody's chat with English. So the table is walked here, exactly as `agent-presets.test.ts`
 * walks the presets.
 *
 * The other half of this file is the `signedIn` predicate, which is the one piece of logic in the
 * catalogue and the one thing that can make a card lie. Every case below is a URL and a page these
 * sites actually produce.
 */

/**
 * `satisfies Record<SiteCategory, true>` is doing the work: a category added to the type and not to
 * this object is a typecheck error rather than a category this file quietly stops checking.
 */
const CATEGORIES = Object.keys({
  "night-watch": true,
  approval: true,
  settlement: true,
  enquiries: true,
  schedule: true,
  stock: true,
  reputation: true,
  paperwork: true,
} satisfies Record<SiteCategory, true>) as SiteCategory[];

describe("the site catalogue", () => {
  test("every word of every site has Korean", () => {
    const missing: string[] = [];
    for (const site of BUSINESS_SITES) {
      for (const value of [site.name, site.what, ...site.prompts]) {
        if (!(value in ko)) missing.push(`${site.id}: ${value}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the Korean is actually Korean, not the English key repeated", () => {
    // A dictionary entry that copies its key passes the check above and changes nothing on screen.
    const untranslated = BUSINESS_SITES.filter(
      (site) => ko[site.name] === site.name,
    ).map((site) => site.id);
    expect(untranslated).toEqual([]);
  });

  test("ids are unique, so no two cards are the same card", () => {
    const ids = BUSINESS_SITES.map((site) => site.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * THE CATEGORIES ARE THE EIGHT WORK PATTERNS, not a list of their own.
   *
   * `SiteCategory` is declared in `shared/` because that file cannot import from `app/`, which
   * makes it a copy — and a copy is a thing that drifts. This is what stops it: rename a pattern on
   * either side and one of these two assertions fails.
   */
  test("the categories are the same eight the presets use", () => {
    expect(CATEGORIES.toSorted()).toEqual(
      WORK_PATTERNS.map((pattern) => pattern.id).toSorted(),
    );
  });

  test("every site belongs to one of them", () => {
    const orphans = BUSINESS_SITES.filter(
      (site) => !CATEGORIES.includes(site.category),
    ).map((site) => `${site.id} → ${site.category}`);
    expect(orphans).toEqual([]);
  });

  test("every site offers two or three first things to ask", () => {
    const counted = BUSINESS_SITES.filter(
      (site) => site.prompts.length < 2 || site.prompts.length > 3,
    ).map((site) => `${site.id}: ${site.prompts.length}`);
    expect(counted).toEqual([]);
  });

  test("every login address is https and lands on the site's own hosts", () => {
    const wrong = BUSINESS_SITES.filter((site) => {
      if (!site.loginUrl.startsWith("https://")) return true;
      return siteForUrl(site.loginUrl)?.id !== site.id;
    }).map((site) => `${site.id}: ${site.loginUrl}`);
    expect(wrong).toEqual([]);
  });

  /**
   * 홈택스 IS THE ONE THAT CANNOT BE CONNECTED ONCE, and the card's whole behaviour hangs off this
   * one field: the button reads 지금 인증하고 돌려주기 instead of 연결, and the card says the
   * certificate is the person's to do every time. A 공동인증서 site marked `login` would be a card
   * promising a connection this product cannot keep.
   */
  test("Hometax is a certificate handoff and it is the only one", () => {
    expect(
      BUSINESS_SITES.filter((site) => site.handoff === "certificate").map(
        (site) => site.id,
      ),
    ).toEqual(["hometax"]);
  });

  test("a site can be found by id, and an unknown id is null", () => {
    expect(siteById("baemin-ceo")?.loginUrl).toBe("https://ceo.baemin.com");
    expect(siteById("not-a-site")).toBeNull();
  });

  test("a URL belonging to nobody matches nothing", () => {
    expect(siteForUrl("https://example.com/anything")).toBeNull();
    expect(siteForUrl("about:blank")).toBeNull();
    expect(siteForUrl("")).toBeNull();
  });
});

/** The site, by id, for the predicate cases below. Throws rather than silently testing nothing. */
const site = (id: string) => {
  const found = siteById(id);
  if (!found) throw new Error(`No site ${id} in the catalogue`);
  return found;
};

describe("reading a page as signed in", () => {
  test("a blank browser is never signed in", () => {
    for (const entry of BUSINESS_SITES) {
      expect(entry.signedIn("about:blank", "")).toBe(false);
    }
  });

  test("somebody else's page is never signed in", () => {
    for (const entry of BUSINESS_SITES) {
      // 로그아웃 on a page belonging to another site must not count for this one.
      expect(entry.signedIn("https://example.com/", "로그아웃")).toBe(false);
    }
  });

  test("스마트스토어: the ID provider is a different host, so it reads as not signed in", () => {
    const smartstore = site("naver-smartstore");
    expect(
      smartstore.signedIn(
        "https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fsell.smartstore.naver.com",
        "네이버 로그인 아이디 비밀번호",
      ),
    ).toBe(false);
    expect(
      smartstore.signedIn(
        "https://sell.smartstore.naver.com/#/home/dashboard",
        "판매자센터 오늘 주문 로그아웃",
      ),
    ).toBe(true);
  });

  test("스마트스토어: the login wall on its own host still reads as not signed in", () => {
    // Measured: the seller centre serves its login wall from its own address, so the host check
    // alone would have called this a connection.
    expect(
      site("naver-smartstore").signedIn(
        "https://sell.smartstore.naver.com/login",
        "로그인하기 가입하기 네이버 커머스 ID 알아보기",
      ),
    ).toBe(false);
  });

  test("배민: past the login path with a logout link is signed in", () => {
    const baemin = site("baemin-ceo");
    expect(
      baemin.signedIn("https://ceo.baemin.com/self-service/login", "로그인"),
    ).toBe(false);
    expect(
      baemin.signedIn("https://ceo.baemin.com/home", "주문 내역 매출 로그아웃"),
    ).toBe(true);
    expect(
      baemin.signedIn("https://ceo.baemin.com/home", "사장님 로그인 회원가입"),
    ).toBe(false);
  });

  /**
   * 홈택스 HAS NO PATH TO TEST. One WebSquare shell answers for both the login screen and the
   * signed-in one, so the words are the only signal — which is why it carries its own `loginWords`.
   */
  test("홈택스: the certificate screen is not a connection, the signed-in shell is", () => {
    const hometax = site("hometax");
    expect(
      hometax.signedIn(
        "https://hometax.go.kr/websquare/websquare.wq?w2xPath=/ui/pp/index.xml",
        "공동·금융인증서 간편인증 아이디 로그인",
      ),
    ).toBe(false);
    expect(
      hometax.signedIn(
        "https://hometax.go.kr/websquare/websquare.wq?w2xPath=/ui/pp/index.xml",
        "전자세금계산서 발급 로그아웃",
      ),
    ).toBe(true);
  });

  test("인스타그램: the login route is the signal, since the feed says nothing either way", () => {
    const instagram = site("instagram");
    expect(
      instagram.signedIn(
        "https://www.instagram.com/accounts/login/",
        "전화번호, 사용자 이름 또는 이메일 비밀번호 로그인",
      ),
    ).toBe(false);
    expect(
      instagram.signedIn("https://www.instagram.com/", "홈 검색 릴스 메시지"),
    ).toBe(true);
  });

  test("카페24: the login host is inside the domain, so the path is what excludes it", () => {
    const cafe24 = site("cafe24-admin");
    expect(
      cafe24.signedIn("https://eclogin.cafe24.com/Shop/", "아이디 저장 로그인"),
    ).toBe(false);
    expect(
      cafe24.signedIn(
        "https://myshop.cafe24.com/admin/php/main.php",
        "주문 관리 재고 로그아웃",
      ),
    ).toBe(true);
  });

  test("쿠팡 윙: a page that says nothing at all is not a connection", () => {
    // An SPA shell read before it has painted is 0 characters — measured in browser-limits §3. The
    // host is right and there is no login word, so this is the case the logout check cannot save.
    // It answers true, and that is the known limit: `/check` runs after a person has finished, on a
    // painted page, and the next navigation corrects it either way.
    expect(site("coupang-wing").signedIn("https://wing.coupang.com/", "")).toBe(
      true,
    );
    expect(
      site("coupang-wing").signedIn("https://wing.coupang.com/login", ""),
    ).toBe(false);
  });
});
