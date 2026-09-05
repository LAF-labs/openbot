import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ko } from "../src/lib/i18n-ko";
import {
  type RoutineSuggestion,
  SUGGESTION_REFUSALS,
  SUGGESTION_WHY,
  suggestionFactsLine,
} from "../src/lib/routines/suggestions";

/**
 * The suggestion cards' words and their one line of facts.
 *
 * Two tables here are read through `t(variable)` — the sentence saying why a card is worth having
 * and the refusal a press can get back — so `i18n-coverage.test.ts` cannot see them and they are
 * walked, the presets' way. The keys are the server's: its catalogue is read as text, the way
 * `routines-copy.test.ts` reads the routine service, so a card added there fails here until it has
 * its sentence, and a sentence left behind fails until it is removed.
 */

const SERVER = join(import.meta.dir, "../../server/src/routines");
const CATALOGUE_SOURCE = readFileSync(
  join(SERVER, "suggestion-catalog.ts"),
  "utf8",
);
const SERVICE_SOURCE = `${readFileSync(join(SERVER, "suggestions.ts"), "utf8")}${readFileSync(join(SERVER, "suggestions-routes.ts"), "utf8")}`;

const COMPONENT = readFileSync(
  join(import.meta.dir, "../src/components/routines/suggestions.tsx"),
  "utf8",
);
const PAGE = readFileSync(
  join(import.meta.dir, "../src/routes/_authed/_app/routines.tsx"),
  "utf8",
);

/** The catalogue's keys, read off the server's source. */
const catalogueKeys = [
  ...CATALOGUE_SOURCE.matchAll(/^\s+key: "([a-z-]+)",$/gm),
].map((match) => match[1] as string);

/** The same words `owner-vocabulary.test.ts` keeps off an owner's screen. */
const FORBIDDEN = [
  "에이전트",
  "코워커",
  "어시스턴트",
  "스레드",
  "플러그인",
  "토큰",
  "컴포넌트",
  "MCP",
];

describe("why each card is worth having", () => {
  test("every sentence has Korean", () => {
    const missing = Object.values(SUGGESTION_WHY).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every card in the server's catalogue, and no other", () => {
    expect(catalogueKeys.length).toBeGreaterThan(5);
    expect(Object.keys(SUGGESTION_WHY).sort()).toEqual(
      [...catalogueKeys].sort(),
    );
  });

  test("speaks the owner's Korean", () => {
    const offences: string[] = [];
    for (const sentence of Object.values(SUGGESTION_WHY)) {
      const korean = ko[sentence] ?? "";
      for (const word of FORBIDDEN) {
        if (korean.includes(word)) offences.push(`${word}: ${korean}`);
      }
    }
    expect(offences).toEqual([]);
  });
});

describe("the refusals a press can get back", () => {
  test("every one has Korean", () => {
    const missing = Object.values(SUGGESTION_REFUSALS).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every code the suggestion routes can send", () => {
    const codes = new Set(
      [...SERVICE_SOURCE.matchAll(/"(laf:routine_suggestion_[a-z_]+)"/g)].map(
        (match) => match[1] as string,
      ),
    );
    expect(codes.size).toBeGreaterThan(0);
    expect([...codes].sort()).toEqual(Object.keys(SUGGESTION_REFUSALS).sort());
  });
});

describe("the card's line of facts", () => {
  const card = (
    overrides: Partial<RoutineSuggestion> = {},
  ): RoutineSuggestion => ({
    key: "morning-brief",
    name: "아침 브리핑",
    instruction: "…",
    schedule: { kind: "daily", time: "07:30", timeZone: "Asia/Seoul" },
    needs: [],
    via: [],
    ...overrides,
  });

  test("names what it runs on and says when, with the list's own clock", () => {
    const line = suggestionFactsLine(
      card({
        via: [
          { kind: "site", id: "baemin-ceo", title: "Baemin for Owners" },
          { kind: "account", id: "gmail", title: "Gmail" },
        ],
      }),
    );
    // The runner's locale is English; the Korean side is the dictionary's, checked above.
    expect(line).toContain("Baemin for Owners, Gmail");
    expect(line).toContain("7:30");
    expect(line).not.toContain("07:30");
  });

  test("a card that needs nothing says so, and a weekly one says its day", () => {
    const line = suggestionFactsLine(
      card({
        key: "tax-calendar",
        schedule: {
          kind: "daily",
          time: "09:00",
          timeZone: "Asia/Seoul",
          days: [1],
        },
      }),
    );
    expect(line).toContain("Needs no connection");
    expect(line).toMatch(/Mon/);
  });
});

describe("the section", () => {
  test("draws nothing when there is nothing to offer", () => {
    expect(COMPONENT).toContain(
      "if (cards.length === 0 && !made) return null;",
    );
  });

  test("has a skeleton and a retry, not a blank", () => {
    expect(COMPONENT).toContain('aria-busy="true"');
    expect(COMPONENT).toContain("<Skeleton");
    expect(COMPONENT).toContain('t("The suggestions could not be loaded.")');
    expect(COMPONENT).toContain('t("Try again")');
  });

  test("offers exactly two verbs, and neither creates anything by itself", () => {
    expect(COMPONENT).toContain('t("Make")');
    expect(COMPONENT).toContain('t("Not now")');
    // A card is a request, never a routine already made: the only writes are behind a press.
    expect(COMPONENT.match(/useMutation\(/g)).toHaveLength(2);
    expect(COMPONENT).not.toContain("useEffect");
  });

  test("sits above the list on /routines", () => {
    const section = PAGE.indexOf("<RoutineSuggestions />");
    const list = PAGE.indexOf("(routines.data ?? []).map(");
    expect(section).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(section);
  });
});
