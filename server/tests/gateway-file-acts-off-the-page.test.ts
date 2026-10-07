import { describe, expect, test } from "bun:test";
import { MONEY_HOST_RULE } from "../../shared/policy-rules";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import { DEFAULT_ACTION_POLICY } from "../src/computer/default-policy";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { bytes, fakeComputer, fakeWorkbench, made } from "./support/script-run";

/**
 * A FILE ACT IS OFF THE PAGE.
 *
 * A read, a write and a listing of the Bot's own folder have nothing to do with whatever the
 * browser is showing. Until 2026-10-07 each was decided, bound and filed under the page the
 * browser happened to be parked on (`gateway/govern.ts` gave every act that is not a run the
 * last page it had seen): a rule about a site, written with no word about what is done there,
 * fired on a file read because of where the browser sat; a person's yes or No about a file
 * stopped holding when the browser moved; and the trail filed a read of `notes.md` under a
 * bank. Measured first with the browser parked on a bank and one rule about that site — the
 * Bot's own read asked, a run that named a file asked through its read, a run that named none
 * went through — which is the inconsistency the run was taken off the page to end, left in for
 * the files it reads.
 *
 * AN UPLOAD IS NOT ONE OF THEM. It names a file and it hands that file to the page: the one
 * call that takes something out of the folder and gives it to a website. What decides this is
 * what the act does (its intent), never whether it names a file.
 */

const BOT = "bot-1";
const COMPUTER = "default";
const ACTOR = { id: "dev-local-user" };
const OWNER = "owner-user";
/** With a query, as a page a form just landed on has: no row keeps one. */
const BANK = "https://www.kbstar.com/transfer?account=110-234";
const BANK_ON_A_ROW = "https://www.kbstar.com/transfer";
const ELSEWHERE = "https://example.com/news";

const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
/** A rule about the site alone, with no word about what is being done there. */
const ABOUT_THE_BANK = 'matches(page.host, "kbstar[.]com$")';
const ASKS_ABOUT_THE_BANK: ActionPolicy = {
  ...PERMISSIVE,
  ask: [ABOUT_THE_BANK],
};
const REFUSES_ON_THE_BANK: ActionPolicy = {
  ...PERMISSIVE,
  deny: [ABOUT_THE_BANK],
};
/** The two ways a rule about a site stops an act, and what a caller is stopped with by each. */
const SITE_RULES: [
  string,
  ActionPolicy,
  typeof ActionNeedsApprovalError | typeof ActionRefusedError,
][] = [
  ["asks", ASKS_ABOUT_THE_BANK, ActionNeedsApprovalError],
  ["refuses", REFUSES_ON_THE_BANK, ActionRefusedError],
];
const SCRIPT = 'console.log("the total is", 42);';

/** A gateway whose browser is parked on a page the server has looked at. */
async function parked(policy: ActionPolicy, url = BANK) {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  const computer = fakeComputer(
    { "uploads/a.csv": bytes("a,b\n1,2\n") },
    { url },
  );
  const approvals = createApprovalRegistry();
  const standing = createStandingApprovalStore();
  const bench = fakeWorkbench(() => made());
  const gateway = createComputerGateway({
    client: computer.client,
    auditStore: store,
    policy: () => policy,
    approvals,
    standing,
    workbench: bench.workbench,
  });
  await gateway.snapshot(COMPUTER);
  return { gateway, rows, computer, approvals, standing, sent: bench.sent };
}

/** What came of a call: that it went through, or what it was stopped with. */
const outcome = (attempt: Promise<unknown>) =>
  attempt.then(
    () => "went through" as const,
    (error: unknown) => error,
  );

const pressOn = (gateway: Awaited<ReturnType<typeof parked>>["gateway"]) =>
  outcome(gateway.click(COMPUTER, BOT, ACTOR, { ref: "e1", snapshotId: 1 }));

describe("a file act is off the page", () => {
  for (const [how, policy, stopped] of SITE_RULES) {
    test(`a rule that ${how} about a site decides a press there — and not a read, a write or a listing made while the browser is parked on it`, async () => {
      const { gateway, rows, computer } = await parked(policy);

      expect(await pressOn(gateway)).toBeInstanceOf(stopped);
      expect(
        await outcome(
          gateway.readFile(COMPUTER, BOT, ACTOR, { path: "uploads/a.csv" }),
        ),
      ).toBe("went through");
      expect(
        await outcome(
          gateway.writeFile(COMPUTER, BOT, ACTOR, {
            path: "notes/b.md",
            contents: "kept",
          }),
        ),
      ).toBe("went through");
      expect(
        await outcome(
          gateway.listFiles(COMPUTER, BOT, ACTOR, { path: "uploads" }),
        ),
      ).toBe("went through");
      expect(computer.asked).toEqual([
        "readFile uploads/a.csv",
        "writeFile notes/b.md",
        "listFiles uploads",
      ]);

      // The press is filed under the page it was made on — without its query, as every row
      // has a page. No file act is filed under any.
      expect(rows.map((row) => [row.payload.action, row.payload.page])).toEqual(
        [
          ["computer_click", BANK_ON_A_ROW],
          ["computer_read_file", ""],
          ["computer_write_file", ""],
          ["computer_list_files", ""],
        ],
      );
    });
  }

  /*
   * EVERY ROW A FILE ACT LEAVES. A decision that allowed it, one that refused it, a question
   * about it, a failure after it was allowed, and the row that says it came round again: each
   * is written from its own place in `govern`, and none names the page.
   */
  test("allowed, failed, refused, asked about and counted: no row a file act leaves is filed under the page the browser is on", async () => {
    const { gateway, rows } = await parked({
      deny: ['file.name == "payroll.csv"'],
      ask: ['file.name == "contract.md"'],
      allow: ["true"],
    });
    const read = (path: string) =>
      outcome(gateway.readFile(COMPUTER, BOT, ACTOR, { path }));

    for (let time = 1; time <= 3; time += 1) {
      expect(await read("uploads/a.csv")).toBe("went through");
    }
    expect((await read("uploads/gone.csv")) as Error).toHaveProperty(
      "message",
      "laf:file_not_found",
    );
    expect(await read("private/payroll.csv")).toBeInstanceOf(
      ActionRefusedError,
    );
    expect(await read("private/contract.md")).toBeInstanceOf(
      ActionNeedsApprovalError,
    );

    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
      "computer.action_allowed",
      "computer.action_repeated",
      "computer.action_allowed",
      "computer.action_allowed",
      "computer.action_failed",
      "computer.action_refused",
      "approval.requested",
    ]);
    // Blank where a row always has the field, and absent where it has it only when there is one.
    expect(rows.map((row) => row.payload.page ?? "")).toEqual(
      rows.map(() => ""),
    );
    expect(JSON.stringify(rows)).not.toContain("kbstar");
  });

  test("an upload is not one of them: it hands a file to the page, and a rule about the site still decides it", async () => {
    const { gateway, rows, computer } = await parked(ASKS_ABOUT_THE_BANK);

    const asked = await outcome(
      gateway.uploadFile(COMPUTER, BOT, ACTOR, {
        ref: "e1",
        snapshotId: 1,
        path: "uploads/a.csv",
      }),
    );

    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(computer.asked).toEqual([]);
    expect(
      rows.map((row) => [row.eventType, row.payload.action, row.payload.page]),
    ).toEqual([["approval.requested", "computer_upload_file", BANK_ON_A_ROW]]);
  });

  /*
   * WHAT AN ANSWER IS FOR. The page was part of what a yes and a No about a file were bound to
   * (`approvals.ts`, `fingerprintOf`), whole, query and all. A person answers minutes after the
   * Bot asked; a browser that had gone anywhere by then made the yes "a different action" —
   * asked again — and let a No be asked round.
   */
  test("a yes to a file read is for the file, wherever the browser has gone by the time it is spent", async () => {
    const { gateway, rows, computer, approvals } = await parked({
      ...PERMISSIVE,
      ask: ['intent == "read_file"'],
    });
    const read = (approvalId?: string) =>
      outcome(
        gateway.readFile(
          COMPUTER,
          BOT,
          ACTOR,
          { path: "uploads/a.csv" },
          approvalId,
        ),
      );
    const asked = (await read()) as ActionNeedsApprovalError;
    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);

    computer.moveTo(ELSEWHERE);
    await gateway.snapshot(COMPUTER);
    await approvals.answer(asked.approvalId, BOT, OWNER, true);

    expect(await read(asked.approvalId)).toBe("went through");
    expect(rows.at(-1)?.payload).toMatchObject({
      action: "computer_read_file",
      page: "",
      decision: { allowed: true, source: "ask", approvedBy: OWNER },
    });
  });

  test("a No to a file read stands for the file, wherever the browser goes next", async () => {
    const { gateway, computer, approvals } = await parked({
      ...PERMISSIVE,
      ask: ['intent == "read_file"'],
    });
    const read = () =>
      outcome(
        gateway.readFile(COMPUTER, BOT, ACTOR, { path: "uploads/a.csv" }),
      );
    const asked = (await read()) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, BOT, OWNER, false);

    computer.moveTo(ELSEWHERE);
    await gateway.snapshot(COMPUTER);

    const again = (await read()) as ActionRefusedError;
    expect(again).toBeInstanceOf(ActionRefusedError);
    expect(again.code).toBe("laf:declined_recently");
    expect(computer.asked).toEqual([]);
  });

  /*
   * A RUN WAS TAKEN OFF THE PAGE AND ITS READS WERE NOT. Under a rule about a site, a run that
   * named no file went through and a run that named one was asked about — as a question about
   * a file, filed under the bank. A file a run reads is read as the Bot's own read is, and now
   * neither is on a page.
   */
  for (const [how, policy] of SITE_RULES) {
    test(`under a rule that ${how} about a site, a file a run reads and the same file read by the Bot itself are decided alike: neither is stopped, and neither is filed under the site`, async () => {
      const { gateway, rows, sent } = await parked(policy);

      expect(
        await outcome(
          gateway.readFile(COMPUTER, BOT, ACTOR, { path: "uploads/a.csv" }),
        ),
      ).toBe("went through");
      expect(
        await outcome(
          gateway.runScript(COMPUTER, BOT, ACTOR, {
            script: SCRIPT,
            files: ["uploads/a.csv"],
          }),
        ),
      ).toBe("went through");

      expect(sent).toHaveLength(1);
      expect(
        rows
          .filter((row) => row.payload.action === "computer_read_file")
          .map((row) => [
            row.eventType,
            row.payload.page,
            row.payload.forScript ? "for the run" : "the Bot's own",
          ]),
      ).toEqual([
        ["computer.action_allowed", "", "the Bot's own"],
        ["computer.action_allowed", "", "for the run"],
      ]);
      expect(JSON.stringify(rows)).not.toContain("kbstar");
    });
  }

  /*
   * THE ONE ROW OF A RUN'S THAT NOTHING HELD. The row that says a call came round again is
   * written from its own place, and names a page for every call that names no file — which a
   * run is. A mutation that handed it the parked page passed every test there was.
   */
  test("the row that says a run came round again is filed under no page, wherever the browser is parked", async () => {
    const { gateway, rows } = await parked(PERMISSIVE);

    for (let time = 1; time <= 3; time += 1) {
      await gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: [],
      });
    }

    const again = rows.filter(
      (row) => row.eventType === "computer.action_repeated",
    );
    expect(again.map((row) => [row.payload.count, row.payload.page])).toEqual([
      [3, ""],
    ]);
    expect(JSON.stringify(rows)).not.toContain("kbstar");
  });

  /*
   * NO RULE A DEPLOYMENT STARTS WITH IS ABOUT A SITE ALONE. The one that reads `page.host` says
   * what is done there as well (`MONEY_HOST_RULE`: `intent == "activate"`;
   * `shared/policy-rules.ts`), so a file act on a money host was never asked about by it. Held
   * here, on main as it was and after: what changes for a deployment's own rule about a site
   * does not change what ships.
   */
  test("under the policy every deployment starts with, a press on a money host is asked about and a read, a write and a listing made there are not", async () => {
    expect(DEFAULT_ACTION_POLICY.ask).toContain(MONEY_HOST_RULE);
    expect(MONEY_HOST_RULE).toContain('intent == "activate"');
    const { gateway, computer } = await parked(DEFAULT_ACTION_POLICY);

    expect(await pressOn(gateway)).toBeInstanceOf(ActionNeedsApprovalError);
    expect(
      await outcome(
        gateway.readFile(COMPUTER, BOT, ACTOR, { path: "uploads/a.csv" }),
      ),
    ).toBe("went through");
    expect(
      await outcome(
        gateway.writeFile(COMPUTER, BOT, ACTOR, {
          path: "notes/b.md",
          contents: "kept",
        }),
      ),
    ).toBe("went through");
    expect(
      await outcome(
        gateway.listFiles(COMPUTER, BOT, ACTOR, { path: "uploads" }),
      ),
    ).toBe("went through");
    expect(computer.asked).toEqual([
      "readFile uploads/a.csv",
      "writeFile notes/b.md",
      "listFiles uploads",
    ]);
  });

  /*
   * AND "ALWAYS" FOR A FILE ACT IS NEVER FOR A SITE. An allowance's scope is the file, else the
   * host, else the tool (`standing-approvals.ts`, `allowanceFor`). A read that names a file is
   * the file's; one that names none fell through to the host — the bank the browser was parked
   * on, for a call that had nothing to do with it — and its card named that site.
   */
  test("a read that names no file, asked about with the browser parked on a bank: its card names no site, and always is for the tool — never for the bank", async () => {
    const { gateway, rows } = await parked({
      ...PERMISSIVE,
      ask: ['intent == "read_file"'],
    });

    const asked = (await outcome(
      gateway.readFile(COMPUTER, BOT, ACTOR, { path: "" }),
    )) as ActionNeedsApprovalError;

    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(asked.scope).toEqual({ kind: "tool", value: "computer_read_file" });
    expect(JSON.stringify(asked.subject)).not.toContain("kbstar");
    expect(JSON.stringify(rows)).not.toContain("kbstar");
  });
});
