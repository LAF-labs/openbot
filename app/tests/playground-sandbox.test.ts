import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SANDBOX_ERROR,
  sandboxGuard,
} from "../src/routes/_authed/admin/playground";

/**
 * THE PREVIEW HAS TO FAIL THE WAY A CONVERSATION FAILS.
 *
 * `@jetbrains/websandbox` gives the preview iframe `sandbox="allow-scripts"` and nothing else —
 * measured on the running page, the attribute reads exactly that — so the document has an opaque
 * origin and `window.localStorage` THROWS rather than returning null. A component written against
 * browser storage therefore stops drawing halfway with nothing on screen to say why, and the only
 * evidence was a line in a console the author was not looking at.
 *
 * THE FIX THAT WOULD HAVE BEEN WORSE, and this is the test that keeps it out: defining a working
 * `localStorage` on the sandbox window is two lines and makes the preview draw. The same component
 * then fails in a conversation, where the sandbox is identical and this page is not — a preview that
 * says yes to something production says no to is worth less than no preview at all.
 */
const playgroundSource = (): string =>
  readFileSync(
    join(import.meta.dir, "../src/routes/_authed/admin/playground.tsx"),
    "utf8",
  );

describe("what the playground injects into its preview", () => {
  test("it listens rather than wrapping the author's code", () => {
    /*
     * A `try`/`catch` around the code would move every top-level `function` and `const` into that
     * block's scope, so a helper the component's HTML calls from an `onclick` would stop existing —
     * a guard that breaks the thing it is guarding.
     */
    const guard = sandboxGuard();
    expect(guard).toContain('window.addEventListener("error"');
    // It closes itself, so the author's code is appended at the TOP LEVEL of the script rather than
    // inside anything this opened. That is the whole property; the `try` inside it guards only its
    // own `postMessage`.
    expect(guard.trimEnd().endsWith("})();")).toBe(true);
    expect(playgroundSource()).toContain(
      "`${sandboxGuard()}window.__args = ${JSON.stringify(sample)};",
    );
  });

  test("it reports out to the host rather than drawing inside the sandbox", () => {
    // The one stylesheet in that document is the component's own, written for whatever ground its
    // author had in mind: the first version of this message came out near-black on a dark preview.
    const guard = sandboxGuard();
    expect(guard).toContain("window.parent.postMessage");
    expect(guard).toContain(SANDBOX_ERROR);
    expect(guard).not.toContain("createElement");
  });

  test("it never gives the sandbox a storage it does not have", () => {
    const guard = sandboxGuard();
    for (const shim of [
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "cookie",
      "defineProperty",
    ]) {
      expect({ shim, present: guard.includes(shim) }).toEqual({
        shim,
        present: false,
      });
    }
  });

  test("what it posts is clipped, so a runaway message cannot fill the panel", () => {
    expect(sandboxGuard()).toContain(".slice(0, 300)");
  });

  test("the page reads that message and nothing else", () => {
    /*
     * Filtering by type rather than by origin is forced: an opaque-origin frame posts from `"null"`,
     * and there is nothing to compare against. What that costs is bounded, and this is the bound —
     * the handler must do nothing but set the string it is shown.
     */
    const source = playgroundSource();
    expect(source).toContain("data?.type !== SANDBOX_ERROR");
    expect(source).toContain("setPreviewError");
    // And it goes when the draft that caused it does: the renderer is keyed on the draft.
    expect(source).toContain("setPreviewError(null)");
  });
});
