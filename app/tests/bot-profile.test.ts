import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_REVIEW_EXAMPLES } from "../src/lib/agents/auto-review";
import { ko } from "../src/lib/i18n-ko";

/**
 * THE PROFILE PANE: what it offers, and what it must never quietly do.
 *
 * Checked by walking the file, for the properties an assertion about an element could not see: that
 * the profile is a name and a face and nothing about what the Bot is for (2026-09-24), that a save
 * carries the fields it does not change, that the standing allowance still goes through the
 * REPLACING patch and never through the merging `/profile` a Bot's own tool posts to, and that the
 * memories card no longer returns nothing when there is nothing to show.
 */

const PROFILE = join(
  import.meta.dir,
  "../src/components/agents/agent-profile.tsx",
);

/**
 * A BOT'S PROFILE IS ITS NAME AND ITS FACE (2026-09-24): "프로필 설정은 이름과 봇 프로필 이미지만
 * 만들면 끝인 걸로(언제든지 바꿀 수 있음). 무슨 일을 시킬건지도 적지 않는다."
 */
describe("the profile's identity", () => {
  const source = () => readFileSync(PROFILE, "utf8");
  const identity = () =>
    source().slice(
      source().indexOf("export function AgentProfile"),
      source().indexOf("function NameField"),
    );

  test("is a name you can change and a face you can change, and nothing else", () => {
    expect(identity()).toContain("<NameField");
    expect(identity()).toContain("<BotAvatarPicker");
    // What the Bot is for is not asked, not shown and not offered as a list to pick from.
    expect(source()).not.toContain("profile.title");
    expect(source()).not.toContain("WorkStyleCard");
    expect(source()).not.toContain("How it works");
    expect(source()).not.toContain("preset");
    // Nor copied, hidden or pinned from here: those belonged to a roster of several.
    expect(source()).not.toContain("duplicate");
    expect(source()).not.toContain("setAgentHidden");
  });

  test("a save carries the fields it is not changing, through the replacing PATCH", () => {
    /*
     * A PATCH replaces what it carries: renaming a Bot must not clear a description it wrote for
     * itself, and picking a face must not rename it. `endpoint` stays out — an address already
     * saved and working is re-validated as if it had just been typed. No title: there is no such
     * field since 2026-09-24, nor a column since migration 0047.
     */
    const save = identity().slice(identity().indexOf("const save = "));
    const saveCall = save.slice(0, save.indexOf("\n\n"));
    expect(saveCall).toContain("roleDescription: profile.roleDescription");
    expect(saveCall).not.toContain("title");
    expect(save).toContain("updateAgent.mutateAsync");
    expect(identity()).not.toContain("endpoint:");
  });

  test("the name saves when it is left, and an empty one saves nothing", () => {
    const field = source().slice(
      source().indexOf("function NameField"),
      source().indexOf("function EffortCard"),
    );
    expect(field).toContain("onBlur={() => void commit()}");
    expect(field).toContain("if (!next || next === name)");
    // The Enter that accepts a Korean syllable is not the Enter that finishes the name.
    expect(field).toContain("if (isImeKey(event)) return;");
  });

  test("deleting the Bot is asked in a dialog, and lands where a new one is made", () => {
    expect(identity()).toContain("<ConfirmDialog");
    expect(identity()).toContain('await navigate({ to: "/" });');
    expect(ko["Delete this Bot"]).toBeDefined();
  });
});

describe("do not ask me about", () => {
  test("the examples are three, and every one has Korean", () => {
    // `t(example)` — invisible to the coverage walk, like the presets.
    expect(AUTO_REVIEW_EXAMPLES.length).toBe(3);
    expect(AUTO_REVIEW_EXAMPLES.filter((one) => !(one in ko))).toEqual([]);
  });

  test("a chip fills the box rather than saving on the spot", () => {
    // Half a sentence is a different instruction from the whole one. The chip writes the draft and
    // the Save button is what sends it — so a tap must set state, not mutate.
    const source = readFileSync(PROFILE, "utf8");
    expect(source).toContain("onClick={() => setDraft(t(example))}");
  });

  test("it saves through the replacing PATCH and never through /profile", () => {
    /*
     * The one field a Bot must never write. `/profile` is the merging endpoint a Bot's own
     * `update_profile` tool posts to; `autoReview` reaching it would let a Bot rewrite the rule that
     * decides whether it gets asked about.
     */
    const source = readFileSync(PROFILE, "utf8");
    const card = source.slice(source.indexOf("function AutoReviewCard"));
    expect(card).toContain("autoReview: draft.trim()");
    expect(card).toContain("updateAgent.mutateAsync");
    expect(card).not.toContain("setAgentEffortMutationOptions");
    expect(card).not.toContain("/profile");
  });
});

describe("what it remembers", () => {
  test("an empty list is drawn, not withheld", () => {
    /*
     * It used to `return null` on an empty list, so the one question the card answers — what does
     * this Bot know about me — had no answer at all until it had a worrying one. The list itself is
     * on 수첩 now; the card still says "nothing yet" rather than a count of none, and leads there.
     */
    const source = readFileSync(PROFILE, "utf8");
    const card = source.slice(
      source.indexOf("function MemoriesCard"),
      source.indexOf("function SkillsCard"),
    );
    expect(card).toContain(
      "Nothing yet. What it learns about you appears here.",
    );
    /*
     * Pending still claims nothing — "it remembers nothing" is as much a claim as a list — but it no
     * longer claims it by disappearing. `return null` left a card-shaped hole that filled in a
     * moment later and shoved the cards below it down the pane; the placeholder holds the space.
     * The card's states are drawn in `read-states-render.test.tsx`; this holds the two
     * lines a later edit could quietly undo.
     */
    expect(card).toContain('reading.state === "loading" ? (');
    expect(card).toContain("<Skeleton");
    expect(card).not.toContain("return null;");
    expect(card).not.toContain("memories.length === 0) return null");
    expect(card).toContain('to="/notebook"');
  });
});
