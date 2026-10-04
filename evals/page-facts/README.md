# Page facts: an independently labelled set

`pages.jsonl` holds 289 web pages, each recorded as the Bot's `/navigate` reads it and labelled by
hand. It is the data for an `eval:page-facts`: the gate in section 6 ("Phase 1") of
`~/laf/docs/jev-browser-use-2026-10-04.md` (a private document). That gate asks whether a page is
unusable for what it was opened for, from its title and the first 600 characters of its text.

**Labeller:** an independent labeller (Opus 5.5 subagent, 2026-10-04). I never saw the wording of
the questions that design asks a model or the earlier author's labels, and I called no model to label
anything. Every label comes from looking at the page the way a person would.

## What is in it

| | pages |
| --- | ---: |
| all | 289 |
| `unusable` | 158 |
| ↳ served with a status below 400 ("soft") | 80 |
| ↳ ↳ not a sign-in wall and not a CAPTCHA | 59 |
| ↳ served with 400 or above | 78 |
| usable | 131 |
| ↳ `hardGood` (looks like an error, is the content) | 47 |
| `signInWall` | 17 |
| `captcha` | 7 (2 of them demos that were asked for) |
| `cookieNotice` | 9 |
| `fromEarlierSet` (the 38 pages of the earlier, author-labelled set, captured again) | 38 |

The hard good pages include 8 sign-in pages and 2 CAPTCHA demos that were asked for; without them
there are 37. Language of what the reader returned (`lang`): Korean 225, English 61, German 2,
French 1. Confidence: 3 on 269 pages, 2 on 20, 1 on none.

`kind` by `unusable` and by status:

| `kind` | unusable, status < 400 | unusable, status ≥ 400 | usable |
| --- | ---: | ---: | ---: |
| `content` | | | 121 |
| `not-found` | 43 | 52 | |
| `blocked` | 1 | 22 | |
| `error` | 12 | 3 | |
| `maintenance` | 1 | | |
| `sign-in` | 17 | | 8 |
| `captcha` | 4 | 1 | 2 |
| `other` | 2 | | |

No page is `empty-shell` at `/navigate` timing (see "Timing" below).

Statuses: 200 ×209, 404 ×50, 403 ×21, 500 ×3, 400 ×2, 202 ×2, 418 ×1, 401 ×1.

Most pages are Korean:

- government portals and agencies: 정부24, 홈택스, 국세청, 국가법령정보센터, 고용노동부, 정책브리핑, 기업마당,
  K-Startup, 4대보험, 최저임금위원회, and city and district sites;
- portals and commerce: Naver, Daum, Kakao, 쿠팡, G마켓, 11번가, YES24, 알라딘, 교보, 무신사, 당근, 토스증권,
  배민.

The rest are English sites and a few European ones.

Unusable candidates were made by asking for addresses that do not exist: an unknown id, a missing
parameter, a wrong path. That is how a Bot meets them, through a stale link or a guessed address. A
candidate is not a label; each page was labelled by what came back.

## Fields

| field | meaning |
| --- | --- |
| `id` | Stable slug. The 38 earlier pages keep their earlier slugs (`ko-…`, `en-…`, `nf-…`). |
| `lang` | Language of the title and the first 600 characters (`ko`, `en`, `de`, `fr`). |
| `asked` | What the person wanted when the address was opened. `unusable` is judged against this. |
| `requestedUrl` | The address opened. |
| `finalUrl` | `page.url()` when the read ended. The query is dropped when it carries a key the request did not (tokens, session ids, challenge answers); `finalUrlQueryStripped` says so. |
| `status` | `response.status()` of the `goto`, as `navigation.ts` reads it. A page that alerts and then sends the tab elsewhere by script keeps its first document's status. |
| `redirects` | HTTP redirects before that document. |
| `title` | `titleOf()`, read when `/navigate` reads it. It is empty when a next document is already on its way. |
| `textLength` | Length of the reader's text in UTF-16 code units, as the product counts (its cap is 6,000). |
| `head600` | The first 600 code units of that text. Cut to 120 on news and magazine articles; see "Bounds". |
| `articleBodyCut` | Present on the five article rows whose `head600` was cut to 120 and whose `text` was dropped. |
| `text` | The whole text, where "Bounds" allows it. |
| `reader` | The reader took an article out of the page (Readability) rather than all of it. |
| `passwordFields` | `input[type=password]` across all frames. |
| `dialogs` | Alerts and confirms the page raised, with their words. The product reports these as `laf:dialog` notes beside the text. |
| `capturedAt` | The first capture, which the labels were first made on. |
| `recapturedAt` | The capture that every other field of the row comes from. |
| `fromEarlierSet` | One of the 38 pages of the earlier set. |
| `unusable`, `signInWall`, `captcha`, `cookieNotice`, `kind`, `confidence`, `note` | The label (rubric below). |
| `hardGood` | Usable, but looks like an error to a quick reader: an article about 404s, a search with no results, a login page that was asked for, a page whose text is nearly empty. |
| `decidingIn`, `decidingAt` | Where the fact that decided the label is: `text` with the offset of the deciding words in the reader's text; `title`, `dialog`, `screen` (only visible on the screen) or `empty` with -1. |

## The rubric

- `unusable`: if a person asked their assistant to open this address for its content, is what came
  back **not** that content? That covers a real 404, a block, an error, an empty shell and
  maintenance. A sign-in wall and a CAPTCHA are each their own flag and also count as `unusable`.
- `signInWall`: the page's main content is a sign-in form standing between the person and what
  they asked for.
- `captcha`: a robot check or CAPTCHA.
- `cookieNotice`: a consent overlay is present; the page may still be usable.
- `kind`: `content | not-found | blocked | error | maintenance | empty-shell | sign-in | captcha | other`.
- `confidence`: 1 to 3, 3 being obvious.
- `note`: one line of why.

I applied it the same way on every page:

- **Intent first.** A sign-in page that was asked for ("open Naver's sign-in page") is usable, with
  `signInWall` false and `kind` `sign-in`. A CAPTCHA demo that was asked for is usable with `captcha`
  true and `kind` `captcha`. The same login form reached while asking for mail is a wall.
- **`kind` says why an unusable page is unusable**, and what a usable page is (`content`, or
  `sign-in` / `captcha` when that page itself was asked for).
- **`not-found`** covers every "what you asked for is not here":
  - deleted posts and unknown ids;
  - a menu frame around "콘텐츠를 준비중입니다";
  - "the site was reorganised and this page moved";
  - an alert saying the item does not exist;
  - a silent redirect to a home page (an unknown webtoon, stock or profile).
- **`error`** is a page saying something failed ("기술적인 문제로", "프로그램 오류", "요청에 실패했습니다"),
  even when a wrong address caused it.
- **`blocked`** is a refusal of this browser: Akamai, DataDome and the like, or a device block.
- **`maintenance`** is a page saying the system is being worked on.
- **`other`** is two signed-out pages that are neither a form nor an error: a calendar that becomes
  its marketing page, and a "my page" shell showing 0원 and 0 coupons.
- **`cookieNotice`** was set from the text and from the screenshots of pages where a banner was
  likely. It is the least complete flag: a page whose screenshot I did not open may have a banner that
  is not recorded.

## How it was captured

**Every row follows `/navigate` in `agent-computer/src/navigation.ts`**, step for step and with no
pause of its own:

1. On a new tab, arrivals are followed and dialogs answered as `page-watch.ts` lines 27–52 do: alerts
   accepted, confirms dismissed, every dialog recorded.
2. `page.goto(url, { waitUntil: "domcontentloaded", timeout })`, as on lines 337–341. The timeout is
   30 s, the default `NAVIGATION_TIMEOUT_MS` in `config.ts`.
3. `readSettledPageText(page, { settleFirst: true })`, as on lines 390–392.
4. `page.url()`, then `titleOf(page)` unless the text says a document is arriving, as on lines
   401–402.
5. `response.status()`, as on lines 413–415.

The functions are imported from the repository: `page-text.ts`, `page-arrival.ts`, `profiles.ts`.
The browser uses the product's settings:

- Playwright 1.62.1's headless Chromium 151.0.7922.34;
- viewport 1280×800, locale `ko-KR`, time zone `Asia/Seoul`;
- the user agent from `botUserAgent()` (`… Chrome/151.0.0.0 …`).

**Unlike the product**, every page had a fresh browser context, with no cookies carried from page to
page, so consent banners show as on a first visit; and the capture set `acceptDownloads: false`, where the
product accepts downloads into the Bot's workspace (`agent-computer/src/profiles.ts`, `page-watch.ts`) — no
page in the set offered one, so no row is affected. Nothing went through the server gateway or the
egress guard.

One page at a time, at least 1.5 s between two requests to the same host. Nobody signed in, nothing
was typed, and no CAPTCHA was answered.

The rows come from the recapture, 2026-10-04 18:38–18:58 KST (`recapturedAt`). It was taken from a
residential connection in Korea (Cloudflare reports `loc=KR`), **not from a fleet VM**. The VMs browse
from Osaka, so blocks they meet abroad are not all here. 정부24's block here is not a geographic one:
it says "현재 접속하신 단말에서는 접속이 불가능합니다" from Korea.

A screenshot was taken after every read and looked at whenever the text was short, empty or odd, or
a dialog fired. Screenshots are not committed, because they can show the visitor's address.

## Timing

The labels were first made on a capture taken 17:17–18:10 KST (`capturedAt`). That capture waited
2.5 s after `domcontentloaded` before reading; `/navigate` does not. Every page was then captured
again with the `/navigate` sequence above, and every row now holds the recapture.

- `head600` differs on 82 pages. On almost all of them only rotating content moved: headlines, ads,
  times, Akamai and DataDome reference ids.
- On three pages the reading itself changed, and their labels were re-checked:
  - `ko-zigbang-item-bogus` reads "매물 정보를 찾을 수 없습니다" at `/navigate` time. 2.5 s later the tab
    was on `about:blank`. Its kind changed from `empty-shell` to `not-found`.
  - `en-imdb-title-bogus` (202) has no title, no text and a blank screen at `/navigate` time. 2.5 s
    later it showed "Let's confirm you are human". It is still `captcha`, now decided by `empty`,
    and its confidence dropped from 3 to 2.
  - `ko-yna-art-bogus` has the not-found words in its text at `/navigate` time. 2.5 s later the
    reader's article mode had replaced them with a quiz and an ad block. It is now decided by `text`.
- The deciding words were re-pointed on three usable pages: Glassdoor's home now redirects to its
  /recruiter landing, Walmart's words moved, and a line break fell inside Melon's.
- Titles: on 10 pages `titleOf` returns nothing at `/navigate` time where 2.5 s later there was a
  title. Pages with no title went from 15 to 24.
- No label changed `unusable`, `signInWall`, `captcha` or `cookieNotice`.
- Median time to read: 1.6 s (it was 3.1 s with the pause).

## Bounds, because this repository is public

- **News and magazine articles:** `title` is kept, `head600` is cut to its first 120 characters, and
  `text` is dropped (`articleBodyCut`). That applies to the five single articles: three Naver news
  articles (Yonhap 2000, 뉴시스, 매일경제), one 연합뉴스 article, and one 정책브리핑 press release.
  `decidingAt` still counts into the reader's whole text.
- **Every other usable page** keeps `head600` and has `text` only when `textLength` ≤ 600. The eval
  reads the title and `head600`; the longer text was a convenience. That dropped the text of 20 rows
  that had it.
- **Unusable pages** keep `head600`, and `text` whenever it is 1,500 characters or less. A 404 page's
  words are nobody's article.
- 159 rows carry `text`.
- IPv4 addresses in titles, text and dialogs are replaced with `[ip]`, because block pages print the
  visitor's address. `;jsessionid=` values are replaced too.

## What the set shows

Measured on these 289 pages at `/navigate` timing. None of it is a verdict on any model.

- **Every page served with 400 or above is unusable** (78 of 78). The status rule is never wrong when
  it fires, but it misses 80 unusable pages.
- **15 of the 80 soft unusable pages cannot be decided from their text at all.**
  - 6 say so only in an alert (`dialogs`). Four then leave the tab on `about:blank` and two on a home
    page.
  - 8 say so only on the screen.
  - 1 is blank: the IMDb challenge before it draws.

  The other 65 are decided by words inside the first 600 characters; none needed more.
- **The reader returns a footer for whole pages.**
  - Zillow's press-and-hold robot check, 컬리's "해당 상품은 구매가 어려워" and 무신사's whole home page all
    come back as a legal footer (`en-zillow-home`, `ko-kurly-goods-bogus`, `ko-musinsa-home`).
  - Pages whose message is an image read as one word or nothing: `ko-law-lsinfo-seq9` reads
    "법령", and `ko-mapo-badpath` and `ko-work24-badpath` read as empty.
- **Length.** 69 of the 80 soft unusable pages are 1,500 characters or less. The 11 longer ones are:
  - an alert followed by a home page (2);
  - a silent redirect to another page (4);
  - signed-out pages (3, one of them a login form with a long footer);
  - the 연합뉴스 not-found page and Zillow's challenge.

  7 of the 11 cannot be decided from their text anyway. 39 of the 131 usable pages (22 of the 47 hard
  good ones) are 1,500 characters or less.
- **Password fields.** 31 pages have one, and 17 of them are sign-in walls. The other 14 are:
  - eight sign-in pages that were asked for;
  - 홈택스's main page, twice (its login panel);
  - a 문체부 notice;
  - three not-found pages with a login box in the header (Facebook, Pinterest, SoundCloud).
- **The earlier set.** Of its 38 pages, 6 are labelled differently from a plain reading of their
  status code:
  - `nf-law-table`: an error page served with 200;
  - `nf-nts`: "준비중", served with 200;
  - `ko-gov24`: blocked, served with 200;
  - `ko-kakao-login`: the sign-in address lands on an error page, served with 200;
  - `nf-smartstore-shop` and `ko-naver-mail`: sign-in walls served with 200.

  `nf-naver-news-article` is not missing at all: that id is a real Yonhap article from 2000.

## Not in the set

- `https://www.work24.go.kr/` and `https://www.ei.go.kr/thisPageIsNotThere.do`: the reader threw
  `undefined is not an object (evaluating 'main.read.text')`, in both captures. On work24.go.kr every
  `page.evaluate` that returns an object returns `undefined`, though a number comes through. So
  `readablePageText` has nothing to read. That is the product's reader failing on 고용24, not a page
  fact.
- `saramin.co.kr` job page: it did not reach `domcontentloaded` in 25 s, nor in 30 s.
- Four services whose hosts no longer resolve: 망고플레이트, 다음 tv팟, 다음 아고라, cyworld.com. A DNS
  failure is a navigation error, not a page.
