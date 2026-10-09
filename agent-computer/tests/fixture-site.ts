/**
 * One Korean page with everything the Bot's browser used to fall over.
 *
 * A fixture rather than a real site, and served from here rather than fetched: the sites this was
 * measured against — 스마트스토어, 네이버, 홈택스, 배민 — change every week, sign nobody in, and cannot
 * be part of a test that has to pass at three in the morning. What they had in common is here: a
 * `target=_blank` link, an alert, a confirm, a file input, a download, a same-origin iframe with the
 * real content in it, a password box, and a mega-menu that is in the markup and not on the screen.
 *
 * The measurements against the real sites live in `docs/laf/browser-limits.md`, taken by hand.
 *
 * THE JOB PAGES ARE FILES, under `fixtures/`. The four jobs the launch plan measures (리뷰 답글,
 * 문의·예약, 아침 브리핑, 정산·재고) each open a page shaped like a real seller portal, and those
 * pages are long enough that a template string here would bury the one page that matters. Each is
 * served at `/sites/<name>`; a `-quiet` sibling, where one exists, is what the same address serves
 * once `setQuiet(true)` has been called — the morning on which nothing came in, at the same URL a
 * routine would open on any other morning. No real customer's data is in any of them. Two files
 * there are not job pages and are not on that list: the form sent by GET and the page it lands on,
 * served at `/get-form` and `/landed`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The words that are actually on the screen. If a read does not contain these it read nothing. */
export const VISIBLE_TEXT = "오늘 주문 3건";

/** In the markup, `display:none`, and 2,000 characters wide. A read that includes this is a bug. */
export const HIDDEN_MENU_TEXT = "숨은메가메뉴";

/** Inside the same-origin iframe, which is where a Korean site keeps its content. */
export const FRAME_TEXT = "세금계산서 목록";

/**
 * A control inside that iframe.
 *
 * Here to answer a question the snapshot's own comment used to assert without measuring: whether
 * Playwright's aria snapshot descends into frames. The test says what it found.
 */
export const FRAME_BUTTON = "프레임 안 버튼";

/** What that button writes into the frame, so a click on it can be seen from outside. */
export const FRAME_CLICKED = "프레임 버튼 눌림";

export const DOWNLOAD_NAME = "정산내역.csv";
/**
 * OVER A MEGABYTE, ON PURPOSE: about two. A download used to be held to what a Bot may write in
 * one call, so the ordinary statement a seller's site hands over was written, measured, deleted
 * and reported as too large — and this fixture's two lines never showed it. A page's download is
 * bounded by the disk now (`agent-computer/src/workspace.ts`), and this is the real browser
 * landing one that the old bound refused.
 */
export const DOWNLOAD_BODY = `날짜,금액\n${"2026-09-01,12000\n".repeat(120_000)}`;

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

/** The cookie `/sign-in` sets and `/whoami` reads. A real login on a real site is this, with steps. */
export const SESSION_COOKIE = "laf_fixture_session";

/** What `/whoami` puts on the page when nobody is signed in. Measured against, so it is exported. */
export const SIGNED_OUT_TEXT = "로그인해 주세요";

/** What it says when somebody is. The name follows, so a read says WHOSE session the browser holds. */
export const signedInAs = (who: string): string => `로그인됨: ${who}`;

const SIGNED_IN_HTML = (who: string) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>로그인 완료</title></head><body><h1>${signedInAs(who)}</h1></body></html>`;

const WHOAMI_HTML = (who: string | null) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>내 정보</title></head><body><h1>${who ? signedInAs(who) : SIGNED_OUT_TEXT}</h1></body></html>`;

/**
 * The pages under `fixtures/`, by the name they are served under at `/sites/<name>`.
 *
 * Listed rather than globbed so a test can walk them and a typo in a URL is a failing test rather
 * than a 404 the Bot reads as "the site is down".
 */
export const JOB_PAGES = [
  "smartplace-reviews",
  "smartstore-enquiries",
  "smartstore-orders",
  "smartstore-stock",
  "booking-tomorrow",
  "baemin-settlement",
  "naver-id-login",
  "smartstore-login",
  "baemin-login",
] as const;

export type JobPage = (typeof JOB_PAGES)[number];

/** The pages that have a quiet morning to show. `setQuiet(true)` swaps these and only these. */
export const QUIET_PAGES: readonly JobPage[] = [
  "smartplace-reviews",
  "smartstore-enquiries",
  "smartstore-orders",
];

/** What 엑셀 다운로드 on the 정산 page hands over: the same five rows, as a real site's CSV export. */
export const SETTLEMENT_CSV_NAME = "정산내역_20260901-20260906.csv";
export const SETTLEMENT_CSV_BODY = [
  "정산일,주문건수,주문금액,배달팁,중개이용료,결제수수료,입금예정액,입금액,입금일,상태",
  "2026-09-05,38,412000,76000,-27720,-13290,371300,356300,2026-09-06,입금완료",
  "2026-09-04,31,335500,62000,-22570,-10830,302100,302100,2026-09-05,입금완료",
  "2026-09-03,29,301000,58000,-20240,-9720,271040,271040,2026-09-04,입금완료",
  "2026-09-02,35,388000,70000,-26100,-12530,349370,349370,2026-09-03,입금완료",
  "2026-09-01,27,276000,54000,-18560,-8910,248530,248530,2026-09-02,입금완료",
  "",
].join("\n");

const HIDDEN_MENU = Array.from(
  { length: 120 },
  (_, index) => `${HIDDEN_MENU_TEXT}${index}`,
).join(" ");

/** The page inside the iframe. Same origin, so its text is readable and must be merged in. */
const FRAME_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>프레임</title></head>
<body><h2>${FRAME_TEXT}</h2><p>9월 1일 12,000원</p>
<button type="button" id="frame-button" onclick="document.getElementById('frame-said').textContent='${FRAME_CLICKED}'">${FRAME_BUTTON}</button>
<p id="frame-said"></p></body></html>`;

const PAGE_HTML = `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>사장님 페이지</title></head>
<body>
  <nav style="display:none">${HIDDEN_MENU}</nav>
  <h1>${VISIBLE_TEXT}</h1>
  <p id="said">아직 아무 일도 없었습니다</p>
  <a id="newtab" href="/other" target="_blank">주문 상세 보기</a>
  <button id="alert" type="button" onclick="alert('로그인이 필요합니다')">알림</button>
  <button id="confirm" type="button" onclick="
    document.getElementById('said').textContent = confirm('정말 삭제하시겠습니까?') ? '삭제함' : '삭제하지 않음';
  ">삭제</button>
  <a id="download" href="/download" download="${DOWNLOAD_NAME}">정산내역 내려받기</a>
  <form>
    <label for="attach">첨부 파일</label>
    <input id="attach" type="file" onchange="
      document.getElementById('said').textContent = '올린 파일: ' + (this.files[0] ? this.files[0].name : '');
    ">
    <label for="password">비밀번호</label>
    <input id="password" type="password">
  </form>
  <iframe src="/frame" title="세금계산서" width="400" height="200"></iframe>
  <!--
    What a site sees when the Bot arrives, printed onto the page.

    Read through the product's own /read rather than asserted against the launch options: the
    options are a claim, and this is the thing that is actually true of the browser.
  -->
  <p id="agent"></p>
  <script>
    document.getElementById("agent").textContent = [
      "언어=" + navigator.language,
      "시간대=" + Intl.DateTimeFormat().resolvedOptions().timeZone,
      "브라우저=" + navigator.userAgent,
    ].join(" ");
  </script>
</body>
</html>`;

const OTHER_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>주문 상세</title></head>
<body><h1>주문 상세 화면</h1></body></html>`;

/** A control on the page whose second frame never loads, so a look can be seen to have read the page. */
export const HANGING_FRAME_PAGE_BUTTON = "주문하기";

/**
 * A page with two frames: the same-origin frame that loads (`/frame`, with {@link FRAME_BUTTON} in it)
 * and one whose request is accepted and never answered (`/hang`) — a payment window or a 본인인증
 * panel behind a load balancer that has stopped answering. Served at `/hanging-frame`.
 *
 * Until 2026-09-14 a snapshot of this page never came back (W3-c): the look waited on the frame
 * that never arrives, for ever, and the Bot's turn with it.
 */
const HANGING_FRAME_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>결제</title></head>
<body>
  <h1>${VISIBLE_TEXT}</h1>
  <button type="button">${HANGING_FRAME_PAGE_BUTTON}</button>
  <iframe src="/frame" title="세금계산서" width="400" height="200"></iframe>
  <iframe src="/hang" title="결제창" width="400" height="200"></iframe>
</body></html>`;

/** What the box in the late frame already holds. A look that shows it has shown a secret. */
export const LATE_FRAME_SECRET = "LATE-FRAME-SECRET-4455";

/** The late frame's button, and what pressing it writes into the frame. */
export const LATE_FRAME_BUTTON = "결제 진행";
export const LATE_FRAME_CLICKED = "결제창 버튼 눌림";

/**
 * The page of a frame that arrives late: served at `/late-frame` only once `releaseLateFrames()` is
 * called, so a test decides the moment it arrives.
 *
 * Two secret boxes nothing but the markup marks: one holding {@link LATE_FRAME_SECRET} under a name
 * no secret-word list carries, and one with no name and no value, which only the join by ref can
 * mark. And a button, so a ref from the late frame can be seen to still work after the look.
 */
const LATE_FRAME_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>결제창</title></head>
<body>
  <input type="password" aria-label="간편결제" value="${LATE_FRAME_SECRET}">
  <input type="password">
  <button type="button" onclick="document.getElementById('late-said').textContent='${LATE_FRAME_CLICKED}'">${LATE_FRAME_BUTTON}</button>
  <p id="late-said"></p>
</body></html>`;

/** The box on `/to-hang` a person types a secret into, by the name it reaches the tree with. */
export const TO_HANG_PIN = "간편 확인 칸";

/**
 * A page whose every way out leads to `/hang`: a form sent by GET, a link, and a link to a new tab —
 * and a link that opens this same page in a new tab, for a tab this process has adopted to be sent
 * nowhere from. Served at `/to-hang`.
 *
 * THE FORM PUTS ITS BOX IN THE ADDRESS. A GET form sends every field in the query, a password box
 * included, so the navigation it starts carries the person's secret in its URL for as long as the
 * site does not answer — and until 2026-09-14 a tab mid-navigation was listed under Playwright's
 * `Loading <that address>`. The box is marked by nothing but its type, under a name no secret word
 * matches, so what keeps its value out of a look is the look, not the vocabulary.
 */
const TO_HANG_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>결제 전 확인</title></head>
<body>
  <h1>${VISIBLE_TEXT}</h1>
  <form action="/hang" method="get">
    <input type="password" name="pin" aria-label="${TO_HANG_PIN}">
    <button type="submit">확인</button>
  </form>
  <a id="hang-link" href="/hang">결제창 열기</a>
  <a id="hang-tab" href="/hang" target="_blank">결제창 새 탭</a>
  <a id="self-tab" href="/to-hang" target="_blank">이 화면 새 탭</a>
</body></html>`;

/** The label the relabel button starts with, and the money word it becomes. See `/relabel`. */
export const RELABEL_BEFORE = "저장";
export const RELABEL_AFTER = "결제하기";

/**
 * A button that keeps its node and its ref but swaps its own text after `after` ms, and records
 * which label was showing when it was pressed. The TOCTOU the money-word rule has to survive: the
 * snapshot sees 저장, the click lands on 결제하기, the same ref throughout.
 */
function relabelHtml(after: number, hide: boolean): string {
  // `hide` keeps the label and takes the button out of sight instead: a control that is no longer
  // there to press, which is not the same fact as one that is called something else.
  const change = hide
    ? "document.getElementById('act').style.display = 'none';"
    : `document.getElementById('act').textContent = ${JSON.stringify(RELABEL_AFTER)};`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>재라벨</title></head>
<body>
  <h1>${VISIBLE_TEXT}</h1>
  <button id="act" type="button" onclick="document.title = '눌림:' + this.textContent">${RELABEL_BEFORE}</button>
  <script>
    setTimeout(function () {
      ${change}
    }, ${after});
  </script>
</body></html>`;
}

/**
 * Links whose names the AI tree prints beneath them rather than beside them, by the name the list
 * gives each — the name the page computes (`page-names.ts`), which is the role engine's: a headline in
 * a `<strong>` (Naver news's shape), words split across inline elements that the browser joins with
 * no space, an image's alt text, a decoration hidden from the accessibility tree that the tree prints
 * anyway (`- text: ★`), and a table named by a caption only a screen reader is given (Naver home's
 * calendar link).
 */
export const HEADLINE_LINKS = {
  headline: "오늘의 헤드라인 기사",
  split: "무선마우스 특가",
  image: "프리미엄 바로가기",
  decorated: "별 달린 헤드라인",
  caption: "이달의 일정표",
} as const;

/** What the tree's own words would have called two of them, and the browser does not. */
export const HEADLINE_TREE_NAMES = {
  split: "무선 마우스 특가",
  decorated: "★ 별 달린 헤드라인",
} as const;

/**
 * A button around a search box, and the word on the button: the browser names the button by what is
 * typed in the box as well, and the list never does (`page-names.ts`).
 */
export const BOXED_BUTTON = { word: "찾기", box: "검색어" } as const;

/** A 1×1 PNG: an image has to be drawn to be given a ref. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const HEADLINES_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>헤드라인</title>
<style>.blind{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style></head>
<body>
  <h1>${VISIBLE_TEXT}</h1>
  <p><a href="/landed-headline"><strong>${HEADLINE_LINKS.headline}</strong></a></p>
  <p><a href="/landed-split"><mark>무선</mark>마우스 <strong>특가</strong></a></p>
  <p><a href="/landed-image"><img src="${PIXEL}" width="80" height="40" alt="${HEADLINE_LINKS.image}"></a></p>
  <p><a href="/landed-decorated"><span aria-hidden="true">★</span> <strong>${HEADLINE_LINKS.decorated}</strong></a></p>
  <div><a href="/landed-caption"><table><caption class="blind">${HEADLINE_LINKS.caption}</caption><tr><td><b>1</b></td><td><b>2</b></td></tr></table></a></div>
  <p><button type="button" onclick="document.title = '찾음'"><input aria-label="${BOXED_BUTTON.box}"> <strong>${BOXED_BUTTON.word}</strong></button></p>
</body></html>`;

/**
 * The fields of the auditor's login page, by the accessible name each reaches the tree with, and
 * what — if anything — marks it as a secret in the markup.
 */
export const PW_FIELDS = {
  /** `<input type="password" aria-labelledby="패스워드">` — the auditor's box, exactly. */
  labelledby: "패스워드",
  /** `type="text"`, named by `aria-label` with no secret word, marked only by `current-password`. */
  currentPassword: "로그인 키",
  /** `type="password"` named by nothing but its placeholder, a word no list carries. */
  placeholder: "PIN4",
  /** `type="text"`, a placeholder, and the `one-time-code` token as its only mark. */
  oneTimeCode: "6자리",
  /** An ordinary field: a `<label for>` and nothing else. */
  plain: "아이디",
  /** Unmarked and unnamed as a secret, and RENAMED the moment anything is typed into it. */
  renames: "사번",
  /** What `renames` is called once it has a value. */
  renamed: "사번 (확인됨)",
} as const;

/**
 * The auditor's page, served at `/pw`.
 *
 * A password box whose ONLY label is `aria-labelledby` — which `HTMLInputElement.labels` does not
 * see — under a word (패스워드) that was in no secret-word list. Measured 2026-09-10 in the
 * published container and in main: the value a person typed through the secret request rode out on
 * the very next snapshot. Beside it, one field for every other way a page names or marks a secret
 * box — `aria-label`, a placeholder, `autocomplete="current-password"`, the `one-time-code` token —
 * and one it neither names nor marks, which renames itself on input the way a validating form does.
 * None of them is exotic; this is what Korean login pages look like.
 */
const PW_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>로그인</title></head>
<body>
  <h1>로그인</h1>
  <form>
    <label for="uid">${PW_FIELDS.plain}</label>
    <input id="uid" type="text">
    <span id="${PW_FIELDS.labelledby}">${PW_FIELDS.labelledby}</span>
    <input type="password" aria-labelledby="${PW_FIELDS.labelledby}">
    <input type="text" autocomplete="section-login current-password" aria-label="${PW_FIELDS.currentPassword}">
    <input type="password" placeholder="${PW_FIELDS.placeholder}">
    <input type="text" autocomplete="one-time-code" placeholder="${PW_FIELDS.oneTimeCode}">
    <input type="text" aria-label="${PW_FIELDS.renames}" oninput="this.setAttribute('aria-label', '${PW_FIELDS.renamed}')">
    <button type="button">로그인</button>
  </form>
</body></html>`;

/** What `/swap` calls its one box, and the three buttons beside it. */
export const SWAP = {
  box: "회사 비밀번호",
  /** What the box is called once 바꾸기 has been pressed: a box for something else. */
  swapped: "댓글",
  rename: "바꾸기",
  remove: "지우기",
  /** A second box, which turns into a comment box the moment it is focused. */
  onFocus: "출입 비밀번호",
  /** What that one is called once anything has focused it. */
  focused: "한마디",
} as const;

/**
 * A page that changes what its password box IS after it has been looked at, served at `/swap`.
 *
 * One press and the box a person was asked to type a password into is a comment box — the same
 * node, so a ref from before still finds it — and another press and it is gone. Nothing here is
 * exotic either: a login form that turns into a search box when a tab is switched does the first,
 * and any page that re-renders does the second. A second box does the first by itself, the moment
 * anything focuses it — which filling it does. What a value a person types is held to, when it
 * arrives after any of that, is `supplySecret`'s (`control-routes.ts`).
 */
const SWAP_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>로그인</title></head>
<body>
  <h1>로그인</h1>
  <input id="box" type="password" aria-label="${SWAP.box}">
  <button type="button" onclick="const b=document.getElementById('box');b.type='text';b.setAttribute('aria-label','${SWAP.swapped}')">${SWAP.rename}</button>
  <button type="button" onclick="document.getElementById('box').remove()">${SWAP.remove}</button>
  <input type="password" aria-label="${SWAP.onFocus}" onfocus="this.type='text';this.setAttribute('aria-label','${SWAP.focused}')">
</body></html>`;

/** What `/card` calls its three boxes and its two buttons. */
export const CARD = {
  id: "아이디",
  password: "비밀번호",
  /**
   * A third box that nothing marks as a secret — not its type, not its name. What a person put
   * in it is blanked from the next look only because the box itself is remembered.
   */
  again: "메모",
  /** Renames the third box, now: what a page that re-rendered while a person typed has done. */
  rename: "확인 칸 바꾸기",
  /** Arms the page: from then on, anything put in the first box renames the second. */
  follow: "따라 바뀌게",
  /** What a renamed box is called. */
  changed: "한마디",
  /** How the page says what is in its boxes: three lengths, and nothing of the values. */
  lengths: (id: number, password: number, again: number) =>
    `칸에 든 글자 수 ${id}/${password}/${again}`,
} as const;

/**
 * A form of three boxes that one card asks for at once, served at `/card` (2026-10-10).
 *
 * It says how long the value in each box is and nothing else — which is how a test knows each
 * value went into its own box, in order, without the page ever showing one (a box a person's value
 * went into reads as empty from then on, by design). Its two buttons are the two ways a page is
 * not what a card said by the time the values arrive: a box renamed before the person pressed, and
 * a box renamed BY the box before it being filled — which no look at the page beforehand can see.
 */
const CARD_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>가입</title></head>
<body>
  <h1>가입</h1>
  <input id="id" type="text" aria-label="${CARD.id}">
  <input id="pw" type="password" aria-label="${CARD.password}">
  <input id="again" type="text" aria-label="${CARD.again}">
  <p id="lengths">${CARD.lengths(0, 0, 0)}</p>
  <button type="button" onclick="rename('again')">${CARD.rename}</button>
  <button type="button" onclick="following=true">${CARD.follow}</button>
  <script>
    let following = false;
    const box = (id) => document.getElementById(id);
    function rename(id) { box(id).type = 'text'; box(id).setAttribute('aria-label', '${CARD.changed}'); }
    function say() {
      box('lengths').textContent = '칸에 든 글자 수 ' + ['id', 'pw', 'again'].map((id) => box(id).value.length).join('/');
    }
    for (const id of ['id', 'pw', 'again']) box(id).addEventListener('input', say);
    box('id').addEventListener('input', () => { if (following) rename('pw'); });
  </script>
</body></html>`;

/** What `/shown-back` calls its two boxes and its two buttons, and what it says once signed in. */
export const SHOWN_BACK = {
  id: "아이디",
  password: "비밀번호",
  /** Signs in: the page takes its boxes away and writes both values where a page writes things. */
  signIn: "로그인",
  /** Opens a second tab that says the same. */
  receipt: "확인서 새 창",
  said: "로그인했습니다",
} as const;

/**
 * A sign-in that shows back what it was given, served at `/shown-back` (2026-10-10, record §6).
 *
 * WHAT A LOOK'S OWN BLANKING CANNOT REACH. A box a person's value went into reads as empty because
 * the box is remembered, and an address is blanked by what a form writes into its query. This page
 * leaves neither to find: on 로그인 it removes both boxes, then writes the values into its text, its
 * title and the PATH of its address. 확인서 새 창 opens a second tab that takes them from the first
 * and says them again — a tab no value was ever put into.
 */
const SHOWN_BACK_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>로그인</title></head>
<body>
  <h1>로그인</h1>
  <input id="id" type="text" aria-label="${SHOWN_BACK.id}">
  <input id="pw" type="password" aria-label="${SHOWN_BACK.password}">
  <button type="button" onclick="signIn()">${SHOWN_BACK.signIn}</button>
  <button type="button" onclick="window.open('/shown-back-receipt')">${SHOWN_BACK.receipt}</button>
  <p id="said"></p>
  <script>
    var who = '', pass = '';
    const box = (id) => document.getElementById(id);
    function signIn() {
      who = box('id').value; pass = box('pw').value;
      box('id').remove(); box('pw').remove();
      document.title = who + ' 님';
      box('said').textContent = '${SHOWN_BACK.said}: ' + who + ' / ' + pass;
      history.replaceState(null, '', '/shown-back/' + encodeURIComponent(who));
    }
  </script>
</body></html>`;

const SHOWN_BACK_RECEIPT_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>확인서</title></head>
<body>
  <h1>확인서</h1>
  <p id="said"></p>
  <script>
    document.title = opener.who + ' 확인서';
    document.getElementById('said').textContent = '${SHOWN_BACK.said}: ' + opener.who + ' / ' + opener.pass;
  </script>
</body></html>`;

/** What `/saved-sign-in` calls its two boxes, and how it says what is in them. */
export const SIGN_IN = {
  id: "아이디",
  password: "비밀번호",
  /** Two lengths, and nothing of the values — how a test knows which box got which. */
  lengths: (id: number, password: number) =>
    `칸에 든 글자 수 ${id}/${password}`,
  /** What `/framed-saved-sign-in` is called: a page of one origin holding that sign-in from another. */
  framing: "다른 곳의 로그인 창",
} as const;

/**
 * A sign-in of two boxes, served at `/saved-sign-in`, for a saved login to be put into (2026-10-10,
 * record §6). It says how long each box's value is and nothing else.
 *
 * `/framed-saved-sign-in?from=<origin>` is a page that holds it in a frame FROM ANOTHER ORIGIN — this
 * fixture answers on `127.0.0.1` and on `localhost`, which are two origins to a browser. A saved
 * login belongs to the document its boxes are in, which there is not the page the tab is on.
 */
const SIGN_IN_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>로그인</title></head>
<body>
  <h1>로그인</h1>
  <input id="id" type="text" aria-label="${SIGN_IN.id}">
  <input id="pw" type="password" aria-label="${SIGN_IN.password}">
  <p id="lengths">${SIGN_IN.lengths(0, 0)}</p>
  <script>
    const box = (id) => document.getElementById(id);
    function say() {
      box('lengths').textContent = '칸에 든 글자 수 ' + box('id').value.length + '/' + box('pw').value.length;
    }
    for (const id of ['id', 'pw']) box(id).addEventListener('input', say);
  </script>
</body></html>`;

const framedSignIn = (from: string) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${SIGN_IN.framing}</title></head>
<body>
  <h1>${SIGN_IN.framing}</h1>
  <iframe src="${from}/saved-sign-in" title="로그인" width="400" height="200"></iframe>
</body></html>`;

/**
 * The box on `/get-form` (`fixtures/get-form.html`), by the name the tree gives it.
 *
 * THE BOX'S VALUE LEAVES IN THE ADDRESS. A GET form puts every field in the query, so the page it
 * lands on is `/landed?step=2&pin=<what was typed>` — and that address was on every result the Bot
 * was handed afterwards (audit R3-03: `/key`, the next snapshot's `url` and `tabs`, `/read`).
 * `/to-hang` has the same form for a page that never arrives; this one arrives at once
 * (`fixtures/landed.html`) and says nothing about what it was sent. `step` is a value nobody typed,
 * which has to survive.
 */
export const GET_FORM_BOX = { name: "간편 확인 값" } as const;

/** What `/landed` says: that it arrived, and nothing it was sent. */
export const LANDED_TEXT = "접수되었습니다";

/**
 * A news article inside a portal's chrome, the shape of a Naver news page (`reader.ts`): a menu, the
 * story, comments and a ranking rail. It says it is an article (`og:type`), and the story is well
 * under four fifths of the page, so a reader view takes the story out.
 */
export const ARTICLE_STORY = "동네 가게들의 가을 매출이 지난해보다 늘었다";
export const ARTICLE_MENU = "언론사별보기메뉴";
export const ARTICLE_COMMENT = "댓글을작성하려면로그인";
const ARTICLE_PARAGRAPH =
  "지역 상권 조사에 따르면 올가을 골목 상권의 카드 결제액은 지난해 같은 기간보다 눈에 띄게 늘었고, 특히 음식점과 카페의 주말 매출이 크게 올랐다. 상인들은 날씨가 선선해지면서 나들이 손님이 늘어난 것을 가장 큰 이유로 꼽았다.";
const ARTICLE_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta property="og:type" content="article"><title>가을 매출 기사</title></head><body>
<nav><ul>${Array.from({ length: 40 }, (_, i) => `<li><a href="/n${i}">${ARTICLE_MENU} ${i}</a></li>`).join("")}</ul></nav>
<article><h2>${ARTICLE_STORY}</h2>${Array.from({ length: 6 }, () => `<p>${ARTICLE_PARAGRAPH}</p>`).join("")}</article>
<aside><section><h3>댓글</h3><p>${ARTICLE_COMMENT}</p></section>
<ol>${Array.from({ length: 40 }, (_, i) => `<li><a href="/r${i}">많이 본 뉴스 제목 ${i} 번째 기사입니다</a></li>`).join("")}</ol></aside>
<footer>© 포털</footer></body></html>`;

/**
 * A page whose scripts take the builtins the reader's answer travels with.
 *
 * `Map` is 고용24's own, as work24.go.kr leaves it (measured 2026-10-04): `put`, `get`,
 * `containsKey`, no `set`. Playwright counts the objects it hands back with the page's `Map`, so on
 * that page every object an `evaluate` returned came back `undefined`, and the reader with it.
 * `JSON.stringify` and `Object.prototype.toJSON` are the next things a page could take, and the
 * reader must not lean on those either.
 */
export const REPLACED_BUILTINS_TEXT = "고용 안내 화면의 본문입니다";
export const REPLACED_BUILTINS_SCRIPT = `function Map() { this.map = new Object(); }
Map.prototype = {
  put: function (key, value) { this.map[key] = value; },
  get: function (key) { return this.map[key]; },
  containsKey: function (key) { return key in this.map; },
};
JSON.stringify = function () { throw new Error("not for you"); };
Object.defineProperty(Object.prototype, "toJSON", {
  value: function () { return "tampered"; },
  configurable: true,
  writable: true,
});`;
const REPLACED_BUILTINS_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>고용 안내</title>
<script>${REPLACED_BUILTINS_SCRIPT}</script></head><body><h1>고용 안내</h1><p>${REPLACED_BUILTINS_TEXT}</p></body></html>`;

/**
 * A page whose scripts make the reader itself throw: `document.querySelector`, which the reader asks
 * whether the page calls itself an article — before it measures the page — refuses.
 */
export const READER_BROKEN_TEXT = "판독기가 멈춰도 이 문장은 읽힌다";
const READER_BROKEN_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>막힌 판독기</title>
<script>document.querySelector = function () { throw new Error("no"); };</script></head><body>
<h1>${READER_BROKEN_TEXT}</h1>${Array.from({ length: 8 }, () => `<p>${ARTICLE_PARAGRAPH}</p>`).join("")}</body></html>`;

/**
 * Serve it, and say where.
 *
 * Port 0, so two of these can run at once — the gate is run concurrently from more than one
 * worktree, and a fixed port is how that turns into a test failure nobody can reproduce alone.
 */
export function serveFixture(port = 0) {
  const html = { "content-type": "text/html; charset=utf-8" };
  /** Whether the job pages show the morning on which nothing came in. */
  let quiet = false;
  /** Every `/hang` request still being held open. See the route. */
  const hanging = new Set<(response: Response) => void>();
  /** Every `/late-frame` request, held until `releaseLateFrames`. */
  const late = new Set<(response: Response) => void>();

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    /*
     * NEVER, NOT TEN SECONDS. Bun closes a connection that has sent nothing for ten seconds unless
     * told otherwise, and Chromium takes the close as the frame's answer and gives it an error page
     * — so `/hang` inside an iframe was a frame that arrived at ten seconds. Measured 2026-09-14: Bun
     * logged `request timed out after 10 seconds`, and a read of that frame which had been waiting
     * since the page opened answered in the same moment. A site that never answers does not do that.
     */
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path.startsWith("/sites/")) {
        const name = path.slice("/sites/".length);
        if (!(JOB_PAGES as readonly string[]).includes(name)) {
          return new Response("없는 페이지", { status: 404, headers: html });
        }
        const file =
          quiet && QUIET_PAGES.includes(name as JobPage)
            ? `${name}-quiet.html`
            : `${name}.html`;
        return new Response(Bun.file(join(FIXTURES_DIR, file)), {
          headers: html,
        });
      }
      if (path === "/downloads/settlement.csv") {
        return new Response(SETTLEMENT_CSV_BODY, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(SETTLEMENT_CSV_NAME)}`,
          },
        });
      }
      /*
       * The quiet switch over HTTP, for a run that drives this server from another process — the
       * launch-plan measurement starts it once and flips the morning between two routine runs.
       * A test in this process calls `setQuiet` directly.
       */
      if (path === "/__quiet") {
        quiet = url.searchParams.get("on") === "1";
        return new Response(JSON.stringify({ quiet }), {
          headers: { "content-type": "application/json" },
        });
      }
      /*
       * A page that never answers — the connection is accepted and then nothing is sent, which is
       * what a site behind a dead load balancer looks like to a browser. The response is released
       * when the server stops, so a test that ends mid-hang does not leave Bun waiting on it.
       */
      if (path === "/hang") {
        return new Promise<Response>((resolve) => {
          hanging.add(resolve);
        });
      }
      if (path === "/late-frame") {
        return new Promise<Response>((resolve) => {
          late.add(resolve);
        });
      }
      if (path === "/article") {
        return new Response(ARTICLE_HTML, { headers: html });
      }
      if (path === "/replaced-builtins") {
        return new Response(REPLACED_BUILTINS_HTML, { headers: html });
      }
      if (path === "/reader-broken") {
        return new Response(READER_BROKEN_HTML, { headers: html });
      }
      if (path === "/hanging-frame") {
        return new Response(HANGING_FRAME_HTML, { headers: html });
      }
      if (path === "/to-hang") {
        return new Response(TO_HANG_HTML, { headers: html });
      }
      // A navigation that ends with no document at all: the browser stays on the page it was on.
      if (path === "/no-content") {
        return new Response(null, { status: 204 });
      }
      /*
       * A SITE THAT SIGNS YOU IN AND REMEMBERS IT, which is the whole of what a shared profile is
       * for. `/sign-in?as=…` sets an EXPIRING cookie — a session cookie is dropped on restart by
       * design (profiles.ts) and would make this a test of Chromium's restart behaviour rather than
       * of whose cookie jar it is — and `/whoami` reads it back and puts the name on the page, so a
       * second Bot's `computer_read` is the measurement.
       */
      if (path === "/sign-in") {
        const who = url.searchParams.get("as") ?? "";
        return new Response(SIGNED_IN_HTML(who), {
          headers: {
            ...html,
            "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(who)}; Path=/; Max-Age=3600`,
          },
        });
      }
      if (path === "/whoami") {
        const cookie = request.headers.get("cookie") ?? "";
        const held = cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
        const who = held
          ? decodeURIComponent(held.slice(SESSION_COOKIE.length + 1))
          : null;
        return new Response(WHOAMI_HTML(who), { headers: html });
      }
      if (path === "/frame") {
        return new Response(FRAME_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/other") {
        return new Response(OTHER_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/headlines") {
        return new Response(HEADLINES_HTML, { headers: html });
      }
      if (path === "/pw") {
        return new Response(PW_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/swap") {
        return new Response(SWAP_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/card") {
        return new Response(CARD_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/saved-sign-in") {
        return new Response(SIGN_IN_HTML, { headers: html });
      }
      if (path === "/framed-saved-sign-in") {
        // Only an origin of this fixture's own: the page is written from the query.
        const from = url.searchParams.get("from") ?? "";
        if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(from)) {
          return new Response("not found", { status: 404 });
        }
        return new Response(framedSignIn(from), { headers: html });
      }
      if (path === "/shown-back-receipt") {
        return new Response(SHOWN_BACK_RECEIPT_HTML, { headers: html });
      }
      // The page renames its own address to `/shown-back/<the sign-in name>` once signed in.
      if (path === "/shown-back" || path.startsWith("/shown-back/")) {
        return new Response(SHOWN_BACK_HTML, { headers: html });
      }
      // Files rather than strings, like the job pages, but not on that list: nobody's job opens them.
      if (path === "/get-form" || path === "/landed") {
        return new Response(
          Bun.file(join(FIXTURES_DIR, `${path.slice(1)}.html`)),
          { headers: html },
        );
      }
      /*
       * A button that changes its own label after a while — "저장" becomes "결제하기" — and reports
       * which label was showing when it was pressed. `after` is the delay in milliseconds, so a
       * test can snapshot the old name, wait, and act on the new one with the old ref.
       */
      if (path === "/relabel") {
        const after = Number.parseInt(
          url.searchParams.get("after") ?? "300",
          10,
        );
        return new Response(relabelHtml(after, url.searchParams.has("hide")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/download") {
        return new Response(DOWNLOAD_BODY, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            /*
             * RFC 5987, not `filename="정산내역.csv"`.
             *
             * A header value may only carry Latin-1, and Bun refuses to send one that does not —
             * which is itself the reason a Korean site sends this form. Chromium decodes it back to
             * the Korean name, which is what the download then has to be saved as.
             */
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(DOWNLOAD_NAME)}`,
          },
        });
      }
      return new Response(PAGE_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => {
      for (const release of [...hanging, ...late]) {
        release(new Response("", { status: 503 }));
      }
      hanging.clear();
      late.clear();
      return server.stop(true);
    },
    /** Answer every `/late-frame` request waiting so far. */
    releaseLateFrames: () => {
      for (const release of late) {
        release(new Response(LATE_FRAME_HTML, { headers: html }));
      }
      late.clear();
    },
    setQuiet: (on: boolean) => {
      quiet = on;
    },
    /** Every job page is present on disk, or the name of the one that is not. */
    missingPages: () =>
      JOB_PAGES.filter(
        (name) => !existsSync(join(FIXTURES_DIR, `${name}.html`)),
      ),
  };
}
