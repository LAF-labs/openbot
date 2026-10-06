import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { RUN_SCRIPT_TOOL } from "../../server/src/computer/gateway/intent";
import { RUN_SCRIPT_TOOL as OUR_NAME, coversRuns } from "../src/lib/approvals";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiAnswer,
  agentFixture,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * WHAT SOMEBODY ALLOWED, WHERE IT IS A SMALL PROGRAM'S RUN — ON THE TWO SCREENS THAT LIST IT.
 *
 * "Always" on a run's card is an allowance for the tool, and the tool's name is the gateway's own:
 * `mcp__workbench__run_script`. Both lists printed a tool's scope as its name, so the one place a
 * person can find what they allowed and take it back read `도구 mcp__workbench__run_script` — to
 * somebody who was asked about "a small program" and does not know what an identifier is (the
 * independent read of #123, which read the two lists and found no test mounts either).
 *
 * So both are MOUNTED here, in the app's own router with the server answering the rows as the
 * routes send them, and what is held is what a person reads.
 *
 * BY WHAT WAS ALLOWED, NOT BY A NAME TWO THINGS CAN CARRY. A server added by address under the
 * name `workbench` (older than the name's being kept) with a tool `run_script` is offered to a Bot
 * as that same `mcp__workbench__run_script`. Its allowance is not this one: a call to another
 * server is allowed by its reference, `workbench/run_script`, and a run by the gateway's name
 * (`server/tests/workbench-gateway.test.ts` holds the two keys apart). Each list is handed both
 * rows, and only the run is called a small program.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const BOT = agentFixture({ id: "agent-1", name: "Sprout" });

/** A run's allowance as `standing-approvals.ts` stores it, and another server's tool beside it. */
const ROWS = [
  {
    id: "allowance-run",
    botId: BOT.id,
    rule: "repeat.count >= 5",
    scopeKind: "tool",
    scopeValue: RUN_SCRIPT_TOOL,
    subject: {
      kind: "file",
      intent: "run_script",
      files: [{ path: "uploads/a.csv" }],
      repeatCount: 5,
      reason: "repeat",
    },
    grantedAt: "2026-10-07T03:00:00.000Z",
    tier: "always",
  },
  {
    id: "allowance-theirs",
    botId: BOT.id,
    rule: "true",
    scopeKind: "tool",
    scopeValue: "workbench/run_script",
    grantedAt: "2026-10-07T03:00:01.000Z",
    tier: "always",
  },
];

const RUN_WORDS = "Running any small program it wrote";

describe("a run's allowance on the Bot's own page", () => {
  const api: ApiAnswer = (request) => {
    if (request.pathname === "/api/agents" && request.url.search === "") {
      return json({ agents: [BOT] });
    }
    if (request.pathname === "/api/agents/agent-1") return json({ agent: BOT });
    if (request.pathname === "/api/agents/agent-1/memories") {
      return json({ memories: [] });
    }
    if (request.pathname === "/api/agents/agent-1/allowances") {
      return json({ allowances: ROWS, inForce: true });
    }
    return undefined;
  };

  test("says what was allowed in the words the card asked in, and prints no identifier", async () => {
    const view = await mountApp({ path: "/agents?agent=agent-1", api });
    const card = () => view.host.querySelector("section#allowances");
    await view.waitFor(
      () => (card()?.querySelectorAll("li").length ?? 0) === ROWS.length,
      "the allowances to be listed",
    );
    const [run, theirs] = [...(card()?.querySelectorAll("li") ?? [])].map(
      (row) => row.textContent ?? "",
    );

    expect(run).toContain(RUN_WORDS);
    expect(run).not.toContain(RUN_SCRIPT_TOOL);
    expect(run).not.toContain("The tool");
    // What the Bot was doing when it was allowed is still said under it, from the row's facts.
    expect(run).toContain(
      "It wants to run a small program it wrote, on the file uploads/a.csv.",
    );
    // And it can be taken back from here, which is what the list is for.
    expect(run).toContain("Ask me again");

    // Another server's tool that a Bot is offered under the same name is not a small program.
    expect(theirs).toContain("The tool workbench/run_script");
    expect(theirs).not.toContain(RUN_WORDS);
  });
});

describe("a run's allowance on the administrator's boundary page", () => {
  const api: ApiAnswer = (request) => {
    if (request.pathname === "/api/agents" && request.url.search === "") {
      return json({ agents: [BOT] });
    }
    if (request.pathname === "/api/computers/policy") {
      return json({ policy: { deny: [], ask: [], allow: ["true"] } });
    }
    // Before the shell's own answer for everything under `/api/approvals/`, which is an empty
    // list of questions and would leave this section undrawn.
    if (request.pathname === "/api/approvals/standing") {
      return json({ standing: ROWS });
    }
    return undefined;
  };

  test("says whose it is and what was allowed, and prints no identifier", async () => {
    const view = await mountApp({
      path: "/admin/boundaries",
      role: "admin",
      api,
    });
    const rows = () =>
      [...(view.main()?.querySelectorAll("li") ?? [])].filter((row) =>
        (row.textContent ?? "").includes("Sprout —"),
      );
    await view.waitFor(
      () => rows().length === ROWS.length,
      "the standing allowances to be listed",
    );
    const [run, theirs] = rows().map((row) => row.textContent ?? "");

    expect(run).toContain("Sprout — running any small program it wrote");
    expect(run).not.toContain(RUN_SCRIPT_TOOL);
    expect(run).not.toContain("the tool");
    expect(run).toContain("Ask me again");

    expect(theirs).toContain("Sprout — the tool workbench/run_script");
    expect(theirs).not.toContain("small program");
  });
});

describe("the words for a run's allowance", () => {
  test("are for the name the server allows a run under, as a tool, and for nothing else", () => {
    expect(OUR_NAME).toBe(RUN_SCRIPT_TOOL);
    expect(coversRuns("tool", RUN_SCRIPT_TOOL)).toBe(true);
    // Another server's tool is allowed by its reference, whatever name it is offered under.
    expect(coversRuns("tool", "workbench/run_script")).toBe(false);
    // And a file or a site that happens to be spelled like the name is a file or a site.
    expect(coversRuns("file", RUN_SCRIPT_TOOL)).toBe(false);
    expect(coversRuns("host", RUN_SCRIPT_TOOL)).toBe(false);
  });

  test("are in Korean, in the word the card used for it", () => {
    for (const key of [
      RUN_WORDS,
      "{bot} — running any small program it wrote",
    ]) {
      expect(ko[key as keyof typeof ko] ?? "").toContain("작은 프로그램");
    }
  });
});
