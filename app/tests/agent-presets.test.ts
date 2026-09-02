import { describe, expect, test } from "bun:test";
import { MASCOT_ART } from "../src/components/agents/mascot-art";
import {
  AGENT_PRESETS,
  WORK_PATTERNS,
  type WorkPatternId,
  pickSuggestions,
  workPattern,
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
 * `satisfies Record<WorkPatternId, true>` is doing the work: a pattern added to the type and not to
 * this object is a typecheck error rather than a pattern this file quietly stops checking.
 */
const PATTERNS = Object.keys({
  "night-watch": true,
  approval: true,
  settlement: true,
  enquiries: true,
  schedule: true,
  stock: true,
  reputation: true,
  paperwork: true,
} satisfies Record<WorkPatternId, true>) as WorkPatternId[];

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

  /**
   * FOUR EACH, EXACTLY.
   *
   * `pickSuggestions` deals one per pattern, so a pattern with three presets runs out one round
   * before the others and quietly stops appearing in the second half of a hand — and a pattern of
   * one is a pattern that shows the same card every single time. Named rather than counted, so a
   * failure says which pattern went thin.
   */
  test("every work pattern has four presets", () => {
    const counted = PATTERNS.map(
      (pattern) =>
        `${pattern}: ${AGENT_PRESETS.filter((preset) => preset.pattern === pattern).length}`,
    );
    expect(counted).toEqual(PATTERNS.map((pattern) => `${pattern}: 4`));
  });

  test("every preset belongs to a pattern that exists", () => {
    const known = new Set(WORK_PATTERNS.map((pattern) => pattern.id));
    const orphans = AGENT_PRESETS.filter(
      (preset) => !known.has(preset.pattern),
    ).map((preset) => preset.id);
    expect(orphans).toEqual([]);
  });
});

describe("the eight work patterns", () => {
  /*
   * The pattern name is drawn above every suggestion card and the connection beside it, both
   * through `t(variable)` — the same blind spot the presets have, and the same answer.
   */
  test("every name and connection has Korean", () => {
    const missing: string[] = [];
    for (const pattern of WORK_PATTERNS) {
      for (const value of [pattern.name, pattern.connection]) {
        if (!(value in ko)) missing.push(value);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the table holds every pattern in the type, once", () => {
    expect(WORK_PATTERNS.map((pattern) => pattern.id).sort()).toEqual(
      [...PATTERNS].sort(),
    );
  });

  test("a preset can always name its pattern", () => {
    // `workPattern` casts, because the type says the id is one of eight. This is the check that
    // makes the cast true rather than merely convenient.
    for (const preset of AGENT_PRESETS) {
      expect(workPattern(preset.pattern).id).toBe(preset.pattern);
    }
  });

  test("the connections are the four words the product owns", () => {
    const used = new Set(WORK_PATTERNS.map((pattern) => pattern.connection));
    expect([...used].sort()).toEqual([
      "Browser",
      "Connected apps",
      "Email",
      "Sheets",
    ]);
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
    // patterns, one per pattern, means six distinct ones every time — not merely usually.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const kinds = new Set(pickSuggestions(6).map((preset) => preset.pattern));
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
