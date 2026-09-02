import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ReviewSubject, ReviewVerdict } from "../src/computer/auto-review";
import type { ActionPolicy } from "../src/computer/policy";
import { createRepeatDetector } from "../src/computer/repeat";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { createDatabase } from "../src/db/client";
import {
  agents,
  auditEvents,
  mcpServers,
  mcpTools,
  pluginGrants,
} from "../src/db/schema";
import {
  createPluginStore,
  PluginNeedsApprovalError,
  PluginRefusedError,
} from "../src/plugins/store";
import { TEST_POOL } from "./support/database";
import { A_TOOL_CALL } from "./support/subjects";

/**
 * The two questions a tool call has to pass, and the row each answer leaves behind.
 *
 * The refusals are the property under test. A call that succeeds proves the plumbing works; a call
 * that is refused proves the governance does. Both refusals here stop before any network call, which
 * is itself the property being asserted: a tool a Bot was never given must not reach the vault or
 * the vendor, so there is nothing to stub.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
const holderId = `agent_plugin_holder_${suite}`;
const strangerId = `agent_plugin_stranger_${suite}`;
/**
 * A CUSTOM server, suite-scoped, at an address that resolves nowhere.
 *
 * Custom on purpose, twice over. A first-party row whose key the catalogue no longer carries is
 * refused outright (the pinned host that made it admissible is gone), so a made-up first-party
 * fixture would test that refusal and nothing else. And a custom server classifies its tools by
 * their own declared annotations under the LAF contract — which is this fork's path, and the one
 * these tests should hold still.
 */
const serverId = `plugtest-${suite}`;
const toolName = "search_things";
const ref = `${serverId}/${toolName}`;

let policy: ActionPolicy = { deny: [], allow: ["true"] };

/** The deployment's one registry, shared with the computer in a real deployment. */
const approvals = createApprovalRegistry();

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: {
    // No credential is ever read in these tests, because every call is refused before the vault.
    readSecret: async () => null,
  } as never,
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  approvals,
  /*
   * The vendor, injected to fail — not left to the network.
   *
   * Another suite `mock.module`s the mcp module PROCESS-WIDE (bun's mocks are not per file), so
   * "the call fails at the network" was true alone and false in a full run, where the leaked stub
   * answered it with success. The injectable exists for exactly this: what these tests prove is
   * that a call got PAST the boundary, and an attempt that then fails proves it as well as one
   * that succeeds — deterministically.
   */
  callVendor: async () => {
    throw new Error("the test vendor is unreachable");
  },
});

async function auditRowsFor(targetId: string) {
  return database
    .select({
      eventType: auditEvents.eventType,
      payload: auditEvents.payload,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetType, "mcp_tool"),
        eq(auditEvents.targetId, targetId),
      ),
    );
}

beforeAll(async () => {
  for (const id of [holderId, strangerId]) {
    await database
      .insert(agents)
      .values({
        id,
        name: id,
        type: "remote_ag_ui",
        configuration: {},
      })
      .onConflictDoNothing();
  }

  // The server row is written directly rather than through addServer, so the test needs no vendor
  // to be reachable. What is under test is the decision, not the listing.
  await database
    .insert(mcpServers)
    .values({
      id: serverId,
      title: "Plugin test server",
      vendor: "mcp.test.invalid",
      url: "https://mcp.test.invalid/mcp",
      provenance: "custom",
    })
    .onConflictDoNothing();
  await database
    .insert(mcpTools)
    .values({
      serverId,
      name: toolName,
      description: "Search things.",
      // Declared read-only under the LAF contract, so the call path classifies it as a read with
      // no guard floor — which is what lets a rule about effect be the thing under test below.
      annotations: { readOnlyHint: true },
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.ref, ref));
  await database.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
  await database.delete(agents).where(eq(agents.id, holderId));
  await database.delete(agents).where(eq(agents.id, strangerId));
});

describe("a grant is the permission", () => {
  test("a Bot that was never granted a tool is refused, and the refusal is recorded", async () => {
    await expect(
      store.callTool({
        ref,
        args: {},
        botId: strangerId,
        actorId: "someone@laf.local",
      }),
    ).rejects.toBeInstanceOf(PluginRefusedError);

    const rows = await auditRowsFor(ref);
    const rejected = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { bot?: string }).bot === strangerId,
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect((rejected[0].payload as { refusal?: string }).refusal).toBe(
      "not_granted",
    );
  });

  test("granting lets the same Bot past the grant check", async () => {
    await store.grant("mcp", ref, holderId, "admin@laf.local");
    const decision = await store.decide("mcp", ref, holderId);
    expect(decision.allowed).toBe(true);
  });

  test("revoking takes it away again", async () => {
    await store.grant("mcp", ref, holderId, "admin@laf.local");
    await store.revoke("mcp", ref, holderId, "admin@laf.local");
    const decision = await store.decide("mcp", ref, holderId);
    expect(decision.allowed).toBe(false);
  });

  test("a Bot is offered exactly what it holds", async () => {
    await store.grant("mcp", ref, holderId, "admin@laf.local");
    const held = await store.listForAgent(holderId);
    expect(held.tools.map((tool) => tool.ref)).toEqual([ref]);
    // The name the model is offered, which may not contain a slash.
    expect(held.tools[0].toolName).toBe(`mcp__${serverId}__${toolName}`);

    const nothing = await store.listForAgent(strangerId);
    expect(nothing.tools).toEqual([]);
    expect(nothing.skills).toEqual([]);
  });
});

describe("the policy is asked as well as the grant", () => {
  test("a granted tool is still refused by a deny rule, and the rule is named", async () => {
    await store.grant("mcp", ref, holderId, "admin@laf.local");
    policy = {
      deny: [`mcp.server == "${serverId}"`],
      allow: ["true"],
    };

    let thrown: unknown;
    try {
      await store.callTool({
        ref,
        args: {},
        botId: holderId,
        actorId: "someone@laf.local",
      });
    } catch (error) {
      thrown = error;
    } finally {
      policy = { deny: [], allow: ["true"] };
    }

    expect(thrown).toBeInstanceOf(PluginRefusedError);
    // The rule that decided it, so an operator reading the refusal knows what to edit.
    expect((thrown as PluginRefusedError).rule).toBe(
      `mcp.server == "${serverId}"`,
    );

    const rows = await auditRowsFor(ref);
    const refusedByPolicy = rows.filter(
      (row) =>
        row.eventType === "mcp.call_rejected" &&
        (row.payload as { decision?: { rule?: string } }).decision?.rule ===
          `mcp.server == "${serverId}"`,
    );
    expect(refusedByPolicy.length).toBeGreaterThan(0);
  });

  test("a rule can speak about effect rather than about tool names", async () => {
    await store.grant("mcp", ref, holderId, "admin@laf.local");
    // The tool declares `readOnlyHint: true`, so the LAF contract classifies it as a read and
    // this deny rule must NOT catch it. The assertion is that the call gets past the policy, which
    // it proves by failing at the network instead of as a refusal.
    policy = {
      deny: ['intent == "write_tool"'],
      allow: ["true"],
    };

    let thrown: unknown;
    try {
      await store.callTool({
        ref,
        args: {},
        botId: holderId,
        actorId: "someone@laf.local",
      });
    } catch (error) {
      thrown = error;
    } finally {
      policy = { deny: [], allow: ["true"] };
    }

    expect(thrown).not.toBeInstanceOf(PluginRefusedError);
  });
});

describe("a boundary written about the browser does not refuse tool calls", () => {
  test("an unguarded rule about a page element does not refuse a tool call", async () => {
    await store.grant("mcp", ref, holderId, "admin@laf.local");
    /**
     * This engine treats an expression it cannot evaluate as a MATCH, which is right for a browser
     * action on an element the server could not resolve and catastrophic for a tool call: with
     * `element` absent from the context, ANY deny rule naming it is unevaluable, so it matches, so
     * every MCP call is refused for a reason about a submit button.
     *
     * The preset in `.env.example` happens to survive that, because it guards each clause with
     * `tool.name == "computer_click"` and CEL short-circuits before ever reaching `element`. That is
     * luck, not design, and a rule an operator writes by hand has no such guard. So the rule under
     * test is the unguarded one.
     */
    policy = {
      deny: ['contains(element.name, "submit")'],
      allow: ["true"],
    };

    let thrown: unknown;
    try {
      await store.callTool({
        ref,
        args: {},
        botId: holderId,
        actorId: "someone@laf.local",
      });
    } catch (error) {
      thrown = error;
    } finally {
      policy = { deny: [], allow: ["true"] };
    }

    // Not a refusal. It gets as far as the network, which is where this test stops caring.
    expect(thrown).not.toBeInstanceOf(PluginRefusedError);
  });
});

/**
 * The third answer, which the tool-call path has to give as well as the computer.
 *
 * An ask verdict does not forward, so a call site that only knows yes and no reads it as a refusal
 * and the list an operator wrote to be asked about silently becomes a list of things their Bots may
 * never do. That is the failure the ask list exists to prevent, and it is invisible from a green
 * typecheck: everything still compiles, the audit trail still fills up, and the rows say refused.
 */
describe("a boundary can ask a person about a tool call", () => {
  test("stops the call and asks, rather than refusing it", async () => {
    await store.grant("mcp", ref, holderId, "admin@laf.local");
    policy = {
      deny: [],
      ask: [`mcp.server == "${serverId}"`],
      allow: ["true"],
    };

    let thrown: unknown;
    try {
      await store.callTool({
        ref,
        args: { query: "open bugs" },
        botId: holderId,
        actorId: "someone@laf.local",
      });
    } catch (error) {
      thrown = error;
    } finally {
      policy = { deny: [], allow: ["true"] };
    }

    expect(thrown).toBeInstanceOf(PluginNeedsApprovalError);
    // A refusal is final and a model told it was refused gives up; this one is meant to come back.
    expect(thrown).not.toBeInstanceOf(PluginRefusedError);
    const asked = thrown as PluginNeedsApprovalError;
    /*
     * The tool and the server, as facts. This asserted a sentence — "The Bot wants to call
     * search_things on plugtest-…" — assembled by the policy in English and drawn on a Korean card,
     * while the guard floors filled the same field with Korean. The card composes it now
     * (`app/src/lib/approvals.ts`), and what crosses is this.
     */
    expect(asked.subject).toEqual({
      kind: "tool",
      intent: "call_tool",
      tool: { server: serverId, name: toolName },
      reason: "policy_ask",
    });
    expect(asked.rule).toBe(`mcp.server == "${serverId}"`);

    const rows = await auditRowsFor(ref);
    const question = rows.filter(
      (row) =>
        row.eventType === "approval.requested" &&
        (row.payload as { approval?: string }).approval === asked.approvalId,
    );
    expect(question).toHaveLength(1);
    // Nothing is recorded as rejected, because nothing was: the turn stopped at the question. A
    // deny rule earlier in this file leaves rejections behind, so what is asserted is that none of
    // them came from the ask list.
    expect(
      rows.some(
        (row) =>
          row.eventType === "mcp.call_rejected" &&
          (row.payload as { decision?: { source?: string } }).decision
            ?.source === "ask",
      ),
    ).toBe(false);
  });

  test("an answer is good for the call it was given for, and not for another", async () => {
    await store.grant("mcp", ref, holderId, "admin@laf.local");
    policy = {
      deny: [],
      ask: [`mcp.server == "${serverId}"`],
      allow: ["true"],
    };
    const call = {
      ref,
      args: { query: "open bugs" },
      botId: holderId,
      actorId: "someone@laf.local",
    };

    try {
      const asked = (await store
        .callTool(call)
        .catch((error: unknown) => error)) as PluginNeedsApprovalError;
      approvals.answer(asked.approvalId, holderId, "manager@laf.local", true);

      // The arguments are inside the binding, so a person who allowed one message to one channel has
      // not allowed a different one. This asks again rather than going through.
      const elsewhere = await store
        .callTool({
          ...call,
          args: { query: "everything" },
          approvalId: asked.approvalId,
        })
        .catch((error: unknown) => error);
      expect(elsewhere).toBeInstanceOf(PluginNeedsApprovalError);

      // The call it was actually given for gets past the boundary, which it proves by failing at the
      // network instead of as a question or a refusal.
      const allowed = await store
        .callTool({ ...call, approvalId: asked.approvalId })
        .catch((error: unknown) => error);
      expect(allowed).not.toBeInstanceOf(PluginNeedsApprovalError);
      expect(allowed).not.toBeInstanceOf(PluginRefusedError);

      const rows = await auditRowsFor(ref);
      /*
       * The row for the allowed call names who stood behind it, so the trail reads as "somebody was
       * asked and said yes" rather than as an ordinary permission nobody ever questioned.
       *
       * `mcp.call_failed`, deliberately: the trail now records what HAPPENED rather than what was
       * permitted, this fixture's address resolves nowhere, and an attempt that died at the network
       * still carries the approval that let it be attempted.
       */
      expect(
        rows.some(
          (row) =>
            row.eventType === "mcp.call_failed" &&
            (row.payload as { decision?: { approvedBy?: string } }).decision
              ?.approvedBy === "manager@laf.local",
        ),
      ).toBe(true);
    } finally {
      policy = { deny: [], allow: ["true"] };
    }
  });
});

describe("the trail can be read by a second reader", () => {
  test("a refusal names the bot, the server and the tool in queryable JSON", async () => {
    const [row] = await database
      .select({
        bot: sql<string>`payload ->> 'bot'`,
        server: sql<string>`payload ->> 'server'`,
        tool: sql<string>`payload ->> 'tool'`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetType, "mcp_tool"),
          eq(auditEvents.eventType, "mcp.call_rejected"),
          eq(auditEvents.targetId, ref),
        ),
      )
      .limit(1);

    // Asserted in SQL rather than through the application, because the stored payload shape is the
    // property under test.
    expect(row?.server).toBe(serverId);
    expect(row?.tool).toBe(toolName);
    expect(row?.bot).toBeTruthy();
  });
});

/**
 * WHAT A TOOL CALL GAINED WHEN THE TWO SETTLE SEQUENCES BECAME ONE.
 *
 * This path used to hand-write the gateway's sequence without the parts nobody had decided to leave
 * out: a Bot's own "do not ask me about…" instruction was consulted for a click and not for a call
 * to somebody else's server, and `repeat.count` was hard-coded to one, so the boundary this
 * deployment ships — `repeat.count >= 5` — was false here however many times a stuck model called.
 * Both come from `computer/settle.ts` now, and these are the four things that changed.
 *
 * Its own store, because the deployment wires an instruction, an allowance store and a counter that
 * the fixture above deliberately does without.
 */
describe("a tool call goes through the same settle step as a click", () => {
  const moneyTool = "pay_invoice";
  const moneyRef = `${serverId}/${moneyTool}`;
  let judged: ReviewSubject[] = [];
  let verdict: ReviewVerdict | null = null;
  let settling: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
  const standing = createStandingApprovalStore();
  /** A window this suite never waits out, and thresholds it never needs. */
  const repeat = createRepeatDetector({ windowMs: 60_000 });

  const governed = createPluginStore({
    database,
    auditStore: createAuditStore(database),
    credentials: { readSecret: async () => null } as never,
    encryptionKey: "x".repeat(44),
    policy: () => settling,
    approvals,
    standing,
    repeat,
    autoReview: async (_botId, subject) => {
      judged.push(subject);
      return verdict;
    },
    callVendor: async () => {
      throw new Error("the test vendor is unreachable");
    },
  });

  beforeAll(async () => {
    await database
      .insert(mcpTools)
      .values({
        serverId,
        name: moneyTool,
        description: "Pay an invoice.",
        // The contract's money class: a person answers for the exact call, every time.
        annotations: { "x-laf/effect": "money" },
      })
      .onConflictDoNothing();
    await governed.grant("mcp", ref, holderId, "admin@laf.local");
    await governed.grant("mcp", moneyRef, holderId, "admin@laf.local");
  });

  afterAll(async () => {
    settling = { deny: [], ask: [], allow: ["true"] };
  });

  const call = (args: Record<string, unknown>, override = {}) =>
    governed.callTool({
      ref,
      args,
      botId: holderId,
      actorId: "someone@laf.local",
      ...override,
    });

  test("the Bot's own instruction can answer, and is shown the same facts a person would be", async () => {
    settling = { deny: [], ask: [`mcp.server == "${serverId}"`], allow: [] };
    judged = [];
    verdict = { allowed: true, reason: "reading is fine" };

    // Past the boundary, which it proves by failing at the network rather than as a question.
    const outcome = await call({ query: "instruction" }).catch(
      (error: unknown) => error,
    );
    expect(outcome).not.toBeInstanceOf(PluginNeedsApprovalError);
    expect(judged).toEqual([
      {
        action: ref,
        subject: {
          kind: "tool",
          intent: "call_tool",
          tool: { server: serverId, name: toolName },
          reason: "policy_ask",
        },
      },
    ]);
  });

  test("a guard floor is not settled by the instruction, however keen it is", async () => {
    settling = { deny: [], ask: [], allow: ["true"] };
    judged = [];
    verdict = { allowed: true, reason: "the owner said tools are fine" };

    const thrown = await governed
      .callTool({
        ref: moneyRef,
        args: { invoice: "2026-09" },
        botId: holderId,
        actorId: "someone@laf.local",
      })
      .catch((error: unknown) => error);

    // Money moves only where somebody looked at THIS call: the target of one lives in its arguments,
    // and no instruction written in advance covers an argument nobody had read.
    expect(thrown).toBeInstanceOf(PluginNeedsApprovalError);
    expect((thrown as PluginNeedsApprovalError).subject.tool?.guard).toBe(
      "money",
    );
    expect(judged).toEqual([]);
  });

  test("settleWithoutAsking off ignores an allowance on this path too", async () => {
    settling = {
      deny: [],
      ask: [`mcp.server == "${serverId}"`],
      allow: [],
      settleWithoutAsking: "off",
    };
    judged = [];
    verdict = { allowed: true, reason: "reading is fine" };
    await standing.grant({
      botId: holderId,
      rule: `mcp.server == "${serverId}"`,
      scope: { kind: "tool", value: ref },
      subject: A_TOOL_CALL,
      grantedBy: "manager@laf.local",
    });

    const thrown = await call({ query: "switched off" }).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(PluginNeedsApprovalError);
    // The switch expresses itself the same way it does on the computer: no scope on the question, so
    // there is nothing for the card to offer and nothing for the route to grant.
    expect((thrown as PluginNeedsApprovalError).scope).toBeUndefined();
    // And no instruction was consulted either. One switch, both ways past a person.
    expect(judged).toEqual([]);
  });

  test("the same call over and over is counted, so a rule about repetition fires", async () => {
    /*
     * The shipped boundary's own rule, which was unreachable from this path: every tool call
     * reported itself as a first attempt.
     *
     * A counter of its own, because the detector keys on the tool rather than on the arguments (the
     * same reason typed text is not in the browser's key, `computer/repeat.ts`) — so the calls the
     * tests above made on this ref are in the count, and a test that has to be run in a particular
     * order is a test that fails for a reason nobody can see.
     */
    settling = { deny: [], ask: ["repeat.count >= 3"], allow: ["true"] };
    judged = [];
    verdict = null;
    const counting = createPluginStore({
      database,
      auditStore: createAuditStore(database),
      credentials: { readSecret: async () => null } as never,
      encryptionKey: "x".repeat(44),
      policy: () => settling,
      approvals,
      repeat: createRepeatDetector({ windowMs: 60_000 }),
      callVendor: async () => {
        throw new Error("the test vendor is unreachable");
      },
    });
    const stuck = () =>
      counting
        .callTool({
          ref,
          args: { query: "again" },
          botId: holderId,
          actorId: "someone@laf.local",
        })
        .catch((error: unknown) => error);

    // Two go through — the count is one, then two — and the third is the one the rule stops.
    const attempts = [await stuck(), await stuck()];
    expect(
      attempts.map((outcome) => outcome instanceof PluginNeedsApprovalError),
    ).toEqual([false, false]);

    const third = await stuck();
    expect(third).toBeInstanceOf(PluginNeedsApprovalError);
    const asked = third as PluginNeedsApprovalError;
    expect(asked.subject.reason).toBe("repeat");
    expect(asked.subject.repeatCount).toBe(3);
  });
});
