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
 */

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

/**
 * Serve it, and say where.
 *
 * Port 0, so two of these can run at once — the gate is run concurrently from more than one
 * worktree, and a fixed port is how that turns into a test failure nobody can reproduce alone.
 */
export function serveFixture(port = 0) {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
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
    stop: () => server.stop(true),
  };
}
