import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";

/**
 * THE SKILLS PAGE: what a failed read says, and what a row calls a skill.
 *
 * `pluginsPageQueryOptions` was destructured for `data` and `isPending`, so `isError` had nowhere
 * to go and a 500 landed in the same branch as an empty list: 아직 스킬이 없습니다, in front of
 * somebody whose skills are all still on the server. That is the same failure the agents roster and
 * Routines each had and each fixed; this is the third one.
 *
 * And the row menu offered `/danggeun-reply 삭제` — a slug in the middle of a Korean sentence, and
 * the one part of a skill its author did not choose the wording of.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");
const source = read("routes/_authed/_app/skills.tsx");

describe("a read that failed", () => {
  test("is a state the page actually reads", () => {
    expect(source).toContain("isError");
    expect(source).toContain("refetch");
  });

  test("says so, and offers the press that tries again", () => {
    expect(source).toContain('t("Your skills could not be loaded.")');
    expect(source).toContain('t("Try again")');
    expect(ko["Your skills could not be loaded."]).toBeTruthy();
  });

  test('never reaches "no skills yet" while pending or failed', () => {
    /*
     * The guard is the whole fix. "You have not written one" is a claim about the person, and it
     * was being made by a dropped connection.
     */
    expect(source).toContain("{!isPending && !isError && !mine?.length ? (");
  });

  test("draws a placeholder rather than nothing while it loads", () => {
    // Routines and the roster both hold their space; this page drew a section title over a void.
    const pending = source.indexOf("{isPending ? (");
    expect(pending).toBeGreaterThan(0);
    expect(source.slice(pending, pending + 400)).toContain("<Skeleton");
  });
});

describe("a skill's row", () => {
  test("is named by its title, in the menu and in the question", () => {
    expect(source).toContain('t("Actions for {name}", {');
    expect(source).toContain("askedAbout.current = skill.title;");
    // The delete item is the plain verb now; the noun is in the dialog it opens.
    expect(source).not.toContain('t("Delete {command}"');
    expect(source).not.toContain('t("Actions for /{slug}"');
  });

  test("keeps the slug, as a chip, where it belongs", () => {
    /*
     * The command is still the thing a person types, so it stays on the row — but set as a chip
     * rather than as bare monospace loose in an Inter sentence, where it reads as a typo.
     */
    expect(source).toContain("/{skill.slug}");
    expect(source).toContain("rounded bg-muted px-1.5 py-0.5 font-mono");
  });
});

describe("writing one", () => {
  test("happens in the panel, which is the pattern the three pages share", () => {
    // Skills was already a panel; Routines was inline and is a panel now. The reasoning is written
    // down at the top of `NewRoutine`, and this is what keeps the two agreeing.
    expect(source).toContain("<DetailPanel");
    expect(read("routes/_authed/_app/routines.tsx")).toContain("<DetailPanel");
    for (const page of [
      "routes/_authed/_app/skills.tsx",
      "routes/_authed/_app/routines.tsx",
    ]) {
      expect(`${page}: ${read(page).includes("search={{ new: true }}")}`).toBe(
        `${page}: true`,
      );
    }
  });

  test("keeps its save on screen under a long instruction", () => {
    /*
     * 지시문 is a `min-h-40` textarea at the bottom of a 400px panel, so on a laptop 스킬 저장 was
     * below the fold of the panel's own scroller.
     */
    const fields = read("components/skills/skill-fields.tsx");
    expect(fields).toContain("sticky bottom-0");
    // The submit button is inside that sticky footer, not somewhere above it.
    const sticky = fields.indexOf('<div className="sticky bottom-0');
    expect(sticky).toBeGreaterThan(0);
    expect(fields.slice(sticky, sticky + 600)).toContain('type="submit"');
  });
});
