import type { HtmlTagDescriptor } from "vite";

/**
 * WHICH COMMIT THIS BUNDLE WAS BUILT FROM, WRITTEN INTO THE PAGE THAT LOADS IT.
 *
 * Until 2026-10-06 a page could not say what it was. The server has answered for its own build
 * since 2026-09-10 (`GET /api/version`, `shared/log.ts` `buildOf`), and the page read that answer
 * once and called it "the build" — which is the server's, and after an upgrade under an open
 * window is exactly the build the page is NOT. So a window left open kept the old bundle for as
 * long as it stayed open, in the installed app for days, and nothing could tell
 * (`lib/build-watch.ts` is what tells now).
 *
 * `GIT_SHA` is the name the server's image already bakes the commit under; `app/Dockerfile` sets
 * it from the same `--build-arg REVISION` before the build. A local build and the dev server have
 * none, so no tag is written and the page never claims there is a newer one.
 *
 * IN THE DOCUMENT, NOT IN A MODULE. Baked into the script — a `define`, or the generated
 * application config — the commit would change the chunk that holds it on every release, and
 * with it the name of every chunk that imports that one: a release that touched nothing in the
 * app would still rename its files, and each open window would meet a chunk that is gone
 * (`lib/build-reload.ts`), which is the unasked-for reload the notice exists to spare. A `<meta>`
 * in `index.html` changes one file that is never cached (`Caddyfile`, `no-cache` on every page),
 * and a page reads its own document for nothing.
 */
export const BUILD_REVISION_META = "laf-build-revision";

/**
 * A commit, a tag or a test's word: letters, digits, dot, underscore and hyphen, sixty-four at
 * most. A closed shape, so nothing an environment holds can be anything but an attribute's value.
 */
const REVISION = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The tag for this build's commit, or none where the build was not told one. Handed the
 * environment rather than reading it: the page imports this file for the tag's name, and a page
 * has no environment to read (`vite.config.ts` is what calls this, with the build's).
 */
export function revisionTags(
  environment: Record<string, string | undefined>,
): HtmlTagDescriptor[] {
  const revision = environment.GIT_SHA?.trim();
  if (!revision || !REVISION.test(revision)) return [];
  return [
    {
      tag: "meta",
      attrs: { name: BUILD_REVISION_META, content: revision },
      injectTo: "head",
    },
  ];
}
