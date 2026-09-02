import { describe, expect, test } from "bun:test";
import {
  type AskSubject,
  describeSubject,
  subjectPhrases,
  timeLeftToAnswer,
} from "../src/lib/approvals";
import { ko } from "../src/lib/i18n-ko";

/**
 * EVERY QUESTION THE SERVER CAN RAISE HAS KOREAN, AND THIS IS WHAT SAYS SO.
 *
 * The server sends `{intent, host, element, file, tool, reason}` and the surface writes the
 * sentence — which means the sentence is chosen by `t()` on a VARIABLE, and `i18n-coverage.test.ts`
 * cannot see those (it reads literal `t("…")` out of the source, which is everything it can
 * honestly check). So the combinations are walked here instead, the way the presets and the tool
 * result codes are.
 *
 * The lists below are the server's, not a subset: `AskIntent` and `AskReason` in
 * `server/src/computer/approvals.ts` are what the gateway and the plugin call path can emit, and
 * `satisfies` makes a member added there a typecheck error here rather than a card that renders an
 * English sentence in a Korean product.
 */

const INTENTS = Object.keys({
  navigate: true,
  activate: true,
  type: true,
  read: true,
  read_file: true,
  write_file: true,
  list_files: true,
  upload: true,
  call_tool: true,
  act: true,
} satisfies Record<AskSubject["intent"], true>) as AskSubject["intent"][];

const REASONS = Object.keys({
  policy_ask: true,
  guard_floor: true,
  repeat: true,
  unannotated: true,
} satisfies Record<AskSubject["reason"], true>) as AskSubject["reason"][];

const GUARDS = ["money", "external", "destructive", "unannotated"] as const;

/**
 * The shapes one intent arrives in.
 *
 * A browser question can be missing its element (the ref resolved to nothing), its host (no snapshot
 * yet) or both, and each combination is a different sentence — the version that filled a hole with
 * an empty string produced "The Bot wants to call ." in front of somebody, with two buttons under
 * it, which is what this walks every combination to avoid.
 */
function shapesOf(
  intent: AskSubject["intent"],
  reason: AskSubject["reason"],
): AskSubject[] {
  const guard = reason === "unannotated" ? "unannotated" : "money";
  const base = {
    intent,
    reason,
    ...(reason === "repeat" ? { repeatCount: 5 } : {}),
  } as const;
  if (intent === "call_tool") {
    return [
      {
        kind: "tool",
        ...base,
        tool: { server: "notion", name: "create_page", guard },
      },
      {
        kind: "tool",
        ...base,
        tool: { server: "notion", name: "create_page" },
      },
    ];
  }
  if (intent === "read_file" || intent === "write_file") {
    return [{ kind: "file", ...base, file: { path: "workspace/정산.xlsx" } }];
  }
  if (intent === "list_files") {
    return [
      { kind: "file", ...base, file: { path: "." } },
      { kind: "file", ...base, file: { path: "reports" } },
    ];
  }
  return [
    {
      kind: "browser",
      ...base,
      host: "admin.example.com",
      path: "/settlements",
      element: { role: "button", name: "출금 승인" },
    },
    { kind: "browser", ...base, element: { role: "button", name: "Submit" } },
    { kind: "browser", ...base, host: "admin.example.com" },
    { kind: "browser", ...base },
  ];
}

describe("saying what a Bot is about to do", () => {
  test("every intent and reason the server can emit has Korean", () => {
    const missing: string[] = [];
    for (const intent of INTENTS) {
      for (const reason of REASONS) {
        for (const subject of shapesOf(intent, reason)) {
          const said = subjectPhrases(subject);
          for (const phrase of [said.action, said.reason]) {
            if (!phrase) continue;
            if (!(phrase.key in ko)) {
              missing.push(`${intent}/${reason}: ${phrase.key}`);
            }
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("a guard is named whichever one it is", () => {
    const missing = GUARDS.filter((guard) => {
      const said = subjectPhrases({
        kind: "tool",
        intent: "call_tool",
        tool: { server: "notion", name: "create_page", guard },
        reason: guard === "unannotated" ? "unannotated" : "guard_floor",
      });
      return !said.reason || !(said.reason.key in ko);
    });
    expect(missing).toEqual([]);
  });

  /*
   * The three the vocabulary memo asked for by name, written out. A table test proves an entry
   * exists; these prove the sentence is the one somebody would recognise, with the values in it.
   */
  test("the sentence carries the facts it was given", () => {
    expect(
      describeSubject({
        kind: "browser",
        intent: "activate",
        host: "admin.example.com",
        element: { role: "button", name: "출금 승인" },
        reason: "policy_ask",
      }),
    ).toContain("출금 승인");
    expect(
      describeSubject({
        kind: "file",
        intent: "write_file",
        file: { path: "workspace/reports/정산.xlsx" },
        reason: "policy_ask",
      }),
    ).toContain("workspace/reports/정산.xlsx");
    const tool = describeSubject({
      kind: "tool",
      intent: "call_tool",
      tool: { server: "notion", name: "create_page", guard: "external" },
      reason: "guard_floor",
    });
    expect(tool).toContain("notion");
    expect(tool).toContain("create_page");
    // The guard is said as well as the tool: a person deciding about an outward-facing call is
    // deciding about something the tool's name alone does not tell them.
    expect(
      subjectPhrases({
        kind: "tool",
        intent: "call_tool",
        tool: { server: "notion", name: "create_page", guard: "external" },
        reason: "guard_floor",
      }).reason?.key,
    ).toBe("The tool is declared as one that sends something outward.");
  });

  test("a question about repetition says how many times", () => {
    const said = subjectPhrases({
      kind: "browser",
      intent: "activate",
      host: "example.com",
      element: { role: "button", name: "다시" },
      repeatCount: 5,
      reason: "repeat",
    });
    expect(said.reason?.params).toEqual({ count: 5 });
  });

  /*
   * The particle, which is why the sentence cannot carry it. Korean picks 을 or 를 by whether the
   * label ends in a consonant, and the label is a variable — so it is a parameter the dictionary
   * entry places, and a label that is not Hangul gets the form Korean writing uses when the reading
   * is not known.
   */
  test("the object particle follows the label it is attached to", () => {
    const particleFor = (name: string) =>
      subjectPhrases({
        kind: "browser",
        intent: "activate",
        element: { role: "button", name },
        reason: "policy_ask",
      }).action.params.particle;
    // 승인 ends in ㄴ, 이체 does not.
    expect(particleFor("출금 승인")).toBe("을");
    expect(particleFor("이체")).toBe("를");
    expect(particleFor("Submit")).toBe("을(를)");
  });
});

describe("how long is left to answer", () => {
  const now = Date.parse("2026-09-03T09:00:00.000Z");

  test("counts in minutes, then in seconds, then stops", () => {
    expect(timeLeftToAnswer("2026-09-03T09:09:30.000Z", now)).toBe("10m left");
    expect(timeLeftToAnswer("2026-09-03T09:00:45.000Z", now)).toBe("45s left");
    expect(timeLeftToAnswer("2026-09-03T08:59:00.000Z", now)).toBe(
      "Time is up",
    );
  });

  test("says nothing at all when there is no expiry to count", () => {
    // An older reply, or a room frame from a server that has not been restarted. A card with no
    // clock is better than a card with a made-up one.
    expect(timeLeftToAnswer("", now)).toBeNull();
    expect(timeLeftToAnswer("whenever", now)).toBeNull();
  });

  test("every word of the countdown has Korean", () => {
    for (const key of ["{minutes}m left", "{seconds}s left", "Time is up"]) {
      expect({ key, translated: key in ko }).toEqual({ key, translated: true });
    }
  });
});
