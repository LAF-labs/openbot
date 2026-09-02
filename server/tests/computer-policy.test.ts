import { describe, expect, test } from "bun:test";
import {
  type ActionPolicy,
  evaluateActionPolicy,
  type PolicyContext,
} from "../src/computer/policy";
import { parseActionPolicy } from "../src/computer/policy-store";

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
    // The reason is read by a person and names both the thing and the rule.
    expect(decision.reason).toContain("Submit order");
    expect(decision.reason).toContain("example.com");
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

  test("the question names what is about to happen, and not the rule", () => {
    // The rule travels as its own field. A person answering a question about a button should not
    // have to read CEL to work out what they are agreeing to.
    const decision = evaluateActionPolicy(
      asking,
      context({ intent: "activate" }),
    );
    expect(decision.reason).toContain("Submit order");
    expect(decision.reason).toContain("example.com");
    expect(decision.reason).not.toContain("contains(");
  });

  test("a file question names the file rather than whatever page is open", () => {
    const decision = evaluateActionPolicy(
      { ...permissive, ask: ['intent == "write_file"'] },
      context({
        tool: { name: "computer_write_file" },
        intent: "write_file",
        element: undefined,
        file: {
          path: "reports/august.csv",
          name: "august.csv",
          extension: "csv",
        },
      }),
    );
    expect(decision.reason).toContain("reports/august.csv");
    expect(decision.reason).not.toContain("example.com");
  });

  test("a question about a tool call names the tool and the server", () => {
    // The context a tool call is judged in fills the browser fields with empty strings on purpose,
    // so that a rule about element names evaluates to false rather than becoming unevaluable. Read
    // as though a file were present, that produced "The Bot wants to call ." in front of a person,
    // with two buttons under it.
    const decision = evaluateActionPolicy(
      { ...permissive, ask: ['intent == "write_tool"'] },
      {
        tool: { name: "mcp__jira__editJiraIssue" },
        bot: { id: "b" },
        actor: { id: "a" },
        page: { url: "", host: "" },
        element: { ref: "", role: "", name: "", type: "" },
        key: "",
        submit: false,
        file: { path: "", name: "", extension: "" },
        intent: "write_tool",
        mcp: { server: "jira", tool: "editJiraIssue", effect: "write" },
      },
    );
    expect(decision.source).toBe("ask");
    expect(decision.reason).toBe(
      "The Bot wants to call editJiraIssue on jira.",
    );
  });

  test("a refusal of a tool call names it the same way", () => {
    const decision = evaluateActionPolicy(
      { ...permissive, deny: ['mcp.server == "jira"'] },
      {
        tool: { name: "mcp__jira__editJiraIssue" },
        bot: { id: "b" },
        actor: { id: "a" },
        page: { url: "", host: "" },
        element: { ref: "", role: "", name: "", type: "" },
        key: "",
        submit: false,
        file: { path: "", name: "", extension: "" },
        intent: "write_tool",
        mcp: { server: "jira", tool: "editJiraIssue", effect: "write" },
      },
    );
    expect(decision.reason).toContain("editJiraIssue on jira");
    // Nothing about a file, and nothing about whatever page a browser happens to be showing.
    expect(decision.reason).not.toContain("the file");
  });

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
