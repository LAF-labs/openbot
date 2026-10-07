import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { BOUNDARY_REFUSALS } from "../src/lib/computer/refusals";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiAnswer,
  type ApiRequest,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * THE BOUNDARIES PAGE, SAVING AGAINST A SERVER THAT ANSWERS THE WAY THE REAL ONE DOES.
 *
 * The page reads the whole policy once and sends the whole of it back with one thing changed. So a
 * window that read it a while ago writes its older copy over whatever was decided since. Measured
 * 2026-10-07, on the case that found it: a window that was on this page across an upgrade saved a
 * rule straight back that a migration had just rewritten, and a write to `Notes/x.md` went unasked
 * again. The server now stores nothing from a save made against a boundary that is not the one in
 * force (`server/src/computer/policy-store.ts`, `revisionOf`), and answers 409
 * `laf:policy_changed`.
 *
 * WHAT THE PAGE DOES WITH THAT IS THE REST OF THE FIX, and it is what these hold: it reads the
 * current boundary and shows it, says that is what happened, keeps what the person typed — and
 * does NOT make the save again on their behalf. A retry would be a decision about a boundary
 * nobody on this page has looked at.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

type Policy = {
  deny: string[];
  ask: string[];
  allow: string[];
  settleWithoutAsking?: "allowed" | "off";
};

const AS_READ: Policy = { deny: [], ask: [], allow: ["true"] };
/** What another window made of it meanwhile: a rule, and every question in front of a person. */
const ELSEWHERE: Policy = {
  deny: [],
  ask: ['intent == "upload"'],
  allow: ["true"],
  settleWithoutAsking: "off",
};
const MINE = 'contains(element.name, "결제")';

/**
 * The server's policy routes, standing in: one boundary, a mark that is the boundary's own, and a
 * save stored only when it presents the mark of the boundary that is held.
 */
function policyServer(
  first: Policy,
  options: {
    /** What a save is answered with instead of being looked at. */
    refuse?: (body: Record<string, unknown>) => Response | undefined;
    standing?: unknown[];
  } = {},
) {
  let held = first;
  const markOf = (policy: Policy) => `mark:${JSON.stringify(policy)}`;
  const api: ApiAnswer = ({ method, pathname, body }: ApiRequest) => {
    if (pathname === "/api/approvals/standing") {
      return json({ standing: options.standing ?? [] });
    }
    if (pathname !== "/api/computers/policy") return undefined;
    if (method === "GET") {
      return json({ policy: held, revision: markOf(held) });
    }
    const sent = body as Record<string, unknown> & Policy;
    // In the server's own order: is this copy the boundary in force — and only then what it holds.
    if (sent.revision !== markOf(held)) {
      return json(
        { error: "laf:policy_changed", code: "laf:policy_changed" },
        409,
      );
    }
    const refused = options.refuse?.(sent);
    if (refused) return refused;
    held = {
      deny: sent.deny,
      ask: sent.ask,
      allow: sent.allow,
      ...(sent.settleWithoutAsking
        ? { settleWithoutAsking: sent.settleWithoutAsking }
        : {}),
    };
    return json({ policy: held, revision: markOf(held) });
  };
  return {
    api,
    markOf,
    /** Another window's save, as far as this page can tell: the boundary is simply another one. */
    changeElsewhere: (next: Policy) => {
      held = next;
    },
    held: () => held,
  };
}

const policyRequests = (requests: ApiRequest[]) =>
  requests
    .filter((request) => request.pathname === "/api/computers/policy")
    .map((request) => request.method);

const alerts = (main: Element | null) => [
  ...new Set(
    [...(main?.querySelectorAll('[role="alert"]') ?? [])].map(
      (alert) => alert.textContent ?? "",
    ),
  ),
];

const denyBox = (main: Element | null) =>
  main?.querySelector<HTMLInputElement>(
    'input[aria-label="A rule, written in CEL"]',
  );

describe("the Boundaries page, saving", () => {
  test("a save made against a boundary that was changed elsewhere stores nothing, shows the current one, says so — and is not made again", async () => {
    const server = policyServer(AS_READ);
    const view = await mountApp({
      path: "/admin/boundaries",
      role: "admin",
      api: server.api,
    });
    await view.waitFor(
      () => denyBox(view.main()) !== undefined && denyBox(view.main()) !== null,
      "the box for a rule",
    );
    expect(view.main()?.textContent).toContain("A person may settle it");

    // Somebody else saves, from another window. This page is still showing what it read.
    server.changeElsewhere(ELSEWHERE);
    expect(view.main()?.textContent).not.toContain('intent == "upload"');

    const box = denyBox(view.main()) as HTMLInputElement;
    await view.type(box, MINE);
    const add = [...(view.main()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Add rule",
    ) as HTMLButtonElement;
    await view.click(add);
    await view.waitFor(
      () => alerts(view.main()).length > 0,
      "the page to say what happened",
    );

    // ONE save, made against the mark this page read — and then a read, and no second save.
    expect(policyRequests(view.requests)).toEqual(["GET", "PUT", "GET"]);
    const put = view.requests.find(
      (request) =>
        request.pathname === "/api/computers/policy" &&
        request.method === "PUT",
    );
    expect(put?.body).toMatchObject({
      deny: [MINE],
      ask: [],
      revision: server.markOf(AS_READ),
    });
    // Nothing of it was stored: the boundary is the other window's, whole.
    expect(server.held()).toEqual(ELSEWHERE);

    // It says so, in the sentence that has Korean, and that is the only thing it says.
    const said = BOUNDARY_REFUSALS["laf:policy_changed"] ?? "";
    expect(alerts(view.main())).toEqual([said]);
    expect(said).toContain("nothing was saved");
    expect(ko[said]).toContain("저장하지 않았어요");
    // What is on the page now IS the current boundary: the other window's rule, and its switch.
    expect(view.main()?.textContent).toContain('intent == "upload"');
    expect(
      view.buttonNamed("Ask every time")?.getAttribute("aria-pressed"),
    ).toBe("true");
    // And what was typed is still there to be decided about again.
    expect(denyBox(view.main())?.value).toBe(MINE);

    // Decided again, it is saved against the boundary the page shows now — on top of the other
    // window's change, not over it.
    await view.click(add);
    await view.waitFor(
      () => server.held().deny.length === 1,
      "the second save to be stored",
    );
    expect(server.held()).toEqual({ ...ELSEWHERE, deny: [MINE] });
    expect(policyRequests(view.requests)).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(view.requests.at(-1)?.body).toMatchObject({
      revision: server.markOf(ELSEWHERE),
    });
    expect(alerts(view.main())).toEqual([]);
    expect(denyBox(view.main())?.value).toBe("");
  });

  test("every later save presents the mark the last one was answered with", async () => {
    // A page that went on presenting the mark it first read would be turned away by its own
    // earlier save.
    const server = policyServer(AS_READ);
    const view = await mountApp({
      path: "/admin/boundaries",
      role: "admin",
      api: server.api,
    });
    await view.waitFor(
      () => denyBox(view.main()) !== undefined && denyBox(view.main()) !== null,
      "the box for a rule",
    );
    const add = [...(view.main()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Add rule",
    ) as HTMLButtonElement;

    for (const rule of ["first", "second"]) {
      await view.type(denyBox(view.main()) as HTMLInputElement, rule);
      await view.click(add);
      await view.waitFor(
        () => server.held().deny.includes(rule),
        `the rule "${rule}" to be stored`,
      );
    }
    expect(server.held().deny).toEqual(["first", "second"]);
    expect(policyRequests(view.requests)).toEqual(["GET", "PUT", "PUT"]);
    expect(alerts(view.main())).toEqual([]);
  });

  test("the rule the server no longer takes is said to be that, with the rule to write in its place, and stays in its box", async () => {
    const RETIRED = 'intent == "write_file" && !matches(file.path, "^notes/")';
    const server = policyServer(AS_READ, {
      refuse: (body) =>
        (body.deny as string[]).includes(RETIRED)
          ? json(
              {
                error: "laf:policy_rule_retired",
                code: "laf:policy_rule_retired",
                list: "deny",
                rule: RETIRED,
                replacement: 'intent == "write_file" && file.folder != "notes"',
              },
              400,
            )
          : undefined,
    });
    const view = await mountApp({
      path: "/admin/boundaries",
      role: "admin",
      api: server.api,
    });
    await view.waitFor(
      () => denyBox(view.main()) !== undefined && denyBox(view.main()) !== null,
      "the box for a rule",
    );
    await view.type(denyBox(view.main()) as HTMLInputElement, RETIRED);
    await view.click(
      [...(view.main()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Add rule",
      ) as HTMLButtonElement,
    );
    await view.waitFor(
      () => alerts(view.main()).length > 0,
      "the page to say why",
    );

    const said = BOUNDARY_REFUSALS["laf:policy_rule_retired"] ?? "";
    expect(alerts(view.main())).toEqual([said]);
    expect(said).toContain("ignores letter case");
    expect(said).toContain('intent == "write_file" && file.folder != "notes"');
    expect(ko[said]).toContain("대소문자");
    expect(ko[said]).toContain(
      'intent == "write_file" && file.folder != "notes"',
    );
    // A refusal for what the save holds is not a refusal for when it was made: nothing is read
    // again, and nothing was stored.
    expect(policyRequests(view.requests)).toEqual(["GET", "PUT"]);
    expect(server.held()).toEqual(AS_READ);
    expect(denyBox(view.main())?.value).toBe(RETIRED);
  });
});

describe("the Boundaries page, what it no longer asks about", () => {
  test("an allowance whose rule no longer asks — gone, or refusing now — is said not to be in force; one whose rule still asks, and a floor's, are not", async () => {
    /*
     * An allowance is kept under the rule that asked and looked for under the rule that asks now.
     * When somebody edits that rule the allowance is still listed here, under a heading that says
     * "it no longer asks about", and answers for nothing. The same when the expression was moved
     * into what the Bot may never do: it refuses now, and a refusal is never answered for.
     */
    const NOT_IN_FORCE =
      "Not in force: the rule this was given under no longer asks, so it answers for nothing. It can be taken back.";
    const REFUSES_NOW = 'intent == "write_file" && file.extension == "exe"';
    // In both lists: the refusal is reached first, so the question under it is never asked.
    const REFUSES_FIRST = 'intent == "write_file" && file.folder == "private"';
    const allowance = (id: string, rule: string, path: string) => ({
      id,
      botId: "agent_2f1c9a3e-7d24-4a6b-9b1e-0c8f5d2a7b41",
      rule,
      scopeKind: "file",
      scopeValue: path,
      grantedAt: "2026-10-01T03:00:00.000Z",
      tier: "always",
    });
    const server = policyServer(
      {
        deny: [REFUSES_NOW, REFUSES_FIRST],
        ask: ['intent == "upload"', REFUSES_FIRST],
        allow: ["true"],
      },
      {
        standing: [
          allowance("a-standing", 'intent == "upload"', "reports/standing.csv"),
          allowance(
            "a-left-over",
            'intent == "write_file"',
            "reports/left.csv",
          ),
          allowance("a-refused", REFUSES_NOW, "reports/refused.csv"),
          allowance("a-refused-first", REFUSES_FIRST, "reports/first.csv"),
          // A floor's question is filed under no written rule: there is none of it to go missing.
          allowance("a-floor", "", "reports/floor.csv"),
          allowance("a-guard", "laf:money", "reports/guard.csv"),
          // An allowance for a question the high-risk check raised over an `allow` rule.
          allowance("a-allow", "true", "reports/allowed.csv"),
        ],
      },
    );
    const view = await mountApp({
      path: "/admin/boundaries",
      role: "admin",
      api: server.api,
    });
    await view.waitFor(
      () => view.main()?.textContent?.includes("reports/standing.csv") === true,
      "the list of allowances",
    );

    const rows = [...(view.main()?.querySelectorAll("li") ?? [])].filter(
      (row) => row.textContent?.includes("reports/"),
    );
    expect(
      rows.map((row) => [
        /reports\/[a-z]+\.csv/.exec(row.textContent ?? "")?.[0],
        row.textContent?.includes(NOT_IN_FORCE),
      ]),
    ).toEqual([
      ["reports/standing.csv", false],
      ["reports/left.csv", true],
      ["reports/refused.csv", true],
      ["reports/first.csv", true],
      ["reports/floor.csv", false],
      ["reports/guard.csv", false],
      ["reports/allowed.csv", false],
    ]);
    expect(ko[NOT_IN_FORCE]).toContain("적용되지 않음");
    // It can still be taken back from where it is listed.
    expect(rows[1]?.querySelector("button")?.textContent?.trim()).toBe(
      "Ask me again",
    );
  });
});
