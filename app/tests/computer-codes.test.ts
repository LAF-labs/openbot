import { describe, expect, test } from "bun:test";
import {
  COMPUTER_CODES,
  type ComputerCode,
} from "../../agent-computer/src/codes";
import {
  CLIENT_FACTS,
  COMPUTER_ANSWERS,
  COMPUTER_FAILED,
  COMPUTER_TIMED_OUT,
  COMPUTER_UNREACHABLE,
} from "../../server/src/computer/client";
import { TOOL_RESULT_KO } from "../../shared/prompt/tool-results.ko";
import { OUTCOME_LABELS } from "../src/lib/computer/outcome-labels";
import { SECRET_REFUSALS } from "../src/lib/computer/refusals";
import { SCREEN_PROBLEM_SAID } from "../src/lib/computer/screen-problems";
import { ko } from "../src/lib/i18n-ko";
import { COMPUTER_FACTS, FACTS } from "../src/routes/_authed/admin/audit";

/**
 * THE CONTRACT: WHAT THE BOT'S COMPUTER CAN SAY, AND WHO KNOWS IT.
 *
 * Two splits of one wave landed on 2026-09-14 speaking two vocabularies for the same facts. The
 * container named a page that would not open `laf:navigation_failed` and three different file
 * refusals by their own names; the server's client, reading statuses and Playwright's first line
 * rather than `code`, called them `laf:page_failed` and `laf:workspace_file_unusable`. The model had
 * sentences for both, the transcript line for the server's names only, the masked box for a name
 * (`laf:secret_field_gone`) the container never sent — and nobody had run one against the other.
 *
 * So the container's list (`agent-computer/src/codes.ts`) is the source of truth, and this file fails
 * when it can send a code that any reader does not know: the server's client (its one table), the
 * model (`shared/prompt/tool-results.ko.ts`), or the person, on the surface where they meet it. Every
 * set below is derived from the list, so a code added there is checked here before anybody writes a
 * line for it — not after a Korean screen shows it as `laf:` and an identifier.
 */

const CODES = Object.entries(COMPUTER_CODES) as [
  ComputerCode,
  (typeof COMPUTER_CODES)[ComputerCode],
][];

const answers = (callers: readonly string[]) =>
  CODES.filter(
    ([, spec]) =>
      "status" in spec && "caller" in spec && callers.includes(spec.caller),
  ).map(([code]) => code);

const ALL = CODES.map(([code]) => code);
const ANSWERS = answers(["any", "bot", "person"]);
const SCREEN = CODES.filter(([, spec]) => "screen" in spec).map(
  ([code]) => code,
);
const NOTES = CODES.filter(([, spec]) => "note" in spec).map(([code]) => code);

/** The codes of `codes` that `table` has no entry for. */
const unknownTo = (table: Record<string, unknown>, codes: readonly string[]) =>
  codes.filter((code) => !Object.hasOwn(table, code));

describe("the container's list reached this file", () => {
  test("with its answers, its notes and its socket", () => {
    // Named rather than only counted: a list that stopped loading would pass everything below.
    expect(ANSWERS.length).toBeGreaterThan(20);
    expect(NOTES).toContain("laf:dialog");
    expect(SCREEN).toContain("laf:screen_not_started");
  });
});

describe("the server knows every failure the container can answer with", () => {
  test("each has one entry in the client's table", () => {
    expect(unknownTo(COMPUTER_ANSWERS, ANSWERS)).toEqual([]);
  });

  test("and the table names nothing the container does not answer with", () => {
    // An entry for a code nothing sends is a second name waiting to be used for a fact.
    expect(
      Object.keys(COMPUTER_ANSWERS).filter(
        (code) => !(ANSWERS as string[]).includes(code),
      ),
    ).toEqual([]);
  });
});

describe("the model knows every code", () => {
  test("every one the container can send — a failure, a note, the socket", () => {
    expect(unknownTo(TOOL_RESULT_KO, ALL)).toEqual([]);
  });

  test("and every one the client says itself", () => {
    expect(unknownTo(TOOL_RESULT_KO, CLIENT_FACTS)).toEqual([]);
  });
});

describe("the person knows every code, where they meet it", () => {
  test("the transcript line: every failure a Bot's own call can be answered with", () => {
    // A code with no line here fell back to the model's sentence — an instruction to a Bot, printed
    // under a person's transcript. Most of the container's codes did, until 2026-09-14.
    expect(unknownTo(OUTCOME_LABELS, answers(["any", "bot"]))).toEqual([]);
    expect(unknownTo(OUTCOME_LABELS, CLIENT_FACTS)).toEqual([]);
  });

  test("the screen pane and the Computers page: whatever was asked, and the live socket", () => {
    // The door and the browser answer the screenshot poll as surely as a Bot's tool, and the socket
    // is the person's own. A code with no sentence falls to the pane's generic line.
    expect(
      unknownTo(SCREEN_PROBLEM_SAID, [
        ...answers(["any"]),
        ...SCREEN,
        COMPUTER_UNREACHABLE,
        COMPUTER_TIMED_OUT,
        COMPUTER_FAILED,
      ]),
    ).toEqual([]);
  });

  /**
   * A person's own doors, one decision per code: which of the person's tables says it, or why none
   * does. A person-only code added to the list and not here fails the first test, so the decision
   * is made when the code is.
   */
  const PERSON_TABLES: Record<string, Record<string, string> | null> = {
    // The masked box (`lib/computer/refusals.ts`).
    "laf:secret_not_pending": SECRET_REFUSALS,
    // The live screen's own input; over the socket it is the pane's.
    "laf:take_control_first": SCREEN_PROBLEM_SAID,
    // Answered only to the server's inward socket (`server/src/live-screen.ts`). A person meets a
    // refused upgrade as the socket not opening — `laf:screen_unreachable`, which the pane owns.
    "laf:stream_upgrade_required": null,
  };

  test("a person's own doors: each code has its table, or a reason it has none", () => {
    expect(
      answers(["person"]).filter((code) => !(code in PERSON_TABLES)),
    ).toEqual([]);
    expect(
      Object.keys(PERSON_TABLES).filter(
        (code) => !(answers(["person"]) as string[]).includes(code),
      ),
    ).toEqual([]);
    for (const [code, table] of Object.entries(PERSON_TABLES)) {
      if (!table) continue;
      expect({ code, known: Object.hasOwn(table, code) }).toEqual({
        code,
        known: true,
      });
    }
  });

  test("the masked box: the element its value could not go into, which the Bot's actions share", () => {
    // `/human/secret` answers through `actionFailure` like a click; the box it was for not taking the
    // value is `laf:element_not_actionable` there, and the box has to say so in its own words.
    expect(
      unknownTo(SECRET_REFUSALS, [
        "laf:element_not_actionable",
        COMPUTER_UNREACHABLE,
        COMPUTER_TIMED_OUT,
      ]),
    ).toEqual([]);
  });

  test("and everything those tables say about a code has Korean", () => {
    const missing = [OUTCOME_LABELS, SCREEN_PROBLEM_SAID, SECRET_REFUSALS]
      .flatMap((table) =>
        [...ALL, ...CLIENT_FACTS]
          .filter((code) => Object.hasOwn(table, code))
          .map((code) => table[code] as string),
      )
      .filter((sentence) => !(sentence in ko));
    expect(missing).toEqual([]);
  });
});

/**
 * THE AUDIT TRAIL, WHICH PRINTED THEM AS THEY CAME.
 *
 * A computer action that did not happen keeps its failure as the code the computer or the client
 * named, and `/admin/audit` looked codes up only in the trail's own facts — so a Korean trail read
 * `laf:navigation_failed` under 실행되지 않음 until 2026-09-14. Every code the container can send and
 * every code the client says itself has to have words in the page's table, whether or not a row can
 * carry it today: the day one does is not the day to find out.
 */
describe("the audit trail knows every code", () => {
  test("each code the container lists, and each the client says itself, has words in the audit table", () => {
    expect(unknownTo(COMPUTER_FACTS, [...ALL, ...CLIENT_FACTS])).toEqual([]);
  });

  test("and the words are words: Korean for each, and never the code again", () => {
    const codes = [...ALL, ...CLIENT_FACTS];
    const said = codes.map((code) => COMPUTER_FACTS[code] as string);
    expect(said.filter((sentence) => !(sentence in ko))).toEqual([]);
    expect(said.filter((sentence) => sentence.startsWith("laf:"))).toEqual([]);
  });

  test("no code means two things on one page: where the trail's own facts name one, they agree", () => {
    // The page reads the trail's facts first. A code in both tables would print the first table's
    // words, and the walk above would be checking a sentence nobody sees.
    expect(
      Object.keys(COMPUTER_FACTS).filter((code) => Object.hasOwn(FACTS, code)),
    ).toEqual([]);
  });
});

/**
 * THE SECOND VOCABULARY, GONE FROM EVERY READER.
 *
 * Kept by name, because a table that still knows an old name is a table a caller can quietly go on
 * sending it to — and each of these reached a Korean screen or a model in its day.
 */
describe("the names one fact had twice", () => {
  const RETIRED = [
    // The server's for `laf:navigation_failed`.
    "laf:page_failed",
    // The server's for `laf:file_path_refused`, and for three facts the container already told apart.
    "laf:workspace_path_refused",
    "laf:workspace_file_unusable",
    // Fallbacks of the routes' own for `laf:stale_refs` and `laf:computer_failed`.
    "laf:snapshot_stale",
    "laf:computer_unavailable",
    // The client's for the masked box's `laf:element_not_actionable`.
    "laf:secret_field_gone",
  ];

  test("are known to no table on either side of the wire", () => {
    const tables: Record<string, Record<string, unknown>> = {
      COMPUTER_CODES,
      COMPUTER_ANSWERS,
      TOOL_RESULT_KO,
      OUTCOME_LABELS,
      SCREEN_PROBLEM_SAID,
      SECRET_REFUSALS,
    };
    const stillKnown = Object.entries(tables).flatMap(([name, table]) =>
      RETIRED.filter((code) => Object.hasOwn(table, code)).map(
        (code) => `${name}: ${code}`,
      ),
    );
    expect(stillKnown).toEqual([]);
  });
});
