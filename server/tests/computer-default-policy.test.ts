import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { ComputerClient } from "../src/computer/client";
import {
  DEFAULT_ACTION_POLICY,
  hostPattern,
  isSimpleTerm,
  MONEY_HOSTS,
  MONEY_WORDS,
  SECRET_FIELD_WORDS,
  wordPattern,
} from "../src/computer/default-policy";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import { evaluateActionPolicy } from "../src/computer/policy";
import type { SnapshotElement, SnapshotResult } from "../src/computer/schema";

/**
 * THE BOUNDARY A DEPLOYMENT GETS BEFORE ANYBODY WRITES ONE.
 *
 * Everything here is the shipped policy, unedited, run through the real gateway — because the thing
 * being tested is not the rule language, it is what happens on somebody's first day. It shipped as
 * `allow: ["true"]` with nothing else in it, so the README's promise that a Bot takes the wheel to a
 * person when it reaches something it should not do alone was true only after an administrator had
 * opened a page and written CEL. Nobody writes that rule before the first time they needed it.
 *
 * The two that matter most are opposites, and both have to hold at once: 출금 승인 stops, and 다음
 * does not. A boundary that asks about everything is one people learn to click through, which is
 * worse than no boundary at all because it produces a record of consent nobody gave.
 */

const ACTOR = { id: "dev-local-user" };

function fakeClient(snapshot: SnapshotResult) {
  const calls: string[] = [];
  const result = (action: string) => ({
    action,
    url: snapshot.url,
    elapsedMs: 1,
  });
  const client = {
    snapshot: async () => snapshot,
    read: async () => ({
      url: snapshot.url,
      title: snapshot.title,
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
    navigate: async () => {
      calls.push("navigate");
      return { url: snapshot.url, title: snapshot.title } as never;
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
    status: async () => ({ botId: "b", state: "ready" as const }),
    screenshot: async () => ({}) as never,
    forBot: () => client,
  } as unknown as ComputerClient;
  return { client, calls };
}

/** A page with the things a Korean small business actually presses on it. */
function pageOf(url: string, elements: SnapshotElement[]): SnapshotResult {
  return { snapshotId: 7, url, title: "page", truncated: false, elements };
}

async function gatewayOn(snapshot: SnapshotResult) {
  const { client, calls } = fakeClient(snapshot);
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const gateway = createComputerGateway({
    client,
    auditStore,
    // The shipped policy, exactly as a deployment that has never opened the Boundaries page has it.
    policy: () => DEFAULT_ACTION_POLICY,
  });
  await gateway.snapshot("default");
  return { gateway, calls, rows };
}

const SHOP = pageOf("https://sajuhook.example/admin/settlement", [
  { ref: "e1", role: "button", name: "다음" },
  { ref: "e2", role: "button", name: "출금 승인" },
  { ref: "e3", role: "textbox", name: "아이디" },
  { ref: "e4", role: "textbox", name: "비밀번호", type: "password" },
  { ref: "e5", role: "textbox", name: "보안 문자", type: "password" },
  { ref: "e6", role: "textbox", name: "계정 암호" },
]);

describe("the boundary a deployment starts with", () => {
  test("asks before pressing 출금 승인", async () => {
    const { gateway, calls } = await gatewayOn(SHOP);

    const asked = (await gateway
      .click("default", "bot-1", ACTOR, { ref: "e2", snapshotId: 7 })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;

    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(asked.question).toContain("출금 승인");
    // And it did not happen while somebody was being asked about it.
    expect(calls).toEqual([]);
  });

  test("does not ask before pressing 다음", async () => {
    // The other half, and the one that decides whether any of this survives contact with a real
    // day's work. A boundary that stops at every button teaches somebody to press Allow without
    // reading, and then the question about 출금 승인 is answered the same way.
    const { gateway, calls } = await gatewayOn(SHOP);

    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
    });

    expect(calls).toEqual(["click"]);
  });

  test("asks before pressing anything at all on a bank", async () => {
    // On a bank the label is not enough to judge by: the button that moves money is often 확인, and
    // often an icon with no label anybody would recognise. The site is the signal.
    const { gateway, calls } = await gatewayOn(
      pageOf("https://obank.kbstar.com/transfer", [
        { ref: "e1", role: "button", name: "확인" },
      ]),
    );

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e1", snapshotId: 7 }),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toEqual([]);
  });

  test("leaves a site that merely ends in a bank's name alone", async () => {
    // `kbstar.com.example.test` is not KB. The rule matches the host or a subdomain of it, so a
    // lookalike domain is not quietly treated as the bank — it is judged on its buttons like
    // anywhere else.
    const { gateway, calls } = await gatewayOn(
      pageOf("https://kbstar.com.example.test/x", [
        { ref: "e1", role: "button", name: "확인" },
      ]),
    );

    await gateway.click("default", "bot-1", ACTOR, {
      ref: "e1",
      snapshotId: 7,
    });
    expect(calls).toEqual(["click"]);
  });

  test("refuses to type into a password field, and says to ask the person instead", async () => {
    // A refusal rather than a question, because there is no answer that makes it right: whatever
    // somebody presses, the value would still have arrived from a model. The Bot has another door —
    // `computer_request_secret` puts the person's own keyboard on the field — and the code is how
    // it is told to use it.
    const { gateway, calls, rows } = await gatewayOn(SHOP);

    const refused = (await gateway
      .type("default", "bot-1", ACTOR, {
        ref: "e4",
        snapshotId: 7,
        text: "hunter2",
      })
      .catch((caught: unknown) => caught)) as ActionRefusedError;

    expect(refused).toBeInstanceOf(ActionRefusedError);
    expect(refused.code).toBe("laf:use_request_secret");
    expect(calls).toEqual([]);
    expect(rows[0]?.eventType).toBe("computer.action_refused");
    expect(
      (rows[0]?.payload.decision as { code?: string } | undefined)?.code,
    ).toBe("laf:use_request_secret");
    // And nothing anywhere in the row is the password.
    expect(JSON.stringify(rows[0])).not.toContain("hunter2");
  });

  test("refuses a field whose label says secret even when nothing said its type", async () => {
    // The type is read out of the DOM and only for the main frame, so a password box inside a
    // payment iframe arrives as an ordinary textbox. The label is the second signal, and it is why
    // the rule names both.
    const { gateway, calls } = await gatewayOn(SHOP);

    await expect(
      gateway.type("default", "bot-1", ACTOR, {
        ref: "e6",
        snapshotId: 7,
        text: "x",
      }),
    ).rejects.toThrow(ActionRefusedError);
    expect(calls).toEqual([]);
  });

  test("lets a Bot type its way through an ordinary form", async () => {
    const { gateway, calls } = await gatewayOn(SHOP);
    await gateway.type("default", "bot-1", ACTOR, {
      ref: "e3",
      snapshotId: 7,
      text: "sajuhook",
    });
    expect(calls).toEqual(["type"]);
  });

  test("asks on the fifth identical attempt", async () => {
    // A stuck model retries, and every retry is a real action on somebody's live website. Each one
    // is reasonable on its own terms — only the count separates the thirtieth click from the first.
    const { gateway, calls } = await gatewayOn(SHOP);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await gateway.click("default", "bot-1", ACTOR, {
        ref: "e1",
        snapshotId: 7,
      });
    }
    expect(calls).toHaveLength(4);

    await expect(
      gateway.click("default", "bot-1", ACTOR, { ref: "e1", snapshotId: 7 }),
    ).rejects.toThrow(ActionNeedsApprovalError);
    expect(calls).toHaveLength(4);
  });

  test("says nothing about a Bot reading its own files", async () => {
    // The shipped rules mention the page and the element, which turns on the gateway's guard against
    // deciding on a screen it has not seen. A workspace call has no screen and never will, so a
    // deployment whose Bot only reads files must not be told to take a snapshot first.
    const { gateway, calls } = await gatewayOn(SHOP);
    await gateway.readFile("default", "bot-1", ACTOR, { path: "notes.md" });
    expect(calls).toEqual(["readFile"]);
  });
});

describe("the shipped rules and somebody else's server", () => {
  test("do not ask a second time about a tool call the guard floor already stops", async () => {
    /*
     * The MCP path asks about money, external effects and destruction on its own (`plugins/store.ts`
     * forces it), and it judges every call against this same policy first. A shipped rule that also
     * matched would put two questions in front of somebody for one action — and the one thing worse
     * than a boundary that does not ask is one that asks twice, because the second question is the
     * one people learn to dismiss.
     *
     * The context is the one the plugin store builds: every browser field present and empty, which
     * is what makes a rule about element names false here rather than unevaluable.
     */
    const verdict = evaluateActionPolicy(DEFAULT_ACTION_POLICY, {
      tool: { name: "mcp__notion__createPage" },
      bot: { id: "bot-1" },
      actor: { id: "someone" },
      page: { url: "", host: "" },
      repeat: { count: 1 },
      element: { ref: "", role: "", name: "", type: "" },
      key: "",
      submit: false,
      file: { path: "", name: "", extension: "" },
      intent: "write_tool",
      mcp: { server: "notion", tool: "createPage", effect: "write" },
    });

    expect(verdict.source).toBe("allow");
    expect(verdict.allowed).toBe(true);
  });
});

describe("the lists the rules are built from", () => {
  test("hold only what the pattern builder can escape", () => {
    // `regexSafe` is total over letters, digits, spaces and dots. A term with a quote in it would
    // produce a CEL expression that does not parse, and an ask rule that throws asks about
    // everything — so the alphabet is asserted rather than assumed.
    const odd = [...MONEY_WORDS, ...MONEY_HOSTS, ...SECRET_FIELD_WORDS].filter(
      (term) => !isSimpleTerm(term),
    );
    expect(odd).toEqual([]);
  });

  test("produce patterns that are valid, and a rule that quotes cleanly", () => {
    expect(() => new RegExp(wordPattern(MONEY_WORDS))).not.toThrow();
    expect(() => new RegExp(hostPattern(MONEY_HOSTS))).not.toThrow();
    for (const rule of [
      ...DEFAULT_ACTION_POLICY.deny,
      ...DEFAULT_ACTION_POLICY.ask,
    ]) {
      // A double quote inside one of these would end the CEL string literal early.
      expect(rule.split('"').length % 2).toBe(1);
    }
  });

  test("match a host and its subdomains, and nothing that merely contains one", () => {
    const hosts = new RegExp(hostPattern(MONEY_HOSTS), "i");
    expect(hosts.test("toss.im")).toBe(true);
    expect(hosts.test("obank.kbstar.com")).toBe(true);
    expect(hosts.test("pay.naver.com")).toBe(true);
    // The seller's own portal, not the shop everybody orders from.
    expect(hosts.test("wing.coupang.com")).toBe(true);
    expect(hosts.test("www.coupang.com")).toBe(false);
    expect(hosts.test("naver.com")).toBe(false);
    expect(hosts.test("kbstar.com.example.test")).toBe(false);
  });

  test("match the words a person reads on a button, in either language", () => {
    const words = new RegExp(wordPattern(MONEY_WORDS), "i");
    expect(words.test("결제하기")).toBe(true);
    expect(words.test("즉시 송금")).toBe(true);
    expect(words.test("Pay now")).toBe(true);
    expect(words.test("DELETE ACCOUNT")).toBe(true);
    expect(words.test("다음")).toBe(false);
    expect(words.test("장바구니 보기")).toBe(false);
  });
});
