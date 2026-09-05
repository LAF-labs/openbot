import { Hono } from "hono";
import { catalogueEntry } from "./catalogue";

/**
 * The one page in this server that is written for a person to read, and the only one that ever
 * should be.
 *
 * WHY IT EXISTS. In the desktop shell the consent screen is handed to the person's OWN browser
 * (`openConsent` in the app), because a webview with no address bar, no password manager and no
 * Google session is the wrong place to sign in. The vendor then sends that browser to this
 * deployment's callback — and the callback's ordinary ending is a redirect into the app, which in
 * that browser has no session at all. Measured: the person consented, everything was stored
 * correctly, and they landed on 로그인하세요 with no way to tell whether it had worked.
 *
 * WHY THE KOREAN IS HERE AND NOT IN `t()`. The rule is that the server sends facts and the surface
 * owns the words (docs/laf/redesign-2026-09.md §4-2), and this is the one place the rule cannot
 * reach: the surface is a signed-in SPA on a different browser profile, and the whole point of this
 * page is that it renders where the SPA cannot. Nine sentences, in one file, for the one screen
 * that has no app behind it.
 *
 * WHAT IS NOT IN THE URL. No token, no code, no state, no email — a `1`, a catalogue slug, a
 * vendor's display title and one of five reason words. This URL lands in the person's browser
 * history and in whatever they paste to somebody; it has to be dull.
 *
 * NOTHING IS ECHOED THAT WAS NOT LOOKED UP. `id` names a catalogue entry and the title comes from
 * that entry, so the ordinary path reflects nothing at all. The `name` parameter is the fallback
 * for an id this build does not know, and it is escaped and capped — a reflected `<script>` on a
 * session-free public page is still a reflected `<script>`.
 */

/** A catalogue slug, and the only shape a deep link's id may take. */
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Why a connect ended, as one of five words the callback chose.
 *
 * Deliberately coarse and deliberately not the vendor's. Each one exists because a person's next
 * move is different: waiting too long is worth trying again immediately, declining at the vendor is
 * not a fault at all, and a refused exchange is worth a second attempt before anybody worries.
 */
const REASONS: Record<string, string> = {
  expired: "시간이 지나 연결이 만료됐습니다. 다시 시도해 주세요.",
  reused: "이미 처리된 연결 요청입니다. 앱에서 다시 연결해 주세요.",
  denied: "연결이 취소됐습니다.",
  exchange: "서비스 쪽에서 연결을 마치지 못했습니다. 다시 시도해 주세요.",
  mismatch: "이 연결 요청을 처리할 수 없습니다. 앱에서 다시 시도해 주세요.",
};

/** The five words above, for the callback to pick from. One list, so the two cannot drift. */
export type ConnectFailureReason = keyof typeof REASONS;

/** Text that cannot become markup. Everything reflected on this page goes through it. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The vendor's name as this page will say it: the catalogue's, or the caller's, escaped.
 *
 * The catalogue first, so the ordinary path is a lookup rather than a reflection.
 */
function titleFor(id: string, name: string): string {
  const entry = SERVER_ID.test(id) ? catalogueEntry(id) : null;
  if (entry) return escapeHtml(entry.title);
  return escapeHtml(name.slice(0, 64));
}

/**
 * The page itself.
 *
 * The deep link is attempted on load AND offered as a button. The automatic attempt is what makes
 * this feel like one flow; the button is what makes it work anyway, because a browser will not
 * always honour a scheme navigation that no gesture asked for — Safari in particular refuses one
 * on a page the person has not touched.
 *
 * There is no polling, no fetch and no script beyond that one navigation. This page has no session
 * and must never be a place where having one matters.
 */
export function connectedPageHtml(input: {
  ok: boolean;
  /** The catalogue slug, so the shell knows which connection to open. Empty on a failure. */
  id: string;
  title: string;
  reason: string;
}): string {
  const deepLink =
    input.ok && SERVER_ID.test(input.id)
      ? `lafagent://connected/${input.id}`
      : "lafagent://connected/failed";
  const heading = input.ok ? "연결을 마쳤습니다" : "연결하지 못했습니다";
  /*
   * The vendor's name is used only where there is one. "연결을 마쳤습니다" with an empty name in
   * front of it reads as a bug, and a failure has usually not got far enough to know the vendor.
   */
  const said = input.ok
    ? `${input.title ? `${input.title} ` : ""}연결을 마쳤습니다. 앱으로 돌아가세요.`
    : `${REASONS[input.reason] ?? "연결하지 못했습니다."} 앱으로 돌아가세요.`;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: system-ui, -apple-system, "Apple SD Gothic Neo", sans-serif;
    background: Canvas; color: CanvasText;
  }
  main { max-width: 28rem; padding: 2rem; text-align: center; line-height: 1.7; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1.5rem; }
  a.button {
    display: inline-block; padding: 0.75rem 1.5rem; border-radius: 0.5rem;
    background: CanvasText; color: Canvas; text-decoration: none; font-weight: 600;
  }
  small { display: block; margin-top: 1.5rem; opacity: 0.7; }
</style>
</head>
<body>
<main>
  <h1>${heading}</h1>
  <p>${said}</p>
  <a class="button" href="${deepLink}">앱으로 돌아가기</a>
  <small>이 창은 닫아도 됩니다.</small>
</main>
<script>
  // One attempt, on load. The button above is what the person uses when the browser refuses this.
  location.href = ${JSON.stringify(deepLink)};
</script>
</body>
</html>
`;
}

/**
 * `GET /connected` — mounted at the root and deliberately NOT behind `requireUser`.
 *
 * A session here would defeat the entire purpose: this page exists for a browser that has none.
 * It reads nothing, writes nothing and decides nothing, so having no session costs it nothing
 * either — everything that mattered was decided by the sealed state at the callback.
 */
export function createConnectedPageRoute() {
  const routes = new Hono();

  routes.get("/", (context) => {
    const ok = context.req.query("ok") === "1";
    const id = context.req.query("id") ?? "";
    const reason = context.req.query("reason") ?? "";
    return context.html(
      connectedPageHtml({
        ok,
        id,
        title: titleFor(id, context.req.query("name") ?? ""),
        // Matched against the closed set rather than reflected: a reason is a word we chose.
        reason: reason in REASONS ? reason : "",
      }),
      200,
      // This page names a connection somebody just made. Nothing about it should be kept.
      { "cache-control": "no-store" },
    );
  });

  return routes;
}
