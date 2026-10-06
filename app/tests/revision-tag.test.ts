import { expect, test } from "bun:test";
import {
  BUILD_REVISION_META,
  revisionTags,
} from "../src/lib/build/revision-tag";

/**
 * THE COMMIT A BUNDLE IS BUILT FROM, AS THE BUILD WRITES IT INTO THE PAGE.
 *
 * `vite.config.ts` hands the build's environment to `revisionTags` and puts what comes back into
 * `index.html`; `app/Dockerfile` sets `GIT_SHA` from the image's `REVISION` before the build
 * (`tests/dockerfiles.test.ts` holds both of those). This is the rule in between: one tag for a
 * build that was told its commit, none for one that was not — which is every local build and the
 * dev server, and is why the page never says there is a newer version in development
 * (`build-watch.test.ts`).
 */

const PAGE = "1bf325e4aaaa";

test("a build that was told its commit writes it as one tag in the document's head", () => {
  expect(revisionTags({ GIT_SHA: `${PAGE}\n` })).toEqual([
    {
      tag: "meta",
      attrs: { name: BUILD_REVISION_META, content: PAGE },
      injectTo: "head",
    },
  ]);
  // A release's tag is a build's name too.
  expect(revisionTags({ GIT_SHA: "v0.5.16" })).toHaveLength(1);
});

test("no tag where the build was told none — the dev server, a local build — or something that is no commit", () => {
  expect(revisionTags({})).toEqual([]);
  expect(revisionTags({ GIT_SHA: "" })).toEqual([]);
  expect(revisionTags({ GIT_SHA: "   " })).toEqual([]);
  // Nothing an environment holds becomes markup: a quote, a bracket or a space is no commit.
  for (const odd of ['"><script>', "two words", "a".repeat(65)]) {
    expect([odd, revisionTags({ GIT_SHA: odd })]).toEqual([odd, []]);
  }
});
