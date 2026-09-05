import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_REVIEW_EXAMPLES } from "../src/lib/agents/auto-review";
import { botMenuItems } from "../src/lib/agents/bot-menu";
import { seatsFrom, seatsFullMessage } from "../src/lib/agents/seats";
import { ko } from "../src/lib/i18n-ko";

/**
 * THE PROFILE PANE: what it offers, and what it must never quietly do.
 *
 * The menu's conditions are the part worth being certain about — a Bot the deployment shipped
 * refuses Edit, Duplicate and Delete at the server, so offering them draws three affordances that
 * can only fail. The rest is checked by walking the file, for the two properties an assertion about
 * an element could not see: that the standing allowance still goes through the REPLACING patch and
 * never through the merging `/profile` a Bot's own tool posts to, and that the memories card no
 * longer returns nothing when there is nothing to show.
 */

const PROFILE = join(
  import.meta.dir,
  "../src/components/agents/agent-profile.tsx",
);

describe("the Bot menu", () => {
  const owned = { canManage: true, hidden: false };

  test("a Bot you manage offers all four", () => {
    expect(botMenuItems(owned, seatsFrom(1)).map((item) => item.id)).toEqual([
      "edit",
      "hide",
      "duplicate",
      "delete",
    ]);
  });

  test("a Bot you cannot manage offers only Hide", () => {
    // The other three are refused by the server on a Bot the deployment shipped, and an affordance
    // that only ever fails is a promise the screen cannot keep.
    expect(
      botMenuItems({ canManage: false, hidden: false }, seatsFrom(1)).map(
        (item) => item.id,
      ),
    ).toEqual(["hide"]);
  });

  test("Hide says what it does before it is pressed, both ways round", () => {
    const hide = botMenuItems(owned, seatsFrom(1)).find(
      (item) => item.id === "hide",
    );
    const unhide = botMenuItems(
      { canManage: true, hidden: true },
      seatsFrom(1),
    ).find((item) => item.id === "hide");

    expect(hide?.description).toBeTruthy();
    expect(unhide?.description).toBeTruthy();
    expect(hide?.description).not.toBe(unhide?.description);
    // It keeps its seat while hidden, which is the fact that made "봇 3/5" disagree with the server.
    expect(hide?.description).toContain("seat");
  });

  test("Duplicate warns on the last seat and refuses when there are none", () => {
    const at = (used: number) =>
      botMenuItems(owned, seatsFrom(used)).find(
        (item) => item.id === "duplicate",
      );

    expect(at(1)?.disabled).toBeFalsy();
    expect(at(4)?.disabled).toBeFalsy();
    // Four of five: the copy is about to take the last one, and it says so before it does.
    expect(at(4)?.description).not.toBe(at(1)?.description);
    expect(at(5)?.disabled).toBe(true);
    expect(at(5)?.description).toBe(seatsFullMessage(seatsFrom(5)));
  });

  test("Delete is the only destructive one", () => {
    expect(
      botMenuItems(owned, seatsFrom(1))
        .filter((item) => item.destructive)
        .map((item) => item.id),
    ).toEqual(["delete"]);
  });

  test("every label and every consequence has Korean", () => {
    // Read through `t()` inside `botMenuItems`, so `i18n-coverage.test.ts` sees the literals there;
    // this is the check that the table it builds is complete in both languages at once.
    const english = botMenuItems(owned, seatsFrom(1));
    expect(english.length).toBeGreaterThan(0);
    for (const item of english) {
      expect(ko[item.label]).toBeTruthy();
      expect(ko[item.description]).toBeTruthy();
    }
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
     * this Bot know about me — had no answer at all until it had a worrying one.
     */
    const source = readFileSync(PROFILE, "utf8");
    const card = source.slice(
      source.indexOf("function MemoriesCard"),
      source.indexOf("function SkillsCard"),
    );
    expect(card).toContain(
      "Nothing yet. What it learns about you appears here.",
    );
    // Pending is still the one case that draws nothing: "it remembers nothing" is as much a claim
    // as a list, and it must not be made while the request is in flight.
    expect(card).toContain("if (isPending) return null;");
    expect(card).not.toContain("memories.length === 0) return null");
  });
});

describe("the profile card above the first conversation", () => {
  const CARD = join(
    import.meta.dir,
    "../src/components/agents/bot-intro-card.tsx",
  );

  test("opts back into pointer events, because the overlay it sits in has none", () => {
    /*
     * MEASURED IN A BROWSER: every chip and both fields were dead, and nothing said so — no error,
     * no request, no console line. `ConversationView` lays its empty state over the transcript as
     * `pointer-events-none` so an overlay can never come between somebody and the composer, and it
     * expects a control-bearing empty state to opt back in on its own element.
     */
    expect(readFileSync(CARD, "utf8")).toContain("pointer-events-auto");
    // The overlay that makes it necessary. If this stops being click-through, the line above is
    // harmless; if it stays and the card loses its opt-in, the card is furniture.
    expect(
      readFileSync(
        join(
          import.meta.dir,
          "../src/components/channels/conversation-view.tsx",
        ),
        "utf8",
      ),
    ).toContain("pointer-events-none absolute inset-0");
  });

  test("a chip writes the Bot's words in the reader's language", () => {
    // `t(preset.title)`, not `preset.title`: filling the form with the English key would produce a
    // Korean card that makes an English colleague, and those words are the Bot's for good.
    const source = readFileSync(CARD, "utf8");
    expect(source).toContain("t(preset.title)");
    expect(source).toContain("t(preset.roleDescription)");
  });

  test("it saves through the replacing PATCH, carrying the fields it is not changing", () => {
    // A PATCH replaces what it carries: naming a Bot must not clear what it does, and picking a
    // face must not rename it. `endpoint` stays out — an address already saved and working is
    // re-validated as if it had just been typed.
    const source = readFileSync(CARD, "utf8");
    expect(source).toContain("updateAgent.mutateAsync");
    // The field, not the word: the comment above the call says why it is absent.
    expect(source).not.toContain("endpoint:");
  });
});

describe("the owner's profile form", () => {
  test("asks for a name and what it does, and nothing else", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/components/agents/agent-fields.tsx"),
      "utf8",
    );
    expect(source).toContain('<form.Field name="name">');
    expect(source).toContain('<form.Field name="title">');
    // Public/private decides nothing where one person owns every Bot, and the endpoint and its key
    // are an operator's — they live on /admin/bots.
    expect(source).not.toContain('name="visibility"');
    expect(source).not.toContain('name="endpoint"');
    expect(source).not.toContain('name="authValue"');
  });
});
