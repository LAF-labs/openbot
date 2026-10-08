import { describe, expect, spyOn, test } from "bun:test";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "../src/computer/policy";
import {
  createPolicyStore,
  NOTES_RULE,
  parseActionPolicy,
  RETIRED_NOTES_RULE,
  revisionOf,
} from "../src/computer/policy-store";
import type { Database } from "../src/db/client";

/**
 * These test the decision, not the plumbing.
 *
 * Every case here is one a deployment can actually be in, and several are ones where the safe answer
 * is not the obvious one: a broken rule, an empty policy, a policy that is absent entirely. The
 * fail-closed paths are tested with the permissive path (`allow: ["true"]`) switched on, which proves
 * that denial still wins in the configuration deployments actually run.
 */

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tool: { name: "computer_click" },
    bot: { id: "risk-analyst" },
    actor: { id: "dev-local-user" },
    page: { url: "https://example.com/order", host: "example.com" },
    // The first time this Bot has made this call, which is what a context with nothing to say about
    // repetition means. Always present: an absent field throws inside CEL, and a throwing deny rule
    // denies, so a rule about repetition would otherwise refuse everything.
    repeat: { count: 1 },
    element: { ref: "e13", role: "button", name: "Submit order" },
    ...overrides,
  };
}

const permissive: ActionPolicy = {
  deny: [],
  ask: [],
  allow: ["true"],
};

/** A button a rule about paying would match, for the cases that need one. */
const PAY = { ref: "e13", role: "button", name: "Pay now" };

describe("evaluateActionPolicy", () => {
  test("an absent policy refuses, rather than permitting everything", () => {
    const decision = evaluateActionPolicy(undefined, context());
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(false);
    expect(decision.source).toBe("default");
  });

  test("an empty allow list refuses", () => {
    const decision = evaluateActionPolicy(
      { deny: [], ask: [], allow: [] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(false);
  });

  test("deny beats allow, even when allow matches everything", () => {
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['contains(element.name, "submit")'] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(false);
    expect(decision.source).toBe("deny");
    // The rule is named as a rule, and what KIND of refusal it was as a code. It used to be an
    // English sentence naming the button and the host, which is what the surface reads — so a
    // Korean screen showed English, and the trail could not be queried on the kind of refusal.
    expect(decision.matched).toBe('contains(element.name, "submit")');
    expect(decision.code).toBe("laf:policy_denied");
  });

  /*
   * ONE READING OF A NAME, AS THE BROWSER SPELLS IT. For a day (pull request 65) a spaced name was
   * also judged squeezed, because the list joined a nameless control's words with one space ("결 제"
   * for a 결제 button in two spans) and the hold let the click through on either spelling. The list
   * now asks the page for the browser's own name — that button is "결제" — and the hold matches it
   * exactly (agent-computer's `page-names.ts`, `label-hold.ts`), so the second reading is gone, and
   * with it the rules it fired that nobody wrote: measured 2026-10-04 on five Korean pages, the only
   * decisions it changed were two headlines, "입주 문턱" read as 주문 and "유출 금융" as 출금.
   */
  test("a label is judged once, as written", () => {
    const paying: ActionPolicy = {
      ...permissive,
      ask: ['matches(element.name, "결제|송금|주문")'],
    };
    const judged = (name: string) =>
      evaluateActionPolicy(
        paying,
        context({ element: { ref: "e1", role: "button", name } }),
      );
    expect(judged("결제").source).toBe("ask");
    expect(judged("결제").matched).toBe(
      'matches(element.name, "결제|송금|주문")',
    );
    expect(judged("바로 송금하기").source).toBe("ask");
    // Words that only meet across a space are not the word.
    expect(judged("입주 문턱 60세").source).toBe("allow");
    expect(judged("해결 제안").source).toBe("allow");
    // A name the browser itself spells apart — letters in inline-blocks — is judged as the browser
    // spells it, which is what the click is held to. A rule meant for it has to say it that way.
    expect(judged("결 제").source).toBe("allow");
    // An allow written for the words as the list shows them matches them.
    const exact: ActionPolicy = {
      deny: [],
      ask: [],
      allow: ['element.name == "Submit order"'],
    };
    const submit = evaluateActionPolicy(
      exact,
      context({ element: { ref: "e1", role: "button", name: "Submit order" } }),
    );
    expect(submit.source).toBe("allow");
    expect(submit.forward).toBe(true);
  });

  test("a deny rule leaves unrelated elements alone", () => {
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['contains(element.name, "submit")'] },
      context({ element: { ref: "e6", role: "input", name: "Large" } }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.forward).toBe(true);
  });

  test("substring matching is case-insensitive", () => {
    // A rule saying "never click submit" also catches uppercase button labels.
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['contains(element.name, "submit")'] },
      context({ element: { ref: "e1", role: "button", name: "SUBMIT NOW" } }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("a BROKEN deny expression still denies", () => {
    // Fail-closed. A typo in a rule must not quietly permit the thing it was written to forbid, even
    // though `allow: ["true"]` would otherwise let it straight through.
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ["this is not ( valid cel"] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("deny");
  });

  test("a broken allow expression does not permit", () => {
    const decision = evaluateActionPolicy(
      { deny: [], ask: [], allow: ["also not ( valid"] },
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("default");
  });

  test("a refused action does not go on to run, whatever a policy says about modes", () => {
    // `dry-run` recorded a refusal and let the action happen. It is gone (§7-10), and a policy that
    // still carries the field is enforced rather than believed — otherwise removing the mode would
    // quietly turn every deployment that had switched the boundary off back on without saying so,
    // or, worse, keep honouring it.
    const decision = evaluateActionPolicy(
      {
        deny: ['contains(element.name, "submit")'],
        ask: [],
        allow: ["true"],
      } as ActionPolicy,
      context(),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(false);
  });

  test("rules can be written against the tool, the host and the Bot", () => {
    const byTool = evaluateActionPolicy(
      { ...permissive, deny: ['tool.name == "computer_type"'] },
      context({ tool: { name: "computer_type" } }),
    );
    expect(byTool.allowed).toBe(false);

    const byHost = evaluateActionPolicy(
      { ...permissive, deny: ['page.host == "example.com"'] },
      context(),
    );
    expect(byHost.allowed).toBe(false);

    const byBot = evaluateActionPolicy(
      { ...permissive, deny: ['bot.id == "risk-analyst"'] },
      context(),
    );
    expect(byBot.allowed).toBe(false);
  });

  test("a rule about an element still decides when the element is unknown", () => {
    // An action on something the server could not resolve must be decided on, not waved through as
    // unrecognised. `contains` on a missing field throws, and a throwing deny expression denies.
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['contains(element.name, "submit")'] },
      context({ element: undefined }),
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("parseActionPolicy", () => {
  test("accepts a well-formed policy", () => {
    const result = parseActionPolicy({
      deny: ['contains(element.name, "pay")'],
      allow: ["true"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.deny).toHaveLength(1);
    }
  });

  test("defaults the lists", () => {
    const result = parseActionPolicy({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.deny).toEqual([]);
      expect(result.policy.ask).toEqual([]);
      expect(result.policy.allow).toEqual([]);
    }
  });

  test("a policy that still names a mode parses, and the mode does not survive it", () => {
    // Somebody's saved policy, or a copied `.env` line, from when `dry-run` existed. Refusing it
    // would stop a deployment booting over a field that no longer means anything; believing it
    // would leave the boundary switched off. It parses, and what comes out enforces.
    const result = parseActionPolicy({
      mode: "dry-run",
      deny: ['contains(element.name, "pay")'],
      allow: ["true"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.policy)).not.toContain("mode");
      expect(
        evaluateActionPolicy(result.policy, context({ element: PAY })).forward,
      ).toBe(false);
    }
  });

  test("a policy written before the ask list existed still parses", () => {
    // Every deployment already running has a saved policy with two lists in it. Rejecting one, or
    // reading its absence as anything other than "asks nobody anything", would change what an
    // existing boundary means at the moment the server came back up.
    const result = parseActionPolicy({
      deny: ['contains(element.name, "pay")'],
      allow: ["true"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.policy.ask).toEqual([]);
  });

  test("keeps the ask rules it was given", () => {
    const result = parseActionPolicy({
      deny: [],
      ask: ['intent == "write_file"'],
      allow: ["true"],
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.policy.ask).toEqual(['intent == "write_file"']);
  });

  test("rejects an ask list that is not a list of expressions", () => {
    expect(parseActionPolicy({ ask: "everything" }).ok).toBe(false);
    expect(parseActionPolicy({ ask: [7] }).ok).toBe(false);
  });

  test.each([
    ["not an object", "nonsense"],
    ["a non-list deny", { deny: "everything" }],
    ["a list of non-strings", { allow: [1, 2] }],
  ])("rejects %s rather than coercing it", (_label, input) => {
    // Rejected, not repaired. An operator must never be told a rule was stored when it was stored
    // differently, because they would believe a restriction is in force when it is not.
    expect(parseActionPolicy(input).ok).toBe(false);
  });
});

describe("the second door", () => {
  test("a rule can refuse a keypress, not only a click", () => {
    // Form submission can happen through a keypress as well as a click, so policy must see both
    // activation paths.
    const policy = {
      deny: ['tool.name == "computer_key" && key == "Enter"'],
      ask: [],
      allow: ["true"],
    };
    const refused = evaluateActionPolicy(policy, {
      tool: { name: "computer_key" },
      bot: { id: "sales" },
      actor: { id: "someone" },
      page: { url: "https://example.com/order", host: "example.com" },
      repeat: { count: 1 },
      key: "Enter",
    });
    expect(refused.allowed).toBe(false);

    // And an ordinary keystroke still goes through, or the Bot could not type at all.
    const allowed = evaluateActionPolicy(policy, {
      tool: { name: "computer_key" },
      bot: { id: "sales" },
      actor: { id: "someone" },
      page: { url: "https://example.com/order", host: "example.com" },
      repeat: { count: 1 },
      key: "a",
    });
    expect(allowed.allowed).toBe(true);
  });

  test("a rule can refuse the type tool's own Enter, which is neither a click nor a keypress", () => {
    // The type tool takes a flag meaning "and submit", and the computer presses Enter itself, so no
    // keypress ever arrives as an action of its own. A boundary written about clicking and about
    // `key` watched the one call that submits a single-field form go straight past it.
    const policy = {
      deny: [
        '(intent == "activate" && contains(element.name, "submit")) || (tool.name == "computer_key" && key == "Enter") || submit',
      ],
      ask: [],
      allow: ["true"],
    };
    const typing = (submit: boolean): PolicyContext => ({
      tool: { name: "computer_type" },
      bot: { id: "sales" },
      actor: { id: "someone" },
      page: { url: "https://example.com/order", host: "example.com" },
      // `repeat` is on every context by contract — an absent field throws inside CEL and a thrown
      // deny denies, so a fixture without it is a deployment that refuses everything the moment
      // anybody writes a rule about repetition.
      repeat: { count: 1 },
      element: { ref: "e6", role: "input", name: "Postcode" },
      intent: "type",
      submit,
    });

    expect(evaluateActionPolicy(policy, typing(true)).allowed).toBe(false);
    // Filling the field in is still allowed, or the rule would stop the Bot typing at all.
    expect(evaluateActionPolicy(policy, typing(false)).allowed).toBe(true);
    // And the same rule stays evaluable on an action that cannot submit anything, which is why the
    // field is on every context rather than only on the calls that can set it.
    expect(
      evaluateActionPolicy(policy, {
        tool: { name: "computer_scroll" },
        bot: { id: "sales" },
        actor: { id: "someone" },
        page: { url: "https://example.com/order", host: "example.com" },
        repeat: { count: 1 },
        intent: "read",
        submit: false,
      }).allowed,
    ).toBe(true);
  });
});

/**
 * `intent` describes the effect rather than the mechanism. `tool.name` says which tool was used; an
 * operator writes rules about the action's effect, and a button can be pressed three different ways.
 */
describe("a rule written about what an action does", () => {
  const activate = (extra: Partial<PolicyContext> = {}): PolicyContext => ({
    tool: { name: "computer_click" },
    bot: { id: "b" },
    actor: { id: "a" },
    page: { url: "https://example.com/", host: "example.com" },
    repeat: { count: 1 },
    intent: "activate",
    ...extra,
  });

  const policy = {
    deny: ['intent == "activate" && contains(element.name, "submit")'],
    ask: [],
    allow: ["true"],
  };

  test("catches the click on the button", () => {
    const decision = evaluateActionPolicy(
      policy,
      activate({
        element: { ref: "e1", role: "button", name: "Submit order" },
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("catches Enter pressed on the same button, which a rule about clicking did not", () => {
    const decision = evaluateActionPolicy(
      policy,
      activate({
        tool: { name: "computer_key" },
        key: "Enter",
        element: { ref: "e1", role: "button", name: "Submit order" },
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("catches Space on it too", () => {
    const decision = evaluateActionPolicy(
      policy,
      activate({
        tool: { name: "computer_key" },
        key: "Space",
        element: { ref: "e1", role: "button", name: "Submit order" },
      }),
    );
    expect(decision.allowed).toBe(false);
  });

  test("leaves ordinary typing alone", () => {
    const decision = evaluateActionPolicy(policy, {
      ...activate(),
      tool: { name: "computer_type" },
      intent: "type",
      element: { ref: "e2", role: "textbox", name: "Customer name:" },
    });
    expect(decision.allowed).toBe(true);
  });

  /**
   * `intent` describes the addressed element, not the form submission side effect. A keypress in a
   * field submits the form, and the element it names is the field. Only a rule that refuses Enter
   * outright stops that, which is why the shipped preset still does.
   */
  test("does NOT catch Enter in a text field, which is why the preset also refuses Enter", () => {
    const inField = activate({
      tool: { name: "computer_key" },
      key: "Enter",
      element: { ref: "e3", role: "textbox", name: "E-mail address:" },
    });

    expect(evaluateActionPolicy(policy, inField).allowed).toBe(true);

    const withEnterRefused = {
      ...policy,
      deny: [...policy.deny, 'key == "Enter"'],
    };
    expect(evaluateActionPolicy(withEnterRefused, inField).allowed).toBe(false);
  });
});

/**
 * A rule about keypresses must not refuse everything else.
 *
 * `key` exists only on a keypress. An expression naming an absent identifier errors, and the engine
 * treats an error as a refusal, correctly, since a rule nobody can evaluate must not wave things
 * through. A bare `key == "Enter"` therefore refuses navigation too; scoped rules guard on the tool
 * name before reading key-specific fields.
 */
describe("a rule that names an identifier only some actions carry", () => {
  const navigating: PolicyContext = {
    tool: { name: "computer_navigate" },
    bot: { id: "b" },
    actor: { id: "a" },
    page: { url: "https://httpbin.org/forms/post", host: "httpbin.org" },
    repeat: { count: 1 },
    intent: "navigate",
  };

  test("unguarded, it refuses a navigation that has no key at all", () => {
    const decision = evaluateActionPolicy(
      { deny: ['key == "Enter"'], ask: [], allow: ["true"] },
      navigating,
    );
    // Failing closed on an unevaluable rule is the safe answer. The shipped preset carries the guard
    // below to keep this rule scoped to keypresses.
    expect(decision.allowed).toBe(false);
  });

  test("guarded by the tool name, the navigation is allowed", () => {
    const decision = evaluateActionPolicy(
      {
        deny: ['tool.name == "computer_key" && key == "Enter"'],
        ask: [],
        allow: ["true"],
      },
      navigating,
    );
    expect(decision.allowed).toBe(true);
  });

  test("and the guarded rule still refuses the keypress it is about", () => {
    const decision = evaluateActionPolicy(
      {
        deny: ['tool.name == "computer_key" && key == "Enter"'],
        ask: [],
        allow: ["true"],
      },
      {
        ...navigating,
        tool: { name: "computer_key" },
        intent: "activate",
        key: "Enter",
        element: { ref: "e1", role: "textbox", name: "E-mail address:" },
      },
    );
    expect(decision.allowed).toBe(false);
  });
});

/**
 * The third answer, and the order it is asked in.
 *
 * Precedence is the whole design here and none of it is visible from the types. An ask that could
 * soften a deny would let a person wave through something a deployment forbade; an ask evaluated
 * after allow would never fire at all, because the shipped policy permits everything. Both mistakes
 * produce a rule that looks configured and does nothing anybody intended, so both are tested against
 * the permissive default deployments actually run.
 */
describe("asking a person", () => {
  const asking: ActionPolicy = {
    ...permissive,
    ask: ['contains(element.name, "submit")'],
  };

  test("an ask beats allow, in the configuration everybody ships with", () => {
    const decision = evaluateActionPolicy(asking, context());
    expect(decision.source).toBe("ask");
    expect(decision.allowed).toBe(false);
    // Nothing happens until somebody says so.
    expect(decision.forward).toBe(false);
    expect(decision.matched).toBe('contains(element.name, "submit")');
  });

  test("a deny beats an ask, so a forbidden thing is never offered as a question", () => {
    const decision = evaluateActionPolicy(
      { ...asking, deny: ['contains(element.name, "submit")'] },
      context(),
    );
    expect(decision.source).toBe("deny");
  });

  test("an ask rule leaves everything else alone", () => {
    const decision = evaluateActionPolicy(
      asking,
      context({ element: { ref: "e6", role: "input", name: "Quantity" } }),
    );
    expect(decision.source).toBe("allow");
    expect(decision.allowed).toBe(true);
  });

  test("a BROKEN ask expression asks, rather than quietly permitting", () => {
    // Fail-closed, the same way a broken deny denies. A typo in the rule interrupts somebody, which
    // is a nuisance; the alternative is that `allow: ["true"]` waves through exactly the action the
    // rule was written to hold back, and nothing anywhere says so.
    const decision = evaluateActionPolicy(
      { ...permissive, ask: ["this is not ( valid cel"] },
      context(),
    );
    expect(decision.source).toBe("ask");
    expect(decision.forward).toBe(false);
  });

  test("a rule about an element still asks when the element is unknown", () => {
    // `contains` on a missing field throws, and a throwing ask expression asks. An action on
    // something the server could not resolve is exactly the case a person should look at.
    const decision = evaluateActionPolicy(
      asking,
      context({ element: undefined }),
    );
    expect(decision.source).toBe("ask");
  });

  test("an ask stops the action, and does not let it through as a note", () => {
    // What `dry-run` used to do to an ask: record the question and carry on. Nothing happens now
    // until somebody says so, which is the only reading of "ask me first" a person would expect.
    const decision = evaluateActionPolicy(asking, context());
    expect(decision.source).toBe("ask");
    expect(decision.allowed).toBe(false);
    expect(decision.forward).toBe(false);
  });

  /*
   * NOT ONE WORD OF ENGLISH LEAVES THIS FILE.
   *
   * These three replace four tests that asserted the opposite — that a decision's `reason` named the
   * button and the host, the file, or the tool and its server. It did, in English sentences this
   * module assembled, and `approval-request.tsx` drew them verbatim on a Korean screen while the MCP
   * path filled the same field with Korean (docs/laf/redesign-2026-09.md §3.1, §5.1(b)).
   *
   * What a decision may now carry is a rule (which is CEL, written by an administrator, and shown as
   * one), a source, two booleans and a `laf:` code. Anything else is prose on its way to a surface,
   * and this is what notices.
   */
  const SAYS_NOTHING = new Set([
    "allowed",
    "matched",
    "source",
    "forward",
    "code",
  ]);

  const CONTEXTS = [
    ["a browser action", context({ intent: "activate" })],
    [
      "a file action",
      context({
        tool: { name: "computer_write_file" },
        intent: "write_file",
        element: undefined,
        file: {
          path: "reports/august.csv",
          name: "august.csv",
          extension: "csv",
          folder: "reports",
        },
      }),
    ],
    [
      "a tool call",
      {
        tool: { name: "mcp__jira__editJiraIssue" },
        bot: { id: "b" },
        actor: { id: "a" },
        page: { url: "", host: "" },
        repeat: { count: 1 },
        element: { ref: "", role: "", name: "", type: "" },
        key: "",
        submit: false,
        file: { path: "", name: "", extension: "", folder: "" },
        intent: "write_tool" as const,
        mcp: {
          server: "jira",
          tool: "editJiraIssue",
          effect: "write" as const,
        },
      },
    ],
  ] as const;

  for (const [what, judged] of CONTEXTS) {
    test(`${what} is decided in facts, never in words`, () => {
      for (const policy of [
        { ...permissive, ask: ["true"] },
        { ...permissive, deny: ["true"] },
        permissive,
      ]) {
        const decision = evaluateActionPolicy(policy, judged);
        expect(
          Object.keys(decision).filter((key) => !SAYS_NOTHING.has(key)),
        ).toEqual([]);
        // A code is a fact somebody can look up, and only a refusal has one to give.
        if (decision.code) expect(decision.code).toMatch(/^laf:[a-z_]+$/);
        if (decision.source === "ask") expect(decision.code).toBeUndefined();
      }
    });
  }

  test("an empty allow list still refuses what nobody asked about", () => {
    // The floor is unchanged. An ask list is a third answer, not a way of turning default-deny into
    // default-ask: an action no rule mentions is still refused rather than put to somebody.
    const decision = evaluateActionPolicy(
      {
        deny: [],
        ask: ['tool.name == "computer_write_file"'],
        allow: [],
      },
      context(),
    );
    expect(decision.source).toBe("default");
    expect(decision.allowed).toBe(false);
  });
});

/**
 * The one attribute that separates the thirtieth click on a button from the first.
 *
 * Both are the same action on the same element, and any rule able to refuse the thirtieth by its
 * shape would refuse the first as well. So the count is the whole of it, and these check that a rule
 * written against it actually evaluates: `repeat` is a nested field like `page` and `element`, and a
 * rule the engine cannot evaluate denies, which would turn one restriction into a Bot that can do
 * nothing at all.
 */
describe("a rule about a Bot repeating itself", () => {
  const repeating: ActionPolicy = {
    deny: ["repeat.count >= 10"],
    ask: [],
    allow: ["true"],
  };

  test("leaves the attempts below the line alone", () => {
    expect(
      evaluateActionPolicy(repeating, context({ repeat: { count: 9 } }))
        .allowed,
    ).toBe(true);
  });

  test("refuses the attempt that crosses it, not the one after", () => {
    const decision = evaluateActionPolicy(
      repeating,
      context({ repeat: { count: 10 } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.matched).toBe("repeat.count >= 10");
  });

  test("goes on refusing past it", () => {
    expect(
      evaluateActionPolicy(repeating, context({ repeat: { count: 40 } }))
        .allowed,
    ).toBe(false);
  });
});
/**
 * Whether a question may be answered for good, as it arrives over HTTP.
 *
 * Rejected rather than coerced, like everything else here. A typo silently meaning "allowed" is the
 * direction that loosens a boundary, and an operator would believe a restriction is in force when
 * it is not — which is the one behaviour this parser exists to prevent.
 */
describe("standing allowances in a policy", () => {
  const base = { deny: [], ask: [], allow: ["true"] };

  test("absent means allowed, so an older policy still means what it meant", () => {
    const parsed = parseActionPolicy(base);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.policy.settleWithoutAsking).toBeUndefined();
  });

  test("takes the two it allows", () => {
    for (const value of ["allowed", "off"] as const) {
      const parsed = parseActionPolicy({ ...base, settleWithoutAsking: value });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.policy.settleWithoutAsking).toBe(value);
    }
  });

  test("refuses anything else rather than reading it as allowed", () => {
    expect(parseActionPolicy({ ...base, settleWithoutAsking: "no" }).ok).toBe(
      false,
    );
    expect(parseActionPolicy({ ...base, settleWithoutAsking: false }).ok).toBe(
      false,
    );
  });
});

/**
 * THE ONE RULE THIS SERVER NO LONGER TAKES (`policy-store.ts`, `RETIRED_NOTES_RULE`).
 *
 * The boundaries screen's notes preset wrote it; it exempts a folder by a match that ignores letter
 * case, so `Notes/x.md` got past it. A migration rewrites a stored copy, and it still came back: in
 * a save from a window that read the boundary before the upgrade, and from configuration. So it is
 * refused where a policy comes in — this function, which the route and the configuration both use.
 */
describe("the rule that is not taken any more", () => {
  const taking = (lists: {
    deny?: string[];
    ask?: string[];
    allow?: string[];
  }) => parseActionPolicy({ deny: [], ask: [], allow: ["true"], ...lists });

  test("is refused in the two lists that hold an action back, by name and with what to write instead", () => {
    for (const list of ["ask", "deny"] as const) {
      for (const rules of [
        [RETIRED_NOTES_RULE],
        ["repeat.count >= 5", RETIRED_NOTES_RULE, 'intent == "upload"'],
      ]) {
        expect(taking({ [list]: rules })).toEqual({
          ok: false,
          code: "laf:policy_rule_retired",
          list,
          rule: RETIRED_NOTES_RULE,
          replacement: NOTES_RULE,
        });
      }
    }
    // In both at once it is the list that is read first that is named, and it is still one refusal.
    expect(
      taking({ deny: [RETIRED_NOTES_RULE], ask: [RETIRED_NOTES_RULE] }),
    ).toMatchObject({ ok: false, list: "deny" });
  });

  test("is looked for last: a body that is no policy at all is told that, whether or not it holds the rule", () => {
    // The route answers this refusal after the mark and every other before it (`routes.ts`). Met
    // before the switch was looked at, a body that was no policy and also held the rule went the
    // later way, and was told its copy of the boundary was old.
    expect(
      taking({ ask: [RETIRED_NOTES_RULE], allow: "true" as never }),
    ).toEqual({ ok: false, code: "laf:policy_list_invalid", list: "allow" });
    expect(
      parseActionPolicy({
        deny: [RETIRED_NOTES_RULE],
        ask: [RETIRED_NOTES_RULE],
        allow: ["true"],
        settleWithoutAsking: "sometimes",
      }),
    ).toEqual({ ok: false, code: "laf:policy_settle_invalid" });
  });

  test("is taken in `allow`, where it is a narrower grant and not an exemption", () => {
    // The migration leaves it there too. And the screen sends `allow` back as it read it, with no
    // way to edit it: refused there, a deployment holding it could never change a rule again.
    const parsed = taking({ allow: [RETIRED_NOTES_RULE, "true"] });
    expect(parsed).toEqual({
      ok: true,
      policy: { deny: [], ask: [], allow: [RETIRED_NOTES_RULE, "true"] },
    });
  });

  test("is exactly that one string: a rule that only looks like it is somebody's own, and the rule that replaced it is a rule", () => {
    const theirs = [
      `${RETIRED_NOTES_RULE} `,
      ` ${RETIRED_NOTES_RULE}`,
      RETIRED_NOTES_RULE.replace("^notes/", "^private/"),
      RETIRED_NOTES_RULE.replace("^notes/", "^Notes/"),
      RETIRED_NOTES_RULE.replace("!matches", "! matches"),
      RETIRED_NOTES_RULE.replaceAll('"', "'"),
      `(${RETIRED_NOTES_RULE}) || submit`,
      `${RETIRED_NOTES_RULE} && bot.id == "bot-1"`,
      NOTES_RULE,
    ];
    for (const list of ["ask", "deny"] as const) {
      const parsed = taking({ [list]: theirs });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.policy[list]).toEqual(theirs);
    }
  });

  test("the rule it names instead asks about everything the old one asked about, and about another lettering", () => {
    // What "write this in its place" is worth, at the evaluator: with the file as `govern` hands
    // it over (`gateway/addresses.ts`; in front of the real workspace in
    // `gateway-file-paths.test.ts`).
    const writing = (path: string, folder: string) =>
      context({
        tool: { name: "computer_write_file" },
        intent: "write_file",
        file: {
          path,
          name: path.split("/").pop() ?? "",
          extension: "md",
          folder,
        },
      });
    const asks = (rule: string, about: PolicyContext) =>
      evaluateActionPolicy({ deny: [], ask: [rule], allow: ["true"] }, about)
        .source === "ask";
    for (const [path, folder, before, now] of [
      ["notes/x.md", "notes", false, false],
      ["private/x.md", "private", true, true],
      ["x.md", "", true, true],
      ["Notes/x.md", "Notes", false, true],
      ["NOTES/x.md", "NOTES", false, true],
    ] as const) {
      expect([path, asks(RETIRED_NOTES_RULE, writing(path, folder))]).toEqual([
        path,
        before,
      ]);
      expect([path, asks(NOTES_RULE, writing(path, folder))]).toEqual([
        path,
        now,
      ]);
    }
  });
});

/**
 * WHICH BOUNDARY A WRITE WAS MADE AGAINST (`policy-store.ts`, `revisionOf`).
 *
 * The screen that edits the policy sends the whole of it back, so a window holding an older copy
 * would undo whatever was decided since. Every write names the boundary it read, by its mark, and
 * one made against a boundary that is no longer in force stores nothing.
 */
describe("the boundary's mark, and a write made against it", () => {
  const P: ActionPolicy = { deny: ["a"], ask: ["b"], allow: ["true"] };

  test("the same boundary has the same mark, and anything a decision could turn on gives another", () => {
    expect(revisionOf(P)).toBe(
      revisionOf({ deny: ["a"], ask: ["b"], allow: ["true"] }),
    );
    // Absent means allowed, so that is one boundary said two ways.
    expect(revisionOf({ ...P, settleWithoutAsking: "allowed" })).toBe(
      revisionOf(P),
    );
    const others: ActionPolicy[] = [
      { ...P, settleWithoutAsking: "off" },
      { ...P, deny: [] },
      { ...P, deny: ["a", "a2"] },
      { ...P, ask: ["b "] },
      { ...P, allow: [] },
      // A rule moved from one list to another, and two rules that are one string cut elsewhere.
      { deny: [], ask: ["a", "b"], allow: ["true"] },
      { deny: ["a", "b"], ask: [], allow: ["true"] },
      { deny: ["a,b"], ask: [], allow: ["true"] },
      { deny: ['a","b'], ask: [], allow: ["true"] },
      // The order of a list is part of it: the first rule that matches is the one on the row.
      { deny: ["a"], ask: ["b"], allow: ["true", "x"] },
      { deny: ["a"], ask: ["b"], allow: ["x", "true"] },
    ];
    const marks = others.map(revisionOf);
    expect(new Set([revisionOf(P), ...marks]).size).toBe(others.length + 1);
  });

  test("a write made against the boundary in force is stored, and one made against any other stores nothing", async () => {
    const store = createPolicyStore(P);
    const read = store.revision();
    expect(read).toBe(revisionOf(P));

    expect(
      await store.set({ ...P, ask: ["first"] }, { revision: read }),
    ).toEqual({ stored: true });
    expect(store.get().ask).toEqual(["first"]);
    expect(store.revision()).not.toBe(read);

    // The mark that was good a moment ago, no mark, and one that never was.
    for (const revision of [read, "", "not a mark"]) {
      const held = store.get();
      expect(
        await store.set(
          { deny: [], ask: [], allow: ["true"], settleWithoutAsking: "off" },
          { revision },
        ),
      ).toEqual({ stored: false });
      expect(await store.reset({ revision })).toEqual({ stored: false });
      expect(store.get()).toBe(held);
    }
    // Going back to configuration is a write like any other, held to the same mark.
    expect(await store.reset({ revision: store.revision() })).toEqual({
      stored: true,
    });
    expect(store.get()).toEqual(P);
    expect(store.revision()).toBe(read);
  });

  /** A record that takes a moment to write, and says what reached it. */
  function slowRecord(options: { refuses?: () => boolean } = {}) {
    const written: string[][] = [];
    const later = () => new Promise((resolve) => setTimeout(resolve, 5));
    const database = {
      insert: () => ({
        values: (row: { ask: string[] }) => ({
          onConflictDoUpdate: async () => {
            await later();
            if (options.refuses?.()) throw new Error("the record is gone");
            written.push(row.ask);
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          await later();
          written.push(["(reset)"]);
        },
      }),
    } as unknown as Database;
    return { database, written };
  }

  test("two writes made against one boundary, the first still on its way to the record: one is stored", async () => {
    // What the lock is for. Left to interleave, both pass the check while the first is being
    // written, and the second is written over it — the lost update, inside one process.
    const { database, written } = slowRecord();
    const store = createPolicyStore(P, database);
    const read = store.revision();

    const [first, second, third] = await Promise.all([
      store.set({ ...P, ask: ["first"] }, { revision: read }),
      store.set({ ...P, ask: ["second"] }, { revision: read }),
      store.reset({ revision: read }),
    ]);
    expect([first, second, third]).toEqual([
      { stored: true },
      { stored: false },
      { stored: false },
    ]);
    expect(written).toEqual([["first"]]);
    expect(store.get().ask).toEqual(["first"]);
  });

  test("a write the record refuses leaves the boundary and its mark as they were, and the next write is taken", async () => {
    let refusing = true;
    const { database, written } = slowRecord({ refuses: () => refusing });
    const store = createPolicyStore(P, database);
    const read = store.revision();

    const failed = await store
      .set({ ...P, ask: ["lost"] }, { revision: read })
      .then(
        () => "stored",
        (error: unknown) => (error as Error).message,
      );
    expect(failed).toBe("the record is gone");
    expect(store.get()).toEqual(P);
    expect(store.revision()).toBe(read);

    // The queue did not stop with it, and the mark the writer read is still the one in force.
    refusing = false;
    expect(
      await store.set({ ...P, ask: ["kept"] }, { revision: read }),
    ).toEqual({ stored: true });
    expect(written).toEqual([["kept"]]);
  });
});

/**
 * WHAT THE RECORD IS HANDED, AND WHAT A BOOT SAYS ABOUT THE ROW IT READ.
 *
 * Two things nothing held (the last read of this change, 2026-10-07): who saved the boundary could
 * be dropped from the row on either branch of the upsert, and a row still holding the rule that is
 * not taken was loaded without a word — found out later by somebody whose save was refused.
 */
describe("the row a boundary is kept in", () => {
  type Kept = {
    deny: string[];
    ask: string[];
    allow: string[];
    settleWithoutAsking: string | null;
    updatedBy: string | null;
  };

  /** A record of one row, behind the shape of the statements the store makes. */
  function record(row: Kept | null = null) {
    const handed: { values: Kept; set: Kept }[] = [];
    const database = {
      insert: () => ({
        values: (values: Kept) => ({
          onConflictDoUpdate: async (conflict: { set: Kept }) => {
            handed.push({ values, set: conflict.set });
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (row ? [row] : []) }),
        }),
      }),
    } as unknown as Database;
    return { database, handed };
  }

  /** Every line the logger printed while `act` ran, as the objects they are. */
  async function printedDuring(act: () => Promise<unknown>) {
    const lines: Record<string, unknown>[] = [];
    const spies = (["error", "warn", "log"] as const).map((method) =>
      spyOn(console, method).mockImplementation((line: unknown) => {
        lines.push(JSON.parse(String(line)) as Record<string, unknown>);
      }),
    );
    await act().then(
      () => undefined,
      () => undefined,
    );
    for (const spy of spies) spy.mockRestore();
    return lines;
  }

  test("who saved it is on the row whether the row is new or written over, and nobody is nobody", async () => {
    const P: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
    const { database, handed } = record();
    const store = createPolicyStore(P, database);

    await store.set(
      { ...P, ask: ["first"] },
      { revision: store.revision(), by: "manager@laf.test" },
    );
    await store.set({ ...P, ask: ["second"] }, { revision: store.revision() });

    expect(
      handed.map(({ values, set }) => [
        values.ask,
        values.updatedBy,
        set.ask,
        set.updatedBy,
      ]),
    ).toEqual([
      [["first"], "manager@laf.test", ["first"], "manager@laf.test"],
      [["second"], null, ["second"], null],
    ]);
  });

  test("a row that still holds the rule that is not taken is enforced as written, and said once per list at boot", async () => {
    const stuck: Kept = {
      deny: [],
      ask: ["repeat.count >= 5", RETIRED_NOTES_RULE],
      allow: [RETIRED_NOTES_RULE, "true"],
      settleWithoutAsking: null,
      updatedBy: null,
    };
    const store = createPolicyStore(
      { deny: [], ask: [], allow: ["true"] },
      record(stuck).database,
    );
    const lines = await printedDuring(() => store.load());

    // Not mended on the way in: the boundary a deployment saved is the one it gets back.
    expect(store.get().ask).toEqual(stuck.ask);
    const said = lines.filter(
      (line) => line.event === "computer_policy_retired_rule_held",
    );
    // `allow` holds it too and is not named: there it is a narrower grant, and it is taken.
    expect(
      said.map((line) => [line.level, line.list, line.replacement]),
    ).toEqual([["warn", "ask", NOTES_RULE]]);
  });

  test("a row the migration rewrote, and no row at all, say nothing", async () => {
    const migrated: Kept = {
      deny: [],
      ask: [NOTES_RULE],
      allow: ["true"],
      settleWithoutAsking: null,
      updatedBy: null,
    };
    for (const row of [migrated, null]) {
      const store = createPolicyStore(
        { deny: [], ask: [], allow: ["true"] },
        record(row).database,
      );
      const lines = await printedDuring(() => store.load());
      expect(lines).toEqual([]);
    }
  });
});
