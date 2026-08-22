import { describe, expect, test } from "bun:test";
import { MASCOT_ART } from "../src/components/agents/mascot-art";
import {
  AGENT_PRESETS,
  type PresetCategory,
  pickSuggestions,
} from "../src/lib/agents/presets";
import { ko } from "../src/lib/i18n-ko";

/**
 * The presets are the one place `t()` is called on a variable.
 *
 * `i18n-coverage.test.ts` reads literal `t("…")` calls out of the source, which is everything it
 * can honestly check — and it means `t(preset.name)` is invisible to it. So a preset added without
 * Korean fails nowhere: the card renders in English, in a Korean product, and fills the form with
 * English words that then become the Bot's own name and standing instruction. This table is
 * checked in and finite, so it can simply be walked.
 */

/**
 * `satisfies Record<PresetCategory, true>` is doing the work: a category added to the type and not
 * to this object is a typecheck error rather than a category this file quietly stops checking.
 */
const CATEGORIES = Object.keys({
  money: true,
  customers: true,
  communication: true,
  research: true,
  operations: true,
  content: true,
  documents: true,
  personal: true,
} satisfies Record<PresetCategory, true>) as PresetCategory[];

describe("the presets", () => {
  test("every word of every one of them has Korean", () => {
    const missing: string[] = [];
    for (const preset of AGENT_PRESETS) {
      for (const value of [preset.name, preset.title, preset.roleDescription]) {
        if (!(value in ko)) missing.push(value);
      }
    }
    expect(missing).toEqual([]);
  });

  test("ids and faces are unique, so no two suggestions are twins", () => {
    const ids = AGENT_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    const seeds = AGENT_PRESETS.map((preset) => preset.avatarSeed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  test("every face is one that exists", () => {
    const unknown = AGENT_PRESETS.filter(
      (preset) => !(preset.avatarSeed in MASCOT_ART),
    ).map((preset) => `${preset.id} → ${preset.avatarSeed}`);
    expect(unknown).toEqual([]);
  });

  test("every category is represented, and none is a category of one", () => {
    // Named rather than counted, so a failure says which category went thin.
    const thin = CATEGORIES.filter(
      (category) =>
        AGENT_PRESETS.filter((preset) => preset.category === category).length <
        2,
    );
    expect(thin).toEqual([]);
  });
});

describe("picking a handful", () => {
  test("returns what was asked for, with no repeats", () => {
    const picked = pickSuggestions(6);
    expect(picked).toHaveLength(6);
    expect(new Set(picked.map((preset) => preset.id)).size).toBe(6);
  });

  test("spreads across kinds of work rather than dealing six of one", () => {
    // The whole reason `pickSuggestions` exists rather than a plain shuffle. Six from eight
    // categories, one per category, means six distinct ones every time — not merely usually.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const kinds = new Set(
        pickSuggestions(6).map((preset) => preset.category),
      );
      expect(kinds.size).toBe(6);
    }
  });

  test("asking for more than exists returns everything and stops", () => {
    const picked = pickSuggestions(AGENT_PRESETS.length + 10);
    expect(picked).toHaveLength(AGENT_PRESETS.length);
    expect(new Set(picked.map((preset) => preset.id)).size).toBe(
      AGENT_PRESETS.length,
    );
  });

  test("asking for none is not a reason to spin", () => {
    expect(pickSuggestions(0)).toEqual([]);
  });

  test("the same random sequence deals the same hand", () => {
    // Not a property anything relies on — it is how the shuffle is held to being a function of its
    // randomness rather than of anything ambient.
    const sequence = () => {
      let index = 0;
      const values = [0.1, 0.9, 0.4, 0.7, 0.2, 0.55, 0.33, 0.8, 0.05, 0.6];
      return () => {
        const value = values[index % values.length] as number;
        index += 1;
        return value;
      };
    };
    expect(pickSuggestions(5, sequence()).map((preset) => preset.id)).toEqual(
      pickSuggestions(5, sequence()).map((preset) => preset.id),
    );
  });
});
