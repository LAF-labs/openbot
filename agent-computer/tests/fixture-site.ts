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
 * routine would open on any other morning. No real customer's data is in any of them.
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
export const DOWNLOAD_BODY = "날짜,금액\n2026-09-01,12000\n";

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

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

/** The label the relabel button starts with, and the money word it becomes. See `/relabel`. */
export const RELABEL_BEFORE = "저장";
export const RELABEL_AFTER = "결제하기";

/**
 * A button that keeps its node and its ref but swaps its own text after `after` ms, and records
 * which label was showing when it was pressed. The TOCTOU the money-word rule has to survive: the
 * snapshot sees 저장, the click lands on 결제하기, the same ref throughout.
 */
function relabelHtml(after: number): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>재라벨</title></head>
<body>
  <h1>${VISIBLE_TEXT}</h1>
  <button id="act" type="button" onclick="document.title = '눌림:' + this.textContent">${RELABEL_BEFORE}</button>
  <script>
    setTimeout(function () {
      document.getElementById('act').textContent = ${JSON.stringify(RELABEL_AFTER)};
    }, ${after});
  </script>
</body></html>`;
}

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

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
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
      if (path === "/pw") {
        return new Response(PW_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
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
        return new Response(relabelHtml(after), {
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
      for (const release of hanging) release(new Response("", { status: 503 }));
      hanging.clear();
      return server.stop(true);
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
