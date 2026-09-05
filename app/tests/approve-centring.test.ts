import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The page a notification lands on: where it sits, and the error it used to log on every load.
 *
 * TWO THINGS WERE MEASURED IN A BROWSER AND NEITHER WAS VISIBLE FROM A GREEN GATE.
 *
 * It was built on `PageShell`, the configuration frame — a prose column pinned to the top under
 * `py-12`. At 1280x900 the whole page was one sentence and one button between y=48 and y=109, with
 * 791 empty pixels below it, while every other "there is nothing here" state in the product is
 * centred. Now: 391px above, 391px below.
 *
 * And both of its Link buttons logged "Base UI: A component that acts as a button expected a native
 * <button>..." on every single load, because Base UI's `Button` assumes it renders a real button and
 * these render an anchor. `nativeButton={false}` is how you say so, and `router.tsx` had been
 * saying it since `NotFoundScreen` was written.
 *
 * WALKED RATHER THAN RENDERED, the call `settings-frame.test.ts` makes: what a render would prove
 * was measured in a browser instead, at 1280x900 in both themes and at 1280x320 to check that a
 * centred question still scrolls rather than clipping. This holds the two facts a later edit could
 * quietly undo.
 */

const ROUTE = join(
  import.meta.dir,
  "../src/routes/_authed/_app/approve/$approvalId.tsx",
);

/**
 * The file with its comments taken out. The comments RECORD what went wrong — `PageShell` and the
 * Base UI error text are both named in them — so a test that read them would pass on the strength
 * of its own documentation.
 */
const code = readFileSync(ROUTE, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the approval page's frame", () => {
  test("is not the configuration shell", () => {
    expect(code).not.toContain("PageShell");
  });

  test("centres its column, and scrolls when the question is taller than the window", () => {
    const column = code.match(/className="mx-auto flex[^"]*"/)?.[0] ?? "";
    expect(column).toContain("items-center");
    expect(column).toContain("justify-center");
    // Centring without `min-h-full` inside the scroller centres against the CONTENT, not the
    // window, which is a no-op on a short page and a clipped question on a tall one.
    expect(column).toContain("min-h-full");
    expect(code).toContain("overflow-y-auto");
  });

  test("nothing is pushed to the left edge of a centred column any more", () => {
    expect(code).not.toContain("self-start");
  });
});

describe("every Button that renders a Link", () => {
  test("says it is not a native button", () => {
    const buttons = code.match(/<Button[\s\S]*?>/g) ?? [];
    const linked = buttons.filter((one) => one.includes("render={<Link"));
    expect(linked.length).toBeGreaterThan(0);
    for (const one of linked) {
      expect(one).toContain("nativeButton={false}");
    }
  });
});
