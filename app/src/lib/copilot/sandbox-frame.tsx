import { t } from "@/lib/i18n";

/**
 * A CARD WRITTEN IN THIS DEPLOYMENT, DRAWN WHERE IT CAN REACH NOTHING.
 *
 * A browser-authored component is HTML, CSS and JavaScript out of the database — and its
 * arguments are a model's. It is drawn in an `<iframe>` that is given one permission, to run
 * scripts, and the document in it is a string this file writes. Until 2026-10-13
 * `@copilotkit/react-core` drew it, through `@jetbrains/websandbox`; what that enforced was read
 * from both and every line of it is kept here or tightened, none loosened:
 *
 * 1. `sandbox="allow-scripts"` AND NOTHING ELSE. Without `allow-same-origin` the document's origin
 *    is opaque: this page's DOM, cookies, `localStorage`, `sessionStorage` and IndexedDB all
 *    throw, and a request to this origin carries no session. Without `allow-top-navigation` it
 *    cannot send this window anywhere; without `allow-popups`, `allow-forms`, `allow-modals` and
 *    `allow-downloads` it cannot open, post, prompt or save.
 * 2. `allow=""`: no camera, microphone, location, clipboard or any other permission is delegated.
 * 3. `srcdoc`, never `src`: the frame's content is the string below, from nowhere else.
 * 4. NOTHING IS SAID TO THE FRAME AND NOTHING IS HEARD FROM IT. The library kept a two-way
 *    message channel to run code in the frame after it loaded, checking each message's source and
 *    origin. Here the code is in the document from the start, so this file posts no message and
 *    listens for none: a message from the frame, or from anything pretending to be it, has no
 *    listener to reach. (The playground listens for one message of its own, by its type — that is
 *    its page's, and it does nothing but show a string: `playground.tsx`.)
 *
 * What a person sees is what the library drew, measured on the running page before it left:
 *
 * - A box 200px tall. The library could grow a frame to its content, but only when asked while a
 *   card was still being generated; a finished one — the only kind drawn here — never was.
 * - The author's CSS in a `<style>` at the end of `<head>` (or a `<head>` made for it).
 * - `html, body { overflow: hidden !important }` and then the author's JavaScript, each added to
 *   the end of `<head>` once the HTML has been read — the JavaScript as one classic script, so
 *   its top-level functions are globals an `onclick` in the HTML can call.
 * - WHEN the JavaScript runs (`RUN_WITHOUT_LOAD_AFTER_MS`). The library ran it a few messages
 *   after the frame began: for a card with nothing to fetch that was after `load`, with
 *   `document.readyState` already `"complete"` and a `load` listener the code adds never called;
 *   for a card waiting on a slow image it was before. Both are kept: the code runs at `load`, or
 *   a moment after the HTML is read when `load` has not come by then — a card is not left
 *   undrawn for as long as somebody else's image takes.
 * - HTML whose `<head>` is spelled any way but `<head>` is not drawn (the library refused it);
 *   the playground's preview shows the same, so nothing published is written that way.
 */

export type SandboxedContent = {
  css: string;
  cssComplete: true;
  html: string[];
  htmlComplete: true;
  jsFunctions: string;
  jsFunctionsComplete: true;
  generating: false;
};

/** The one permission the frame is given. A test holds it to exactly this. */
export const SANDBOX_PERMISSIONS = "allow-scripts";

/** How long after the HTML is read the author's code waits for `load` before running without it. */
export const RUN_WITHOUT_LOAD_AFTER_MS = 50;

/**
 * What runs first in the frame: once the HTML is read, hide what overflows; then run the author's
 * code, once, at `load` or shortly after if `load` is late. The code travels as a string literal,
 * with every `<` written as an escape — so no `</script>` or `<!--` in it can end or hide the
 * script that carries it.
 */
function bootstrap(code: string): string {
  const carried = JSON.stringify(code).replace(/</g, "\\u003c");
  return `<script>(function () {
  var code = ${carried};
  var ran = false;
  function run() {
    if (ran) return;
    ran = true;
    var script = document.createElement("script");
    script.textContent = code;
    document.getElementsByTagName("head")[0].appendChild(script);
  }
  document.addEventListener("DOMContentLoaded", function () {
    var style = document.createElement("style");
    style.textContent = "html, body { overflow: hidden !important; }";
    document.getElementsByTagName("head")[0].appendChild(style);
    if (!code) return;
    window.addEventListener("load", run);
    setTimeout(run, ${RUN_WITHOUT_LOAD_AFTER_MS});
  });
})();</script>`;
}

/**
 * The document the frame is given; `null` when there is no HTML to draw, or none this can carry
 * its script in.
 */
export function sandboxDocument(content: {
  html: string[];
  css: string;
  jsFunctions: string;
}): string | null {
  const html = content.html.join("");
  if (!html) return null;
  let page = html;
  if (content.css) {
    const style = `<style>${content.css}</style>`;
    const headEnds = page.indexOf("</head>");
    page =
      headEnds === -1
        ? `<head>${style}</head>${page}`
        : page.slice(0, headEnds) + style + page.slice(headEnds);
  }
  if (!/<head[\s>]/i.test(page)) page = `<head></head>${page}`;
  const headStarts = page.indexOf("<head>");
  if (headStarts === -1) return null;
  const after = headStarts + "<head>".length;
  return (
    page.slice(0, after) + bootstrap(content.jsFunctions) + page.slice(after)
  );
}

/**
 * Named as the library's renderer was and taking what it took, so the two places that draw one
 * (`sandboxed-tools.tsx`, the playground's preview) read as they did. Only finished content can be
 * handed over — the type says so — because that is all either ever had.
 */
export function OpenGenerativeUIActivityRenderer({
  content,
}: {
  activityType: "open-generative-ui";
  agent: null;
  message: null;
  content: SandboxedContent;
}) {
  const page = sandboxDocument(content);
  if (!content.html.join("")) {
    // Nothing to draw: the library's empty box.
    return (
      <div className="relative flex h-[200px] w-full items-center justify-center overflow-hidden rounded-md border border-[#e0e0e0] bg-[#f5f5f5]" />
    );
  }
  return (
    <div className="relative block h-[200px] w-full overflow-hidden rounded-md bg-transparent">
      {page === null ? null : (
        <iframe
          allow=""
          className="size-full border-none bg-transparent"
          sandbox={SANDBOX_PERMISSIONS}
          srcDoc={page}
          title={t("Card")}
        />
      )}
    </div>
  );
}
