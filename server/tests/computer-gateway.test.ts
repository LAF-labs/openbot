import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  createApprovalRegistry,
  fingerprintOf,
} from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import {
  createRepeatDetector,
  type RepeatDetector,
} from "../src/computer/repeat";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import type { SnapshotResult } from "../src/computer/schema";

/**
 * What the gateway must guarantee, tested as properties rather than as call sequences.
 *
 * The four that matter, and none of them are visible from a green typecheck:
 *  - a refused action does NOT reach the computer
 *  - a row is written either way, so the trail cannot only contain successes
 *  - the policy decides on the element the SERVER resolved, never on a label the caller supplied
 *  - the text typed into a field never enters the audit payload
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e1", role: "input", name: "Customer name:", type: "text" },
    { ref: "e9", role: "button", name: "Submit order" },
  ],
};

/** A client that records what reached it, so "did not reach the computer" is checkable. */
function fakeClient() {
  const calls: string[] = [];
  /** Which Bot the gateway addressed the computer as, per call. */
  const addressedAs: string[] = [];
  const result = (action: string) => ({
    action,
    url: SNAPSHOT.url,
    elapsedMs: 1,
  });
  const client = {
    snapshot: async () => SNAPSHOT,
    read: async () => ({
      url: SNAPSHOT.url,
      title: "Order",
      text: "",
      truncated: false,
    }),
    click: async () => {
      calls.push("click");
      return result("click") as never;
    },
    type: async () => {
      calls.push("type");
      return result("type") as never;
    },
    key: async () => {
      calls.push("key");
      return result("key") as never;
    },
    scroll: async () => {
      calls.push("scroll");
      return result("scroll") as never;
    },
    readFile: async () => {
      calls.push("readFile");
      return {
        path: "notes.md",
        text: "kept",
        truncated: false,
        bytes: 4,
      } as never;
    },
    writeFile: async () => {
      calls.push("writeFile");
      return { path: "notes.md", bytes: 4, appended: false } as never;
    },
    status: async () => ({ botId: "b", state: "ready" as const }),
    navigate: async () => {
      calls.push("navigate");
      return { url: "https://example.com/", title: "Example" } as never;
    },
    screenshot: async () => ({}) as never,
    /**
     * The per-Bot view. Recorded rather than ignored, so a test can prove the gateway told the
     * computer which Bot is asking, the thing every per-Bot behaviour on the far side keys off.
     */
    forBot(botId: string) {
      addressedAs.push(botId);
      return client;
    },
  } as unknown as ComputerClient;
  return { client, calls, addressedAs };
}

function fakeAudit() {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  return { store, rows };
}

const ACTOR = { id: "dev-local-user" };
/** A second person, with a real users row, so the approval rows can be told apart by who wrote them. */
const MANAGER = { id: "manager-user", userId: "manager-user" };
const PERMISSIVE: ActionPolicy = {
  deny: [],
  ask: [],
  allow: ["true"],
};

async function gatewayWith(
  policy: ActionPolicy | undefined,
  /** Only the repetition tests supply one; everything else gets the gateway's own. */
  repeat?: RepeatDetector,
) {
  const { client, calls } = fakeClient();
  const { store, rows } = fakeAudit();
  // The registry the deployment shares between everything that can ask. Held here so these tests can
  // answer a question the way a person does, without going through the surface they answer it on;
  // that surface has its own tests.
  const approvals = createApprovalRegistry();
  // Empty unless a test grants something, so every test that says nothing about allowances is
  // testing the gateway exactly as it behaved before they existed.
  const standing = createStandingApprovalStore();
  const gateway = createComputerGateway({
    client,
    auditStore: store,
    policy: () => policy,
    approvals,
    standing,
    ...(repeat ? { repeat } : {}),
  });
  // Every test acts on refs, so the server must hold a snapshot first, exactly as the real flow does.
  await gateway.snapshot("default");
  return { gateway, approvals, standing, calls, rows };
}

describe("the computer gateway", () => {
  test("carries out an allowed action and records it", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE);
    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
  });

  test("a refused action never reaches the computer", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);

    // The decision happens before the effect.
    expect(calls).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("the refusal names the rule, so an operator can find it", async () => {
    const { gateway } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });

    const error = await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionRefusedError);
    expect((error as ActionRefusedError).rule).toBe(
      'contains(element.name, "submit")',
    );
  });

  test("the policy sees the element the SERVER resolved, not what the caller claimed", async () => {
    // The evasion this prevents: calling the Submit button something harmless in the request. The
    // caller only ever sends a ref, and the gateway looks it up in the snapshot it fetched itself.
    const { gateway, calls } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(element.name, "submit")'],
    });

    await expect(
      gateway.click("default", "bot-1", ACTOR, {
        ref: "e9",
        snapshotId: 7,
        // Not part of the input contract, and must not influence anything even when supplied.
        ...({ name: "Continue", element: { name: "Continue" } } as object),
      }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
  });

  test("an allowed action reports the element's label for the transcript", async () => {
    const { gateway } = await gatewayWith(PERMISSIVE);
    const result = await gateway.type("default", "bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "Grace Hopper",
    });
    expect(result.element?.name).toBe("Customer name:");
  });

  test("the typed text never enters the audit payload", async () => {
    const { gateway, rows } = await gatewayWith(PERMISSIVE);
    await gateway.type("default", "bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "hunter2-not-a-real-password",
    });

    // Serialized and searched, rather than checking known keys: the guarantee is that the value is
    // nowhere in the row, not that one particular field omits it.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("hunter2");
    expect(rows[0]?.payload.element).toEqual({
      role: "input",
      name: "Customer name:",
      // The control's type is recorded too: knowing a value went into a `password` field rather than
      // a `text` one is exactly the distinction an investigator needs, and it is not the value.
      type: "text",
    });
  });

  test("an absent policy refuses every action", async () => {
    const { gateway, calls, rows } = await gatewayWith(undefined);
    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("a policy that still names dry-run refuses anyway", async () => {
    // The mode is gone (§7-10). A saved policy that still carries it must not be honoured: a
    // deployment that had switched its boundary off would go on having it off, silently, past the
    // release that removed the way to say so.
    const { gateway, calls, rows } = await gatewayWith({
      mode: "dry-run",
      deny: ['contains(element.name, "submit")'],
      ask: [],
      allow: ["true"],
    } as unknown as ActionPolicy);

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);

    expect(calls).toEqual([]);
    const decision = rows[0]?.payload.decision as { carriedOut?: boolean };
    expect(rows[0]?.eventType).toBe("computer.action_refused");
    expect(decision.carriedOut).toBe(false);
  });

  test("the local development actor is kept out of the audit foreign key", async () => {
    // Writing an id with no `users` row fails the constraint and loses the row entirely, so who it
    // was is carried in the payload instead. The route decides this; the gateway must honour it.
    const { gateway, rows } = await gatewayWith(PERMISSIVE);
    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });
    expect(rows[0]?.actorUserId).toBeUndefined();
    expect(rows[0]?.payload.actor).toBe("dev-local-user");
  });

  test("a file read is governed, not passed through", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['contains(file.path, "credentials")'],
    });

    await expect(
      gateway.readFile("default", "bot-1", ACTOR, {
        path: "credentials/aws.txt",
      }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
    expect(rows[0]?.payload.file).toBe("credentials/aws.txt");
  });

  test("a rule can be written against a file's extension", async () => {
    const { gateway, calls } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['file.extension == "env"'],
    });

    await expect(
      gateway.readFile("default", "bot-1", ACTOR, { path: "config/prod.env" }),
    ).rejects.toThrow(ActionRefusedError);
    // A different extension in the same folder is untouched by that rule.
    await gateway.readFile("default", "bot-1", ACTOR, {
      path: "config/prod.json",
    });
    expect(calls).toEqual(["readFile"]);
  });

  test("a permitted write happens and is recorded by path, never by contents", async () => {
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE);
    await gateway.writeFile("default", "bot-1", ACTOR, {
      path: "notes.md",
      contents: "the customer's card number is 4111-1111-1111-1111",
    });

    expect(calls).toEqual(["writeFile"]);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
    expect(rows[0]?.payload.file).toBe("notes.md");
    // The same guarantee as typed text: a Bot writes down what it was told, so a file body is exactly
    // as sensitive and is never put in the row.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("4111");
  });

  test("the computer is told WHICH Bot is asking", async () => {
    // Every per-Bot behaviour on the computer keys off this id: the profile it opens, the logins it
    // has, the proxy its traffic leaves through, and who holds its wheel.
    const { client, addressedAs } = fakeClient();
    const { store } = fakeAudit();
    const gateway = createComputerGateway({
      client,
      auditStore: store,
      policy: () => PERMISSIVE,
    });

    await gateway.snapshot("sales-bot");
    await gateway.click("sales-bot", "sales-bot", ACTOR, "e1");
    await gateway.read("research-bot");

    expect(addressedAs).toContain("sales-bot");
    expect(addressedAs).toContain("research-bot");
    // A call must never reach a different Bot's computer.
    expect(
      addressedAs.every((id) => id === "sales-bot" || id === "research-bot"),
    ).toBe(true);
  });

  test("a permitted action that FAILS gets its own row, not an allowed one", async () => {
    // A permitted read that later fails path confinement records both the decision and the failed
    // outcome, so the trail does not imply the Bot received the file.
    const { client, calls } = fakeClient();
    const { store, rows } = fakeAudit();
    const failing: ComputerClient = {
      ...client,
      readFile: async () => {
        calls.push("readFile");
        throw new Error("that path is outside your workspace");
      },
      forBot: () => failing,
    } as unknown as ComputerClient;
    const gateway = createComputerGateway({
      client: failing,
      auditStore: store,
      policy: () => PERMISSIVE,
    });

    await expect(
      gateway.readFile("default", "bot-1", ACTOR, { path: "../../etc/passwd" }),
    ).rejects.toThrow();

    expect(rows).toHaveLength(2);
    // The decision, then the outcome. Both are needed: the first says it was permitted, the second
    // says it did not happen, and neither on its own is the truth.
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
    expect(rows[1]?.eventType).toBe("computer.action_failed");
    expect(rows[1]?.payload.failure).toContain("outside your workspace");
  });

  test("opening a page is recorded, with the address it was opening", async () => {
    // The target guard refuses a forbidden address inside the
    // client and nothing was written, so an attempt on the cloud metadata endpoint left no row while
    // ticking a radio button left one.
    const { gateway, calls, rows } = await gatewayWith(PERMISSIVE);
    await gateway.navigate("default", "bot-1", ACTOR, "https://example.com/");

    expect(calls).toEqual(["navigate"]);
    expect(rows[0]?.eventType).toBe("computer.action_allowed");
    expect(rows[0]?.payload.action).toBe("computer_navigate");
    expect(rows[0]?.payload.page).toBe("https://example.com/");
  });

  test("a rule can refuse a navigation by its DESTINATION host", async () => {
    // The destination, not the page already loaded. Deciding on the current URL would make a rule
    // about where a Bot may go structurally unable to say anything about where it is going.
    const { gateway, calls } = await gatewayWith({
      ...PERMISSIVE,
      deny: ['page.host == "intranet.example.com"'],
    });

    await expect(
      gateway.navigate(
        "default",
        "bot-1",
        ACTOR,
        "https://intranet.example.com/hr",
      ),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);

    await gateway.navigate("default", "bot-1", ACTOR, "https://example.com/");
    expect(calls).toEqual(["navigate"]);
  });

  test("an action on an unresolvable ref is still decided and still recorded", async () => {
    const { gateway, rows } = await gatewayWith(PERMISSIVE);
    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e404",
      snapshotId: 7,
    });
    // Permitted here only because the shipped default permits; the row says plainly that the server
    // could not identify what was touched, rather than omitting the field.
    expect(rows[0]?.payload.element).toBe("not in the current snapshot");
  });
});

/**
 * The path where the boundary stops and asks.
 *
 * Everything above proves the gateway can say yes or no. These prove it can say "not yet", which is
 * a harder thing to get right: the action must not reach the computer, the trail must show the
 * question rather than a verdict nobody reached, and the answer must only work for the action it was
 * given for. That last one is why the error carries an id at all.
 */
describe("the gateway when the boundary asks a person", () => {
  const ASKING: ActionPolicy = {
    deny: [],
    ask: ['contains(element.name, "submit")'],
    allow: ["true"],
  };

  test("stops the action and asks, rather than refusing it", async () => {
    const { gateway, calls, rows } = await gatewayWith(ASKING);

    const error = await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionNeedsApprovalError);
    // Not a refusal. A Bot told it was blocked gives up and says so; this one is meant to wait.
    expect(error).not.toBeInstanceOf(ActionRefusedError);
    expect(calls).toEqual([]);

    // One row, and it is the question. Nothing was allowed and nothing was refused, so writing
    // either would put a verdict in the trail that the policy never reached.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("approval.requested");
    expect(rows[0]?.payload.rule).toBe('contains(element.name, "submit")');
    expect(rows[0]?.payload.action).toBe("computer_click");
    expect(rows[0]?.payload.approval).toBe(
      (error as ActionNeedsApprovalError).approvalId,
    );
  });

  test("carries the action out once a person has allowed it", async () => {
    const { gateway, approvals, calls, rows } = await gatewayWith(ASKING);
    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

    await approvals.answer(asked.approvalId, "bot-1", MANAGER.id, true);
    await gateway.click(
      "default",
      "bot-1",
      ACTOR,
      { ref: "e9", snapshotId: 7 },
      undefined,
      asked.approvalId,
    );

    expect(calls).toEqual(["click"]);
    // Two rows here, and the third is written where the answer was given: the question, and the
    // action it turned into. The action's own row says a person stood behind it and names them,
    // rather than reading as an ordinary permission nobody ever questioned.
    expect(rows.map((row) => row.eventType)).toEqual([
      "approval.requested",
      "computer.action_allowed",
    ]);
    const decision = rows[1]?.payload.decision as {
      source?: string;
      approvedBy?: string;
    };
    expect(decision.source).toBe("ask");
    expect(decision.approvedBy).toBe("manager-user");
  });

  test("an allowance somebody granted means it is not asked again", async () => {
    const { gateway, standing, calls, rows } = await gatewayWith(ASKING);
    // Granted the way the answering route grants it: the Bot, the rule that asked, and the scope
    // the gateway itself derives — here the site, because a click carries no file path.
    await standing.grant({
      botId: "bot-1",
      rule: 'contains(element.name, "submit")',
      scope: { kind: "host", value: "example.com" },
      question: "Place the order?",
      grantedBy: MANAGER.id,
    });

    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    // No question at all: one row, and it is the action.
    expect(calls).toEqual(["click"]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
    ]);
    const decision = rows[0]?.payload.decision as {
      source?: string;
      approvedBy?: string;
      allowance?: string;
      allowanceScope?: string;
    };
    // Still an `ask` that a person stood behind, so the trail does not read as an ordinary
    // permission — but it says the yes came from an allowance rather than from somebody looking at
    // this action, which is a different amount of attention and must not be reported as the same.
    expect(decision.source).toBe("ask");
    expect(decision.approvedBy).toBe("manager-user");
    expect(decision.allowanceScope).toBe("host=example.com");
    expect(decision.allowance).toEqual(expect.any(String));
  });

  test("an allowance for one site does not cover another", async () => {
    const { gateway, standing, calls, rows } = await gatewayWith(ASKING);
    await standing.grant({
      botId: "bot-1",
      rule: 'contains(element.name, "submit")',
      scope: { kind: "host", value: "elsewhere.test" },
      question: "Place the order?",
      grantedBy: MANAGER.id,
    });

    const error = await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
    expect(rows.map((row) => row.eventType)).toEqual(["approval.requested"]);
  });

  test("an allowance for one Bot does not cover another Bot", async () => {
    const { gateway, standing, calls } = await gatewayWith(ASKING);
    await standing.grant({
      botId: "bot-1",
      rule: 'contains(element.name, "submit")',
      scope: { kind: "host", value: "example.com" },
      question: "Place the order?",
      grantedBy: MANAGER.id,
    });

    const error = await gateway
      .click("default", "bot-2", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
  });

  test("the question carries the scope answering it with always would cover", async () => {
    const { gateway } = await gatewayWith(ASKING);
    const error = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

    // What the button on the card is allowed to say. Derived here, from the action, so that the
    // sentence a person reads and the grant that follows are one fact rather than two.
    expect(error.scope).toEqual({ kind: "host", value: "example.com" });
  });

  test("an approval for one action does not carry to another", async () => {
    // The grant is bound to a fingerprint of the exact call. Pressing a different thing on the same
    // page with the same id in hand asks again rather than going through, which is the difference
    // between an approval and a token good for anything.
    const { gateway, approvals, calls } = await gatewayWith({
      ...ASKING,
      ask: ["true"],
    });
    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, "bot-1", MANAGER.id, true);

    await expect(
      gateway.click(
        "default",
        "bot-1",
        ACTOR,
        { ref: "e1", snapshotId: 7 },
        undefined,
        asked.approvalId,
      ),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
  });

  /**
   * THE FAILURE THIS PAIR REPLACES.
   *
   * A decline used to leave the row and nothing else, so the next attempt found no approval to spend
   * and opened a fresh question. A Bot could ask the same thing indefinitely and the only thing
   * standing between somebody and being worn down was their patience — which is not what pressing
   * Deny means. Both halves are tested: the same action is refused without a question, and a
   * different action is untouched by it.
   */
  test("a declined request is refused rather than asked again", async () => {
    const { gateway, approvals, calls, rows } = await gatewayWith(ASKING);
    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

    await approvals.answer(asked.approvalId, "bot-1", MANAGER.id, false);
    const refused = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionRefusedError;

    expect(refused).toBeInstanceOf(ActionRefusedError);
    expect(refused.code).toBe("laf:declined_recently");
    expect(calls).toEqual([]);
    // And the trail says which kind of refusal it was, rather than naming a rule that did not fire.
    expect(rows.at(-1)?.eventType).toBe("computer.action_refused");
    expect(
      (rows.at(-1)?.payload.decision as { code?: string } | undefined)?.code,
    ).toBe("laf:declined_recently");
    // No second question was opened. Answering one and being asked it again is the shape being fixed.
    expect(
      rows.filter((row) => row.eventType === "approval.requested"),
    ).toHaveLength(1);
  });

  test("a declined action does not refuse the Bot's other work", async () => {
    const { gateway, approvals, calls } = await gatewayWith({
      ...PERMISSIVE,
      ask: ['intent == "activate"'],
    });
    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, "bot-1", MANAGER.id, false);

    // A different element, so a different fingerprint: still a question, not a refusal.
    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e1", snapshotId: 7 }),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
  });

  test("a fresh yes gets past a No that is still standing", async () => {
    // The sticky refusal is a bound on the Bot asking again, never on the person changing their
    // mind: a grant presented for this exact action is spent as it always was.
    const { gateway, approvals, calls } = await gatewayWith(ASKING);
    const first = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
    await approvals.answer(first.approvalId, "bot-1", MANAGER.id, false);

    // What the surface does when somebody answers a question raised on another line: the person's
    // yes is bound to the same action by fingerprint.
    const second = await approvals.request({
      botId: "bot-1",
      actor: ACTOR.id,
      rule: ASKING.ask[0] as string,
      question: "again",
      fingerprint: fingerprintOf({
        botId: "bot-1",
        toolName: "computer_click",
        ref: "e9",
        pageUrl: SNAPSHOT.url,
      }),
      target: { type: "computer", id: "default" },
    });
    await approvals.answer(second.id, "bot-1", MANAGER.id, true);

    await gateway.click(
      "default",
      "bot-1",
      ACTOR,
      { ref: "e9", snapshotId: 7 },
      undefined,
      second.id,
    );
    expect(calls).toEqual(["click"]);
  });

  test("a type call that will press Enter is judged as one that submits", async () => {
    // The third door into a form. The computer presses Enter itself when the Bot asks it to, so no
    // keypress ever reaches the gateway as an action of its own, and a boundary written about
    // clicking and about `key` let the one call that submits a single-field form through.
    const { gateway, calls } = await gatewayWith({
      ...PERMISSIVE,
      ask: ["submit"],
    });

    await expect(
      gateway.type("default", "bot-1", ACTOR, {
        ref: "e1",
        snapshotId: 7,
        text: "SW1A 1AA",
        submit: true,
      }),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);

    // Filling the same field in without submitting is not the same action and is not asked about.
    await gateway.type("default", "bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "SW1A 1AA",
    });
    expect(calls).toEqual(["type"]);
  });

  test("an answer given for typing is not spendable on typing and submitting", async () => {
    // Submitting is the escalation the binding has to cover: "yes, fill the postcode in" is not
    // "yes, fill it in and send the form".
    const { gateway, approvals, calls } = await gatewayWith({
      ...PERMISSIVE,
      ask: ["true"],
    });
    const asked = (await gateway
      .type("default", "bot-1", ACTOR, {
        ref: "e1",
        snapshotId: 7,
        text: "SW1A 1AA",
      })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, "bot-1", MANAGER.id, true);

    await expect(
      gateway.type(
        "default",
        "bot-1",
        ACTOR,
        { ref: "e1", snapshotId: 7, text: "SW1A 1AA", submit: true },
        undefined,
        asked.approvalId,
      ),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
  });

  test("the question is visible to the surface while it is open", async () => {
    const { gateway, approvals } = await gatewayWith(ASKING);
    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

    const waiting = await approvals.pending("bot-1");
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.id).toBe(asked.approvalId);
    expect(waiting[0]?.question).toContain("Submit order");
    // Another Bot's screen must not offer somebody a question about this one's computer.
    expect(await approvals.pending("bot-2")).toEqual([]);
  });

  test("an ask under a policy that still names dry-run stops anyway", async () => {
    // The mode used to turn every question into a note in the trail while the action went through.
    // A deployment upgrading with that field still saved gets asked, which is what the rule it
    // wrote says on the page.
    const { gateway, calls, rows } = await gatewayWith({
      ...ASKING,
      mode: "dry-run",
    } as unknown as ActionPolicy);

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionNeedsApprovalError);

    expect(calls).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("approval.requested");
  });

  test("a deny beats an ask on the same action", async () => {
    // Precedence, through the gateway rather than only in the evaluator: a forbidden thing is refused
    // outright and is never put in front of a person as a question they could say yes to.
    const { gateway, calls, rows } = await gatewayWith({
      ...ASKING,
      deny: ['contains(element.name, "submit")'],
    });

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("a file write can be held back the same way a click can", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      deny: [],
      ask: ['intent == "write_file" && !matches(file.path, "^notes/")'],
      allow: ["true"],
    });

    await expect(
      gateway.writeFile("default", "bot-1", ACTOR, {
        path: "reports/august.csv",
        contents: "anything",
      }),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
    expect(rows[0]?.payload.file).toBe("reports/august.csv");

    // A path the rule leaves alone still goes straight through, or the rule would be a deny wearing
    // a different name.
    await gateway.writeFile("default", "bot-1", ACTOR, {
      path: "notes/today.md",
      contents: "anything",
    });
    expect(calls).toEqual(["writeFile"]);
  });
});

/**
 * The gateway is the only place that can count this, which is why it does.
 *
 * Every governed action already passes through one function that already writes a row for it, so
 * counting is very nearly free here and impossible anywhere else. The part that matters is where the
 * count goes: into the policy context, before the decision, so a deployment can act on it rather than
 * read about it a week later.
 */
describe("a Bot going in circles", () => {
  const click = { ref: "e9", snapshotId: 7 };

  test("the count reaches the policy, and the rule refuses the attempt that crosses the line", async () => {
    const { gateway, calls, rows } = await gatewayWith({
      ...PERMISSIVE,
      deny: ["repeat.count >= 3"],
    });

    await gateway.click("default", "bot-1", ACTOR, click);
    await gateway.click("default", "bot-1", ACTOR, click);
    // The first two are the same action on the same button and nothing about them is objectionable.
    expect(calls).toEqual(["click", "click"]);

    await expect(
      gateway.click("default", "bot-1", ACTOR, click),
    ).rejects.toThrow(ActionRefusedError);
    // Counted before the decision, so the third attempt is the one refused rather than the fourth.
    expect(calls).toEqual(["click", "click"]);
    expect(rows.at(-1)?.eventType).toBe("computer.action_refused");
  });

  test("a rule about repetition leaves a Bot doing varied work alone", async () => {
    // The failure that would take this feature back out again: a Bot working steadily down a form
    // refused for doing its job.
    const { gateway, calls } = await gatewayWith({
      ...PERMISSIVE,
      deny: ["repeat.count >= 3"],
    });

    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
    });
    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });
    await gateway.type("default", "bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
      text: "Grace Hopper",
    });

    expect(calls).toEqual(["click", "click", "type"]);
  });

  test("crossing a threshold writes its own row, ahead of the decision it explains", async () => {
    const { gateway, rows } = await gatewayWith(
      PERMISSIVE,
      createRepeatDetector({ thresholds: [3] }),
    );

    await gateway.click("default", "bot-1", ACTOR, click);
    await gateway.click("default", "bot-1", ACTOR, click);
    await gateway.click("default", "bot-1", ACTOR, click);

    // Two allowed actions, then the observation, then the third allowed action. Filed the other way
    // round a reader has to deduce the cause from a row written after its effect.
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
      "computer.action_allowed",
      "computer.action_repeated",
      "computer.action_allowed",
    ]);
  });

  test("the row says which call, and how many times", async () => {
    const { gateway, rows } = await gatewayWith(
      PERMISSIVE,
      createRepeatDetector({ thresholds: [2] }),
    );

    await gateway.click("default", "bot-1", ACTOR, click);
    await gateway.click("default", "bot-1", ACTOR, click);

    const repeated = rows.find(
      (row) => row.eventType === "computer.action_repeated",
    );
    expect(repeated?.payload).toMatchObject({
      action: "computer_click",
      bot: "bot-1",
      fingerprint: "computer_click ref=e9",
      count: 2,
    });
    // Not a refusal, and it must not carry the furniture of one. A row with a `decision` block would
    // read as the policy having answered a question nobody asked it.
    expect(repeated?.payload.decision).toBeUndefined();
  });

  test("a refused action is still counted, because the Bot still tried", async () => {
    // A Bot hammering a button the policy forbids is going in circles as surely as one hammering a
    // button that works, and it is the case an operator most wants to see.
    const { gateway, rows } = await gatewayWith(
      { ...PERMISSIVE, deny: ['contains(element.name, "submit")'] },
      createRepeatDetector({ thresholds: [2] }),
    );

    await gateway.click("default", "bot-1", ACTOR, click).catch(() => {});
    await gateway.click("default", "bot-1", ACTOR, click).catch(() => {});

    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_refused",
      "computer.action_repeated",
      "computer.action_refused",
    ]);
  });

  test("two Bots on one gateway do not pool a count", async () => {
    const { gateway, rows } = await gatewayWith(
      PERMISSIVE,
      createRepeatDetector({ thresholds: [2] }),
    );

    await gateway.click("default", "sales-bot", ACTOR, click);
    await gateway.click("default", "research-bot", ACTOR, click);

    // One click each. A pooled count would file this against whichever Bot happened to go second.
    expect(
      rows.some((row) => row.eventType === "computer.action_repeated"),
    ).toBe(false);
  });

  test("a call with nothing to distinguish it is never reported as a repeat", async () => {
    // Scrolling names no element. Counting it by tool name alone would report a Bot reaching the
    // bottom of a long page as one going in circles.
    const { gateway, rows } = await gatewayWith(
      PERMISSIVE,
      createRepeatDetector({ thresholds: [2] }),
    );

    await gateway.scroll("default", "bot-1", ACTOR, { direction: "down" });
    await gateway.scroll("default", "bot-1", ACTOR, { direction: "down" });
    await gateway.scroll("default", "bot-1", ACTOR, { direction: "down" });

    expect(
      rows.every((row) => row.eventType === "computer.action_allowed"),
    ).toBe(true);
  });

  test("a lost observation row does not refuse an action the policy allows", async () => {
    // The detector observes and the policy decides, and that has to survive the audit store having a
    // bad moment. Letting the observation row throw would refuse every third, tenth and twenty-fifth
    // identical call, before the policy had been asked, on an action nothing objected to.
    const { client, calls } = fakeClient();
    const rows: AuditEventInput[] = [];
    const store: AuditStore = {
      insert: async (event) => {
        if (event.eventType === "computer.action_repeated") {
          throw new Error("the audit store is unreachable");
        }
        rows.push(event);
      },
    };
    const gateway = createComputerGateway({
      client,
      auditStore: store,
      policy: () => PERMISSIVE,
      repeat: createRepeatDetector({ thresholds: [2] }),
    });
    await gateway.snapshot("default");

    await gateway.click("default", "bot-1", ACTOR, click);
    await gateway.click("default", "bot-1", ACTOR, click);

    // Both clicks happened and both decisions are on the record. What was lost is the note saying
    // they were the same click twice, which is the only thing that may be lost here.
    expect(calls).toEqual(["click", "click"]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
      "computer.action_allowed",
    ]);
  });

  test("a repeated file write names the path and not the browser's page", async () => {
    // The workspace has nothing to do with whatever the browser happens to be showing, and naming a
    // host on that row sends a reader somewhere irrelevant.
    const { gateway, rows } = await gatewayWith(
      PERMISSIVE,
      createRepeatDetector({ thresholds: [2] }),
    );

    await gateway.writeFile("default", "bot-1", ACTOR, {
      path: "notes.md",
      contents: "again",
    });
    await gateway.writeFile("default", "bot-1", ACTOR, {
      path: "notes.md",
      contents: "again",
    });

    const repeated = rows.find(
      (row) => row.eventType === "computer.action_repeated",
    );
    expect(repeated?.payload.fingerprint).toBe(
      "computer_write_file file=notes.md",
    );
    expect(repeated?.payload.page).toBeUndefined();
  });
});

/**
 * What a second server process may decide.
 *
 * The snapshot cache lives in the process that took it. A deployment behind a load balancer routes
 * the next call to a process that has never seen the window, and the fields a rule reads arrive
 * blank. `element` is safe by accident — CEL throws on an identifier that is not in the context and
 * the gateway treats a thrown deny as a refusal — but `page` is always present as `{url:"",host:""}`,
 * so a rule about the host simply stops matching and the action goes through. These tests pin the
 * refusal, and pin that a deployment which never mentions the page loses nothing to it.
 */
describe("a process holding no snapshot", () => {
  /** Deliberately never snapshots, unlike `gatewayWith`. */
  function blindGateway(policy: ActionPolicy) {
    const { client, calls } = fakeClient();
    const { store, rows } = fakeAudit();
    const gateway = createComputerGateway({
      client,
      auditStore: store,
      policy: () => policy,
      approvals: createApprovalRegistry(),
    });
    return { gateway, calls, rows };
  }

  test("refuses an action a page rule was written against", async () => {
    const { gateway, calls } = blindGateway({
      ...PERMISSIVE,
      deny: ['page.host == "example.com"'],
    });

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
  });

  test("says the screen was not seen, rather than naming a rule", async () => {
    const { gateway, rows } = blindGateway({
      ...PERMISSIVE,
      deny: ['page.host == "example.com"'],
    });

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow(/has not seen the computer's screen/);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
  });

  test("lets a deployment that never mentions the page carry on", async () => {
    const { gateway, calls } = blindGateway(PERMISSIVE);

    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
  });

  test("still decides a navigation, which carries its own destination", async () => {
    const { gateway, calls } = blindGateway({
      ...PERMISSIVE,
      deny: ['page.host == "blocked.example"'],
    });

    await gateway.navigate("default", "bot-1", ACTOR, "https://example.com/");
    expect(calls).toEqual(["navigate"]);

    await expect(
      gateway.navigate("default", "bot-1", ACTOR, "https://blocked.example/"),
    ).rejects.toThrow(ActionRefusedError);
  });

  test("a file call is decided without one, because no snapshot would describe it", async () => {
    // The shipped policy now mentions the page and the element, so this guard applies to every
    // deployment rather than only to one that wrote such a rule. Without the workspace exemption a
    // Bot that only reads files would be refused for not having looked at a web page — and told to
    // take a snapshot of a screen it was never using.
    const { gateway, calls } = blindGateway({
      ...PERMISSIVE,
      ask: ['intent == "activate" && contains(element.name, "pay")'],
    });

    await gateway.readFile("default", "bot-1", ACTOR, { path: "notes.md" });
    await gateway.writeFile("default", "bot-1", ACTOR, {
      path: "notes.md",
      contents: "kept",
      append: false,
    });

    expect(calls).toEqual(["readFile", "writeFile"]);
  });
});

/**
 * A deployment that has decided every one of these gets a pair of eyes.
 *
 * The allowance is a real widening of a boundary, and until this existed there was no way to say
 * no to it: any administrator could stand down any ask rule from a transcript line, and the person
 * doing it at the end of a long task is not deciding policy, they are clearing an obstacle. Grok
 * names the same thing — "Always allow is disabled by team policy".
 *
 * The switch expresses itself as the ABSENCE OF A SCOPE on the question. One decision made once, in
 * the place that already knows the policy, rather than the same rule written into a lookup, a
 * button and an answering handler and kept in agreement by hand.
 */
describe("when the boundary refuses to be answered for good", () => {
  const NO_STANDING: ActionPolicy = {
    deny: [],
    ask: ['contains(element.name, "submit")'],
    allow: ["true"],
    settleWithoutAsking: "off",
  };

  test("the question carries no scope, so nothing offers to grant one", async () => {
    const { gateway } = await gatewayWith(NO_STANDING);
    const error = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

    expect(error).toBeInstanceOf(ActionNeedsApprovalError);
    // The card draws its wider button from this and the answering route grants from it. Absent, the
    // question has two answers and neither of them is "for good".
    expect(error.scope).toBeUndefined();
  });

  test("an allowance granted before the switch is not honoured while it is off", async () => {
    // Not deleted — suspended. A policy is what is in force now, and a switch that left last week's
    // allowances working would not restore the boundary it appears to restore.
    const { gateway, standing, calls, rows } = await gatewayWith(NO_STANDING);
    await standing.grant({
      botId: "bot-1",
      rule: 'contains(element.name, "submit")',
      scope: { kind: "host", value: "example.com" },
      question: "Place the order?",
      grantedBy: MANAGER.id,
    });

    const error = await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
    expect(rows.map((row) => row.eventType)).toEqual(["approval.requested"]);
  });

  test("and it works again the moment the switch comes back", async () => {
    let policy: ActionPolicy = NO_STANDING;
    const { client, calls } = fakeClient();
    const { store, rows } = fakeAudit();
    const standing = createStandingApprovalStore();
    const gateway = createComputerGateway({
      client,
      auditStore: store,
      policy: () => policy,
      approvals: createApprovalRegistry(),
      standing,
    });
    await gateway.snapshot("default");
    await standing.grant({
      botId: "bot-1",
      rule: 'contains(element.name, "submit")',
      scope: { kind: "host", value: "example.com" },
      question: "Place the order?",
      grantedBy: MANAGER.id,
    });

    policy = { ...NO_STANDING, settleWithoutAsking: "allowed" };
    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
    ]);
  });
});

/**
 * The owner's own sentence, applied to a stopped action.
 *
 * The ordering is the interesting part and it is not cosmetic: a presented approval and a standing
 * allowance are a lookup each, and this is a model call on the path of an action a Bot is waiting
 * to take. It also must not run at all where the deployment has said every action gets seen.
 *
 * And what it produces must never read as an approval. Nobody looked at this one.
 */
describe("when a Bot has an instruction of its own", () => {
  const ASKING_ONLY: ActionPolicy = {
    deny: [],
    ask: ['contains(element.name, "submit")'],
    allow: ["true"],
  };

  /** A gateway whose judge always answers this, recording what it was asked. */
  async function gatewayJudging(
    verdict: { allowed: boolean; reason: string } | null,
    policy: ActionPolicy = ASKING_ONLY,
  ) {
    const asked: Array<{ botId: string; subject: Record<string, unknown> }> =
      [];
    const { client, calls } = fakeClient();
    const { store, rows } = fakeAudit();
    const standing = createStandingApprovalStore();
    const gateway = createComputerGateway({
      client,
      auditStore: store,
      policy: () => policy,
      approvals: createApprovalRegistry(),
      standing,
      autoReview: async (botId, subject) => {
        asked.push({ botId, subject: subject as never });
        return verdict;
      },
    });
    await gateway.snapshot("default");
    return { gateway, standing, calls, rows, asked };
  }

  test("a yes lets the action through without anybody being asked", async () => {
    const { gateway, calls, rows } = await gatewayJudging({
      allowed: true,
      reason: "Reading a page on our own site.",
    });

    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
    ]);
    const decision = rows[0]?.payload.decision as {
      approvedBy?: string;
      autoReviewed?: string;
    };
    // NOBODY'S NAME. `approvedBy` is what says a person stood behind an action, and no person did.
    expect(decision.approvedBy).toBeUndefined();
    expect(decision.autoReviewed).toBe("Reading a page on our own site.");
  });

  test("a no asks a person, as though there had been no instruction", async () => {
    const { gateway, calls, rows } = await gatewayJudging({
      allowed: false,
      reason: "This submits a form.",
    });

    const error = await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
    expect(rows.map((row) => row.eventType)).toEqual(["approval.requested"]);
  });

  test("it is judged on what the server resolved, not on what was claimed", async () => {
    const { gateway, asked } = await gatewayJudging({
      allowed: false,
      reason: "no",
    });
    await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch(() => {});

    // The element comes from this server's own snapshot. A judge shown a label the caller supplied
    // would be deciding on the attacker's description of the attacker's button.
    expect(asked[0]?.botId).toBe("bot-1");
    expect(asked[0]?.subject.element).toEqual({
      role: "button",
      name: "Submit order",
    });
    expect(asked[0]?.subject.host).toBe("example.com");
  });

  test("a standing allowance answers first, and no model is asked", async () => {
    const { gateway, standing, calls, asked } = await gatewayJudging({
      allowed: false,
      reason: "no",
    });
    await standing.grant({
      botId: "bot-1",
      rule: 'contains(element.name, "submit")',
      scope: { kind: "host", value: "example.com" },
      question: "Place the order?",
      grantedBy: MANAGER.id,
    });

    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e9",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
    // A lookup already answered this. Spending a model call to be told the same thing is latency on
    // the path of an action a Bot is waiting to take.
    expect(asked).toEqual([]);
  });

  test("nothing is judged where the deployment has said every action is seen", async () => {
    const { gateway, calls, asked } = await gatewayJudging(
      { allowed: true, reason: "Reading is fine." },
      { ...ASKING_ONLY, settleWithoutAsking: "off" },
    );

    const error = await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    // The one switch covers both ways past. A deployment that turned it off to stop allowances and
    // found a model still waving actions through would have been told something untrue.
    expect(error).toBeInstanceOf(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a deny is never put to it", async () => {
    const { gateway, calls, asked } = await gatewayJudging(
      { allowed: true, reason: "Reading is fine." },
      {
        deny: ['contains(element.name, "submit")'],
        ask: ["true"],
        allow: ["true"],
      },
    );

    const error = await gateway
      .click("default", "bot-1", ACTOR, { ref: "e9", snapshotId: 7 })
      .catch((caught: unknown) => caught);

    // Deny beats ask, so this never reaches the branch. Nothing a deployment has forbidden is up
    // for a model's opinion, which is the property that makes the whole feature arguable at all.
    expect(error).toBeInstanceOf(ActionRefusedError);
    expect(calls).toEqual([]);
    expect(asked).toEqual([]);
  });
});
