import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectedWhenPressed } from "../src/components/ui/focus";

/**
 * CHOSEN HAS TO SHOW IN THE DARK TOO.
 *
 * MEASURED 2026-09-25 (0.5.4 final QA): in dark mode a chosen 음식점·카페 and an unchosen 온라인 판매
 * on 내 가게 computed the same border and the same fill. The outline variant sets its own
 * `dark:border-*` and `dark:bg-*`, and Tailwind sorts a `dark:` utility after a lone `aria-pressed:`
 * one, so the chosen state lost in the dark and only there. `bun test` never builds the CSS, so this
 * reads the rule the build follows: every property the outline variant colours under `dark:` is
 * coloured again under `dark:aria-pressed:`.
 */
const BUTTON = readFileSync(
  join(import.meta.dir, "../src/components/ui/button.tsx"),
  "utf8",
);

describe("the chosen state in dark mode", () => {
  test("outranks every dark colour the outline variant sets", () => {
    const outline = /outline:\s*"([^"]+)"/.exec(BUTTON)?.[1] ?? "";
    expect(outline).not.toBe("");
    const darkProperties = new Set(
      [...outline.matchAll(/(?:^|\s)dark:(border|bg)-/g)].map(
        (match) => match[1],
      ),
    );
    expect(darkProperties.size).toBeGreaterThan(0);
    for (const property of darkProperties) {
      expect(selectedWhenPressed).toContain(`dark:aria-pressed:${property}-`);
    }
  });
});
