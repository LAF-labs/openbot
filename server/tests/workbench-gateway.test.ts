import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPEAT_RULE } from "../../shared/policy-rules";
import { WORKBENCH_LIMITS } from "../../shared/workbench/protocol";
import type { AuditEventInput, AuditFactCode, AuditStore } from "../src/audit";
import {
  createApprovalRegistry,
  fingerprintOf,
} from "../src/computer/approvals";
import { DEFAULT_ACTION_POLICY } from "../src/computer/default-policy";
import { ComputerUnavailableError } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import { RUN_SCRIPT_TOOL } from "../src/computer/gateway/intent";
import {
  MADE_MAX_BYTES,
  ScriptNotRunError,
} from "../src/computer/gateway/script-run";
import type { ActionPolicy } from "../src/computer/policy";
import { fingerprintOf as countedAs } from "../src/computer/repeat";
import {
  allowanceFor,
  createStandingApprovalStore,
  scopeKeyOf,
} from "../src/computer/standing-approvals";
import { callFingerprintOf } from "../src/plugins/call";
import {
  customServerNameRefusal,
  SERVER_NAME_TAKEN,
} from "../src/plugins/servers";
import { toolNameFor } from "../src/plugins/store";
import { outcomeOfError } from "../src/runner/unattended";
import type { WorkbenchAnswer } from "../src/workbench/client";
import {
  bytes,
  ENDED,
  fakeComputer,
  fakeWorkbench,
  made,
  realComputer,
} from "./support/script-run";

/**
 * A SCRIPT'S RUN AS AN ACT OF THE GATEWAY, with a recording stand-in for the place a script runs
 * and for the Bot's computer. Offered to no Bot: nothing but these tests and the rehearsal calls
 * `runScript`.
 *
 * What is held here is the order and the boundary, none of it visible from a green typecheck:
 *  - nothing is sent to the sandbox before the decision's row is written, and nothing at all when
 *    the decision is no or not yet;
 *  - every file a script is handed and every file it makes is its own decision, with its own row,
 *    under the rules a Bot's own read and write are under;
 *  - a run has no page, whatever the browser is showing;
 *  - an answer is for one script over one list of files;
 *  - no row holds a line of a script, a character it printed or a byte of a file.
 *
 * The walls of the place itself are not here and cannot be: they are the container's, and are
 * measured where it is real (`scripts/workbench-probe.ts`).
 */

const BOT = "bot-1";
const COMPUTER = "default";
const ACTOR = { id: "dev-local-user" };
const MANAGER = { id: "manager-user", userId: "manager-user" };
const AT = new Date("2026-10-07T03:04:05.000Z");

const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
const asking = (...ask: string[]): ActionPolicy => ({ ...PERMISSIVE, ask });
const denying = (...deny: string[]): ActionPolicy => ({ ...PERMISSIVE, deny });

const SCRIPT = 'console.log("the total is", 42);';
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
/**
 * The folder a call's files go to, worked out here and not asked of the code: the day, and eight
 * characters of a digest over the Bot, the conversation, the call's id, the script's digest and
 * the files it names in one order.
 */
const folderOf = (call: {
  toolCallId: string;
  script?: string;
  files?: string[];
  threadId?: string;
}) =>
  `made/2026-10-07-${createHash("sha256")
    .update(
      [
        BOT,
        call.threadId ?? "",
        call.toolCallId,
        sha256(call.script ?? SCRIPT),
        ...[...(call.files ?? [])].sort(),
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 8)}`;

function fakeAudit(refuses: (event: AuditEventInput) => boolean = () => false) {
  const rows: AuditEventInput[] = [];
  const store: AuditStore = {
    insert: async (event) => {
      if (refuses(event)) throw new Error("the trail is not taking rows");
      rows.push(event);
    },
  };
  return { store, rows };
}

/** What a row is, in the two words a reader of the trail goes by. */
const said = (rows: AuditEventInput[]) =>
  rows.map((row) => `${row.eventType} ${String(row.payload.action ?? "")}`);

function stack(
  options: {
    policy?: ActionPolicy | (() => ActionPolicy);
    folder?: Record<string, Uint8Array>;
    computer?: Parameters<typeof fakeComputer>[1];
    answer?: Parameters<typeof fakeWorkbench>[0];
    /** False is a deployment with nowhere to run a script. */
    workbench?: false;
    refuses?: (event: AuditEventInput) => boolean;
  } = {},
) {
  const computer = fakeComputer(options.folder, options.computer);
  const bench = fakeWorkbench(options.answer);
  const audit = fakeAudit(options.refuses);
  const approvals = createApprovalRegistry();
  const standing = createStandingApprovalStore();
  const policy = options.policy ?? PERMISSIVE;
  const gateway = createComputerGateway({
    client: computer.client,
    auditStore: audit.store,
    policy: typeof policy === "function" ? policy : () => policy,
    approvals,
    standing,
    now: () => AT,
    ...(options.workbench === false ? {} : { workbench: bench.workbench }),
  });
  return {
    gateway,
    approvals,
    standing,
    rows: audit.rows,
    sent: bench.sent,
    computer,
  };
}

const failure = async (attempt: Promise<unknown>) =>
  attempt.then(
    () => {
      throw new Error("it went through");
    },
    (error: unknown) => error,
  );

describe("a script's run, allowed", () => {
  test("reads each named file, runs, says how it ended, and files what it made — in that order", async () => {
    const { gateway, rows, sent, computer } = stack({
      folder: {
        "uploads/sales.csv": bytes("day,amount\nmon,40\ntue,2\n"),
        "uploads/costs.csv": bytes("day,amount\nmon,1\n"),
      },
      answer: () => made(["by-day.csv", "day,total\nmon,39\n"]),
    });

    const run = await gateway.runScript(
      COMPUTER,
      BOT,
      { ...ACTOR, toolCallId: "call-1" },
      {
        script: SCRIPT,
        files: ["uploads/sales.csv", "uploads/costs.csv"],
        timeoutMs: 30_000,
      },
    );

    const folder = folderOf({
      toolCallId: "call-1",
      files: ["uploads/sales.csv", "uploads/costs.csv"],
    });
    // The sandbox got the script as written and each file's bytes at the path the Bot knows it by.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.script).toBe(SCRIPT);
    expect(sent[0]?.timeoutMs).toBe(30_000);
    expect(
      sent[0]?.files.map((file) => [
        file.path,
        new TextDecoder().decode(file.bytes),
      ]),
    ).toEqual([
      ["uploads/sales.csv", "day,amount\nmon,40\ntue,2\n"],
      ["uploads/costs.csv", "day,amount\nmon,1\n"],
    ]);
    // What the caller is handed: how it ended, what it printed, and where its file is.
    expect(run).toEqual({
      sha256: sha256(SCRIPT),
      ending: "exited",
      exitCode: 0,
      signal: null,
      ms: 412,
      stdout: "the total is 42\n",
      stderr: "",
      stdoutBytes: 16,
      stderrBytes: 0,
      skipped: 0,
      products: [
        { name: "by-day.csv", bytes: 17, path: `${folder}/by-day.csv` },
      ],
    });
    expect(
      new TextDecoder().decode(computer.files.get(`${folder}/by-day.csv`)),
    ).toBe("day,total\nmon,39\n");

    // The trail, in the order things happened: each read, the run, its ending, each file.
    expect(said(rows)).toEqual([
      "computer.action_allowed computer_read_file",
      "computer.action_allowed computer_read_file",
      `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
      `computer.script_finished ${RUN_SCRIPT_TOOL}`,
      "computer.action_allowed computer_write_file",
    ]);
    expect(rows.map((row) => row.payload.file ?? null)).toEqual([
      "uploads/sales.csv",
      "uploads/costs.csv",
      null,
      null,
      `${folder}/by-day.csv`,
    ]);
    // And every one of them names the run it belongs to, by the script's digest: the files it
    // read and the file it made as `forScript`, its own two rows as `script`.
    expect(
      rows.map(
        (row) =>
          row.payload.forScript ??
          (row.payload.script as { sha256?: string } | undefined)?.sha256,
      ),
    ).toEqual(Array.from({ length: 5 }, () => sha256(SCRIPT)));
    expect(rows.map((row) => "forScript" in row.payload)).toEqual([
      true,
      true,
      false,
      false,
      true,
    ]);
    // And the computer, in the same order — each call under the asking Bot's own name.
    expect(computer.asked).toEqual([
      "fileBytes uploads/sales.csv",
      "fileBytes uploads/costs.csv",
      "listFiles made",
      `putFile ${folder}/by-day.csv`,
    ]);
    expect(new Set(computer.addressedAs)).toEqual(new Set([BOT]));
  });

  test("the decision's row carries the script's digest and length and the files it names, and no page", async () => {
    const { gateway, rows } = stack({
      folder: { "uploads/a.csv": bytes("1") },
      computer: { url: "https://www.kbstar.com/transfer?account=1" },
    });
    // The browser is parked on a bank, and the server has seen it there.
    await gateway.snapshot(COMPUTER);

    await gateway.runScript(COMPUTER, BOT, MANAGER, {
      script: SCRIPT,
      files: ["uploads/a.csv"],
    });

    const decided = rows.find(
      (row) =>
        row.eventType === "computer.action_allowed" &&
        row.payload.action === RUN_SCRIPT_TOOL,
    );
    expect(decided?.targetType).toBe("computer");
    expect(decided?.targetId).toBe(COMPUTER);
    expect(decided?.actorUserId).toBe(MANAGER.userId);
    expect(decided?.payload).toEqual({
      action: RUN_SCRIPT_TOOL,
      bot: BOT,
      actor: MANAGER.id,
      page: "",
      ref: null,
      script: { sha256: sha256(SCRIPT), bytes: Buffer.byteLength(SCRIPT) },
      files: ["uploads/a.csv"],
      decision: {
        allowed: true,
        source: "allow",
        rule: "true",
        carriedOut: true,
      },
    });
  });

  test("the ending's row says how it ended and what it made, by count, name and size", async () => {
    const { gateway, rows } = stack({
      answer: () => ({
        ok: true,
        run: { ...ENDED, stderr: "a warning\n", stderrBytes: 10, skipped: 2 },
        products: [
          { name: "요일별 매출.xlsx", bytes: bytes("workbook") },
          { name: "notes.txt", bytes: bytes("n") },
        ],
      }),
    });

    await gateway.runScript(COMPUTER, BOT, MANAGER, {
      script: SCRIPT,
      files: [],
    });

    const ended = rows.find(
      (row) => row.eventType === "computer.script_finished",
    );
    expect(ended?.targetType).toBe("computer");
    expect(ended?.targetId).toBe(COMPUTER);
    expect(ended?.actorUserId).toBe(MANAGER.userId);
    expect(ended?.payload).toEqual({
      action: RUN_SCRIPT_TOOL,
      bot: BOT,
      actor: MANAGER.id,
      script: { sha256: sha256(SCRIPT), bytes: Buffer.byteLength(SCRIPT) },
      ending: "exited",
      exit: 0,
      signal: null,
      ms: 412,
      stdoutBytes: 16,
      stderrBytes: 10,
      products: [
        { name: "요일별 매출.xlsx", bytes: 8 },
        { name: "notes.txt", bytes: 1 },
      ],
      skipped: 2,
    });
  });

  test("a script that ended badly is an ending, not a failure of the act: said, and nothing filed", async () => {
    for (const run of [
      { ...ENDED, exitCode: 1, stderr: "TypeError: x\n", stderrBytes: 13 },
      {
        ...ENDED,
        ending: "timed_out" as const,
        exitCode: null,
        signal: "SIGKILL",
      },
      {
        ...ENDED,
        ending: "out_of_memory" as const,
        exitCode: null,
        signal: "SIGKILL",
      },
      { ...ENDED, productsRefused: "too_large_together" as const },
    ]) {
      const { gateway, rows, computer } = stack({
        answer: () => ({ ok: true, run, products: [] }),
      });
      const ended = await gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: [],
      });
      expect(ended.ending).toBe(run.ending);
      expect(ended.exitCode).toBe(run.exitCode);
      expect(ended.products).toEqual([]);
      expect(said(rows)).toEqual([
        `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
        `computer.script_finished ${RUN_SCRIPT_TOOL}`,
      ]);
      const row = rows[1]?.payload;
      expect([row?.ending, row?.exit, row?.signal]).toEqual([
        run.ending,
        run.exitCode,
        run.signal,
      ]);
      expect(row?.productsRefused).toBe(
        "productsRefused" in run ? run.productsRefused : undefined,
      );
      expect(computer.asked).toEqual([]);
    }
  });
});

describe("a script's run, before anything is decided", () => {
  test("a deployment with nowhere to run one refuses at once: nothing read, nothing recorded", async () => {
    const { gateway, rows, computer } = stack({
      workbench: false,
      folder: { "uploads/a.csv": bytes("1") },
    });

    const error = await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ["uploads/a.csv"],
      }),
    );

    expect(error).toBeInstanceOf(ScriptNotRunError);
    expect((error as ScriptNotRunError).message).toBe(
      "laf:workbench_unavailable",
    );
    expect(rows).toEqual([]);
    expect(computer.asked).toEqual([]);
    // Not even addressed: no call was made of the computer, as this Bot or as any.
    expect(computer.addressedAs).toEqual([]);
  });

  test("a run for something that is not a Bot's id is refused first: no row names it, and nothing runs", async () => {
    for (const botId of ["", "../../etc", "bot one", "봇"]) {
      // No file and no product: the one run that would never have reached the computer's own check.
      const { gateway, rows, sent, computer } = stack();
      const error = await failure(
        gateway.runScript(COMPUTER, botId, ACTOR, {
          script: SCRIPT,
          files: [],
        }),
      );
      expect({ botId, said: (error as Error).message }).toEqual({
        botId,
        said: "laf:bot_id_invalid",
      });
      expect(rows).toEqual([]);
      expect(sent).toEqual([]);
      expect(computer.addressedAs).toEqual([]);
    }
  });

  test("a request that could only be refused costs no read, opens no question and leaves no row", async () => {
    const tooLong = "x".repeat(WORKBENCH_LIMITS.scriptBytes + 1);
    const wrong: [
      string,
      object,
      AuditFactCode,
      Record<string, string | number>,
    ][] = [
      [
        "a script over its bound",
        { script: tooLong, files: [] },
        "laf:script_too_large",
        { bytes: tooLong.length, limit: WORKBENCH_LIMITS.scriptBytes },
      ],
      [
        "no script",
        { script: "", files: [] },
        "laf:script_inputs_invalid",
        { field: "script" },
      ],
      [
        "something that is not a script",
        { script: 7, files: [] },
        "laf:script_inputs_invalid",
        { field: "script" },
      ],
      [
        "more files than a run takes",
        {
          script: SCRIPT,
          files: Array.from(
            { length: WORKBENCH_LIMITS.files + 1 },
            (_, index) => `uploads/${index}.csv`,
          ),
        },
        "laf:script_inputs_invalid",
        { field: "files" },
      ],
      [
        "a path that leaves the folder",
        { script: SCRIPT, files: ["uploads/../../etc/passwd"] },
        "laf:script_inputs_invalid",
        { field: "files" },
      ],
      [
        "an absolute path",
        { script: SCRIPT, files: ["/etc/passwd"] },
        "laf:script_inputs_invalid",
        { field: "files" },
      ],
      [
        "one file named twice",
        { script: SCRIPT, files: ["uploads/a.csv", "uploads/a.csv"] },
        "laf:script_inputs_invalid",
        { field: "files" },
      ],
      [
        "files that are not a list",
        { script: SCRIPT, files: "uploads/a.csv" },
        "laf:script_inputs_invalid",
        { field: "files" },
      ],
      [
        "more time than a run may ask for",
        {
          script: SCRIPT,
          files: [],
          timeoutMs: WORKBENCH_LIMITS.timeoutCeilingMs + 1,
        },
        "laf:script_inputs_invalid",
        { field: "timeoutMs" },
      ],
    ];
    for (const [what, input, code, facts] of wrong) {
      // A rule that asks about everything: a question opened for any of these would show here.
      const { gateway, rows, sent, computer, approvals } = stack({
        policy: asking("true"),
        folder: { "uploads/a.csv": bytes("1") },
      });
      const error = (await failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, input as never),
      )) as ScriptNotRunError;
      expect({ what, error: error.constructor.name }).toEqual({
        what,
        error: "ScriptNotRunError",
      });
      expect({ what, code: error.code }).toEqual({ what, code });
      expect({ what, facts: error.facts }).toEqual({ what, facts });
      expect(rows).toEqual([]);
      expect(sent).toEqual([]);
      expect(computer.asked).toEqual([]);
      expect(await approvals.pending(BOT)).toEqual([]);
    }
  });

  test("files too large together are found as they are read, and the next is not read", async () => {
    const third = Math.ceil(WORKBENCH_LIMITS.filesBytes / 3) + 1;
    const { gateway, rows, sent, computer } = stack({
      folder: {
        "uploads/1.bin": new Uint8Array(third),
        "uploads/2.bin": new Uint8Array(third),
        "uploads/3.bin": new Uint8Array(third),
        "uploads/4.bin": new Uint8Array(1),
      },
    });

    const error = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: [
          "uploads/1.bin",
          "uploads/2.bin",
          "uploads/3.bin",
          "uploads/4.bin",
        ],
      }),
    )) as ScriptNotRunError;

    expect(error.code).toBe("laf:script_inputs_invalid");
    expect(error.facts).toEqual({
      field: "files",
      limit: WORKBENCH_LIMITS.filesBytes,
    });
    expect(sent).toEqual([]);
    expect(computer.asked).toEqual([
      "fileBytes uploads/1.bin",
      "fileBytes uploads/2.bin",
      "fileBytes uploads/3.bin",
    ]);
    // The reads that happened are on the trail; nothing was decided about a run.
    expect(said(rows)).toEqual([
      "computer.action_allowed computer_read_file",
      "computer.action_allowed computer_read_file",
      "computer.action_allowed computer_read_file",
    ]);
  });
});

describe("a script's run and the trail it goes through", () => {
  test("a trail that will not take the decision sends nothing to the sandbox", async () => {
    const { gateway, sent, rows } = stack({
      folder: { "uploads/a.csv": bytes("1") },
      refuses: (event) => event.payload.action === RUN_SCRIPT_TOOL,
    });

    await expect(
      gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ["uploads/a.csv"],
      }),
    ).rejects.toThrow("the trail is not taking rows");

    expect(sent).toEqual([]);
    expect(said(rows)).toEqual(["computer.action_allowed computer_read_file"]);
  });

  test("a trail that takes nothing at all reads nothing either", async () => {
    const { gateway, sent, computer } = stack({
      folder: { "uploads/a.csv": bytes("1") },
      refuses: () => true,
    });

    await expect(
      gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ["uploads/a.csv"],
      }),
    ).rejects.toThrow("the trail is not taking rows");

    expect(sent).toEqual([]);
    expect(computer.asked).toEqual([]);
  });

  test("a trail that will not take the ending files nothing, and the call fails", async () => {
    const { gateway, sent, computer } = stack({
      answer: () => made(["out.csv", "1"]),
      refuses: (event) => event.eventType === "computer.script_finished",
    });

    await expect(
      gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
    ).rejects.toThrow("the trail is not taking rows");

    // It ran — and what it made is dropped, because nothing would say where it came from.
    expect(sent).toHaveLength(1);
    expect(computer.asked).toEqual([]);
    expect([...computer.files.keys()]).toEqual([]);
  });

  test("a trail that will not take a file's decision ends the call rather than calling it the computer's refusal", async () => {
    const { gateway, computer } = stack({
      answer: () => made(["one.csv", "1"], ["two.csv", "2"]),
      refuses: (event) =>
        event.payload.action === "computer_write_file" &&
        String(event.payload.file).endsWith("two.csv"),
    });

    await expect(
      gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
    ).rejects.toThrow("the trail is not taking rows");

    expect([...computer.files.keys()].map((path) => path.slice(-7))).toEqual([
      "one.csv",
    ]);
  });

  /*
   * THE METHOD CLAUDE.md PRESCRIBES for what must never be recorded: put a different sentinel in
   * each place content lives, serialise everything that was written, and look for each.
   */
  test("no row holds a line of the script, a character it printed, or a byte of a file it read or made", async () => {
    const inScript = "SENTINEL-IN-THE-SCRIPT-7d1f";
    const inStdout = "SENTINEL-IN-STDOUT-2c9a";
    const inStderr = "SENTINEL-IN-STDERR-5b3e";
    const inInput = "SENTINEL-IN-AN-INPUT-91aa";
    const inProduct = "SENTINEL-IN-A-PRODUCT-e04c";
    const script = `console.log(${JSON.stringify(inScript)});`;
    const policy = asking(
      'intent == "run_script"',
      'intent == "write_file" && file.extension == "txt"',
    );
    const { gateway, rows, approvals, standing } = stack({
      policy,
      folder: { "uploads/in.csv": bytes(`a,b\n${inInput},1\n`) },
      answer: () => ({
        ok: true,
        run: {
          ...ENDED,
          stdout: `${inStdout}\n`,
          stderr: `${inStderr}\n`,
          stdoutBytes: inStdout.length + 1,
          stderrBytes: inStderr.length + 1,
        },
        products: [
          { name: "out.csv", bytes: bytes(`${inProduct}\n`) },
          { name: "asked.txt", bytes: bytes(`${inProduct}\n`) },
        ],
      }),
    });
    const actor = { ...MANAGER, threadId: "thread-1", toolCallId: "call-7" };
    const input = { script, files: ["uploads/in.csv"] };

    // A question about the run, answered for good; then the run, and a question about a file.
    const asked = (await failure(
      gateway.runScript(COMPUTER, BOT, actor, input),
    )) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, BOT, MANAGER.id, true);
    await standing.grant({
      botId: BOT,
      rule: asked.rule,
      scope: asked.scope ?? { kind: "tool", value: RUN_SCRIPT_TOOL },
      subject: asked.subject,
      grantedBy: MANAGER.id,
    });
    const paused = (await failure(
      gateway.runScript(
        COMPUTER,
        BOT,
        actor,
        input,
        undefined,
        asked.approvalId,
      ),
    )) as ActionNeedsApprovalError;
    expect(paused).toBeInstanceOf(ActionNeedsApprovalError);

    const written = JSON.stringify({
      rows,
      questions: [asked.subject, paused.subject],
      pending: await approvals.pending(BOT),
      allowances: await standing.list(BOT),
    });
    for (const sentinel of [inScript, inStdout, inStderr, inInput, inProduct]) {
      expect({ sentinel, found: written.includes(sentinel) }).toEqual({
        sentinel,
        found: false,
      });
    }
    // Every kind of row a run can leave was among them, so this looked at each.
    expect(new Set(said(rows))).toEqual(
      new Set([
        "computer.action_allowed computer_read_file",
        `approval.requested ${RUN_SCRIPT_TOOL}`,
        `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
        `computer.script_finished ${RUN_SCRIPT_TOOL}`,
        "computer.action_allowed computer_write_file",
        "approval.requested computer_write_file",
      ]),
    );
    // And what a row does hold of a run is there: which script, how long, how it ended, what it made.
    const ended = rows.find(
      (row) => row.eventType === "computer.script_finished",
    )?.payload;
    expect(ended?.script).toEqual({
      sha256: sha256(script),
      bytes: Buffer.byteLength(script),
    });
    expect(ended?.exit).toBe(0);
    expect(ended?.ms).toBe(412);
    expect(ended?.stdoutBytes).toBe(inStdout.length + 1);
    expect(ended?.stderrBytes).toBe(inStderr.length + 1);
    expect(ended?.products).toEqual([
      { name: "out.csv", bytes: inProduct.length + 1 },
      { name: "asked.txt", bytes: inProduct.length + 1 },
    ]);
    // The question about the run names its files, and its row the script by its digest.
    expect(asked.subject).toEqual({
      kind: "file",
      intent: "run_script",
      files: [{ path: "uploads/in.csv" }],
      reason: "policy_ask",
    });
    const question = rows.find(
      (row) =>
        row.eventType === "approval.requested" &&
        row.payload.action === RUN_SCRIPT_TOOL,
    )?.payload;
    expect(question?.script).toEqual({
      sha256: sha256(script),
      bytes: Buffer.byteLength(script),
    });
    expect(question?.page).toBeUndefined();
  });
});

describe("a script's run and the policy", () => {
  test("a deny refuses it: nothing sent, and a refused row that names the script by its digest", async () => {
    for (const rule of [
      'intent == "run_script"',
      `tool.name == "${RUN_SCRIPT_TOOL}"`,
    ]) {
      const { gateway, rows, sent } = stack({ policy: denying(rule) });

      const error = (await failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
      )) as ActionRefusedError;

      expect(error).toBeInstanceOf(ActionRefusedError);
      expect(error.code).toBe("laf:policy_denied");
      expect(error.rule).toBe(rule);
      expect(sent).toEqual([]);
      expect(said(rows)).toEqual([
        `computer.action_refused ${RUN_SCRIPT_TOOL}`,
      ]);
      expect(rows[0]?.payload.script).toEqual({
        sha256: sha256(SCRIPT),
        bytes: Buffer.byteLength(SCRIPT),
      });
    }
  });

  test("a policy that allows nothing refuses it as nothing allowing it", async () => {
    const { gateway, sent } = stack({
      policy: { deny: [], ask: [], allow: ['intent == "read"'] },
    });
    const error = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
    )) as ActionRefusedError;
    expect(error.code).toBe("laf:no_rule_allows");
    expect(sent).toEqual([]);
  });

  test("an ask sends nothing until an answer is presented, and the answer is for that script over those files", async () => {
    const { gateway, approvals, rows, sent } = stack({
      policy: asking('intent == "run_script"'),
      folder: {
        "uploads/a.csv": bytes("1"),
        "uploads/b.csv": bytes("2"),
        "uploads/c.csv": bytes("3"),
      },
    });
    const A = { script: SCRIPT, files: ["uploads/a.csv", "uploads/b.csv"] };
    const attempt = (input: typeof A, approvalId?: string) =>
      failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, input, undefined, approvalId),
      );

    const asked = (await attempt(A)) as ActionNeedsApprovalError;
    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(asked.subject).toEqual({
      kind: "file",
      intent: "run_script",
      files: [{ path: "uploads/a.csv" }, { path: "uploads/b.csv" }],
      reason: "policy_ask",
    });
    expect(sent).toEqual([]);
    expect(rows.at(-1)?.eventType).toBe("approval.requested");

    // Unanswered, it is still a question.
    expect(await attempt(A, asked.approvalId)).toBeInstanceOf(
      ActionNeedsApprovalError,
    );
    await approvals.answer(asked.approvalId, BOT, MANAGER.id, true);

    // Another script: not what was agreed to.
    expect(
      await attempt({ ...A, script: `${SCRIPT} ` }, asked.approvalId),
    ).toBeInstanceOf(ActionNeedsApprovalError);
    // The same script handed another list of files: not what was agreed to either.
    expect(
      await attempt(
        { ...A, files: ["uploads/a.csv", "uploads/c.csv"] },
        asked.approvalId,
      ),
    ).toBeInstanceOf(ActionNeedsApprovalError);
    expect(
      await attempt({ ...A, files: ["uploads/a.csv"] }, asked.approvalId),
    ).toBeInstanceOf(ActionNeedsApprovalError);
    expect(sent).toEqual([]);

    // The script and the files that were agreed to, in whatever order the files are written.
    const ran = await gateway.runScript(
      COMPUTER,
      BOT,
      ACTOR,
      { ...A, files: ["uploads/b.csv", "uploads/a.csv"] },
      undefined,
      asked.approvalId,
    );
    expect(ran.ending).toBe("exited");
    expect(sent).toHaveLength(1);
    const allowed = rows.find(
      (row) =>
        row.eventType === "computer.action_allowed" &&
        row.payload.action === RUN_SCRIPT_TOOL,
    );
    expect(allowed?.payload.decision).toMatchObject({
      source: "ask",
      approvedBy: MANAGER.id,
    });

    // Once: the same answer does not run it a second time.
    expect(await attempt(A, asked.approvalId)).toBeInstanceOf(
      ActionNeedsApprovalError,
    );
    expect(sent).toHaveLength(1);
  });

  test("a person's No stands for that script, and another script is still a question", async () => {
    const { gateway, approvals, sent } = stack({
      policy: asking('intent == "run_script"'),
    });
    const asked = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
    )) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, BOT, MANAGER.id, false);

    const again = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
    )) as ActionRefusedError;
    expect(again).toBeInstanceOf(ActionRefusedError);
    expect(again.code).toBe("laf:declined_recently");
    expect(
      await failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, {
          script: "console.log(2)",
          files: [],
        }),
      ),
    ).toBeInstanceOf(ActionNeedsApprovalError);
    expect(sent).toEqual([]);
  });

  test("with the browser parked on a bank, a rule about that site does not fire on a run, and always is for the tool", async () => {
    const parked = { url: "https://www.kbstar.com/transfer" };
    // A rule about the site alone, with no word about what is being done there.
    const bySite = stack({
      policy: asking('matches(page.host, "kbstar[.]com$")'),
      computer: parked,
    });
    await bySite.gateway.snapshot(COMPUTER);
    // The rule does fire where the page is what is acted on …
    expect(
      await failure(
        bySite.gateway.click(COMPUTER, BOT, ACTOR, {
          ref: "e1",
          snapshotId: 1,
        }),
      ),
    ).toBeInstanceOf(ActionNeedsApprovalError);
    // … and not on a run, which has no page.
    await bySite.gateway.runScript(COMPUTER, BOT, ACTOR, {
      script: SCRIPT,
      files: [],
    });
    expect(bySite.sent).toHaveLength(1);
    expect(bySite.rows.at(-2)?.payload.page).toBe("");

    // Asked about as a run, what "always" would cover is the tool — never the site it sat on.
    const asked = stack({
      policy: asking('intent == "run_script"'),
      computer: parked,
    });
    await asked.gateway.snapshot(COMPUTER);
    const question = (await failure(
      asked.gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: [],
      }),
    )) as ActionNeedsApprovalError;
    expect(question.scope).toEqual({ kind: "tool", value: RUN_SCRIPT_TOOL });
    expect(question.subject.host).toBeUndefined();
    expect(JSON.stringify(asked.rows)).not.toContain("kbstar");
  });

  test("an answer about a run is still good when the browser has moved meanwhile", async () => {
    const { gateway, approvals, sent, computer } = stack({
      policy: asking('intent == "run_script"'),
      computer: { url: "https://example.com/one" },
    });
    await gateway.snapshot(COMPUTER);
    const asked = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
    )) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, BOT, MANAGER.id, true);
    // The page under the server's cache changes: a person drove, a routine navigated.
    computer.moveTo("https://example.org/two");
    await gateway.snapshot(COMPUTER);

    await gateway.runScript(
      COMPUTER,
      BOT,
      ACTOR,
      { script: SCRIPT, files: [] },
      undefined,
      asked.approvalId,
    );
    expect(sent).toHaveLength(1);
  });

  test("with no look at the screen ever taken, a run is decided — not refused as blind", async () => {
    // A policy that does decide on the screen: a press with no snapshot behind it is refused.
    const { gateway, sent } = stack({
      policy: denying('contains(element.name, "submit")'),
    });
    const blind = (await failure(
      gateway.click(COMPUTER, BOT, ACTOR, { ref: "e1", snapshotId: 1 }),
    )) as ActionRefusedError;
    expect(blind.code).toBe("laf:blind_action");

    await gateway.runScript(COMPUTER, BOT, ACTOR, {
      script: SCRIPT,
      files: [],
    });
    expect(sent).toHaveLength(1);
  });

  test("a rule denying one file's path means the script never starts", async () => {
    const { gateway, rows, sent, computer } = stack({
      policy: denying('file.path == "uploads/payroll.csv"'),
      folder: {
        "uploads/sales.csv": bytes("1"),
        "uploads/payroll.csv": bytes("2"),
      },
    });

    const error = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ["uploads/sales.csv", "uploads/payroll.csv"],
      }),
    )) as ActionRefusedError;

    expect(error).toBeInstanceOf(ActionRefusedError);
    expect(error.code).toBe("laf:policy_denied");
    expect(sent).toEqual([]);
    // The denied file was never read; the one before it was, and its row stands.
    expect(computer.asked).toEqual(["fileBytes uploads/sales.csv"]);
    expect(said(rows)).toEqual([
      "computer.action_allowed computer_read_file",
      "computer.action_refused computer_read_file",
    ]);
    expect(rows[1]?.payload.file).toBe("uploads/payroll.csv");
  });

  test("a question about one file ends the call before any code runs", async () => {
    const { gateway, sent, computer } = stack({
      policy: asking('intent == "read_file" && file.extension == "xlsx"'),
      folder: { "uploads/book.xlsx": bytes("1") },
    });

    const asked = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ["uploads/book.xlsx"],
      }),
    )) as ActionNeedsApprovalError;

    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    // The question is the one a Bot's own read of that file would be.
    expect(asked.subject).toEqual({
      kind: "file",
      intent: "read_file",
      file: { path: "uploads/book.xlsx" },
      reason: "policy_ask",
    });
    expect(sent).toEqual([]);
    expect(computer.asked).toEqual([]);
  });

  test("an answer given for the run is not spent on a file's read, and stays good for the run", async () => {
    let policy = asking('intent == "run_script"');
    const { gateway, approvals, sent } = stack({
      policy: () => policy,
      folder: { "uploads/a.csv": bytes("1") },
    });
    const input = { script: SCRIPT, files: ["uploads/a.csv"] };
    const aboutTheRun = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, input),
    )) as ActionNeedsApprovalError;
    await approvals.answer(aboutTheRun.approvalId, BOT, MANAGER.id, true);

    // The deployment now asks about the read as well. The run's answer is presented to it first.
    policy = asking('intent == "run_script"', 'intent == "read_file"');
    const aboutTheRead = (await failure(
      gateway.runScript(
        COMPUTER,
        BOT,
        ACTOR,
        input,
        undefined,
        aboutTheRun.approvalId,
      ),
    )) as ActionNeedsApprovalError;
    expect(aboutTheRead.subject.intent).toBe("read_file");
    expect(aboutTheRead.approvalId).not.toBe(aboutTheRun.approvalId);
    expect(sent).toEqual([]);

    // Not burned on the way past: with the read no longer asked about, the run spends its answer.
    policy = asking('intent == "run_script"');
    await gateway.runScript(
      COMPUTER,
      BOT,
      ACTOR,
      input,
      undefined,
      aboutTheRun.approvalId,
    );
    expect(sent).toHaveLength(1);
  });

  /*
   * ONE ANSWER A CALL, WHICH IS WHAT THE FLAT ORDER COSTS (`acts.ts`, `runScript`). Held here as
   * what happens, so that it is decided on and not discovered: a deployment that asks about a
   * file's read AND about the run cannot be got through on "this once" alone.
   */
  test("a call that meets two questions spends one answer an attempt, and gets through only when one answer is for longer", async () => {
    const rule = 'intent == "read_file"';
    const { gateway, approvals, standing, sent } = stack({
      policy: asking(rule, 'intent == "run_script"'),
      folder: { "uploads/a.csv": bytes("1") },
    });
    const input = { script: SCRIPT, files: ["uploads/a.csv"] };
    const attempt = (approvalId?: string) =>
      failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, input, undefined, approvalId),
      ) as Promise<ActionNeedsApprovalError>;

    const aboutTheRead = await attempt();
    expect(aboutTheRead.subject.intent).toBe("read_file");
    await approvals.answer(aboutTheRead.approvalId, BOT, MANAGER.id, true);
    // With that answer the read goes through, and the run is the second question.
    const aboutTheRun = await attempt(aboutTheRead.approvalId);
    expect(aboutTheRun.subject.intent).toBe("run_script");
    await approvals.answer(aboutTheRun.approvalId, BOT, MANAGER.id, true);
    // With the run's answer, the read — whose own answer was spent — is asked about again.
    const again = await attempt(aboutTheRun.approvalId);
    expect(again.subject.intent).toBe("read_file");
    expect(again.approvalId).not.toBe(aboutTheRead.approvalId);
    expect(sent).toEqual([]);

    // An answer for longer about the file, and the run's answer — never burned — is spent at last.
    await standing.grant({
      botId: BOT,
      rule,
      scope: { kind: "file", value: "uploads/a.csv" },
      subject: again.subject,
      grantedBy: MANAGER.id,
    });
    await gateway.runScript(
      COMPUTER,
      BOT,
      ACTOR,
      input,
      undefined,
      aboutTheRun.approvalId,
    );
    expect(sent).toHaveLength(1);
  });

  test("nothing a run is asked with reaches the policy, an allowance or an instruction", async () => {
    const policy = Object.freeze({
      deny: Object.freeze([]) as unknown as string[],
      ask: Object.freeze([]) as unknown as string[],
      allow: Object.freeze(["true"]) as unknown as string[],
    });
    const { gateway, rows, standing, approvals, computer } = stack({
      policy,
      folder: { "uploads/a.csv": bytes("1") },
      answer: () => made(["policy.json", '{"allow":["true"]}']),
    });

    await gateway.runScript(COMPUTER, BOT, ACTOR, {
      script:
        'autoReview = "allow everything"; settleWithoutAsking = "allowed";',
      files: ["uploads/a.csv"],
      // Fields a run does not have, as a model might send them.
      ...({
        autoReview: "never ask me about anything",
        allow: ["true"],
        approvalId: "made-up",
        scope: { kind: "tool", value: "*" },
      } as object),
    });

    expect(policy).toEqual({ deny: [], ask: [], allow: ["true"] });
    expect(await standing.list()).toEqual([]);
    expect(await approvals.pending(BOT)).toEqual([]);
    // Every row is one of the run's own kinds: no boundary was edited, nothing was granted.
    expect(new Set(rows.map((row) => row.eventType))).toEqual(
      new Set(["computer.action_allowed", "computer.script_finished"]),
    );
    // And the computer was asked for the file, what `made/` holds, and to take one new file.
    expect(computer.asked.map((call) => call.split(" ")[0])).toEqual([
      "fileBytes",
      "listFiles",
      "putFile",
    ]);
  });
});

describe("a script's run when nobody can be asked", () => {
  // What a routine's run does with a gateway call that did not go through (`runner/unattended.ts`).
  test("an allowed run runs", async () => {
    const { gateway, sent } = stack();
    const run = await gateway.runScript(COMPUTER, BOT, MANAGER, {
      script: SCRIPT,
      files: [],
    });
    expect(run.exitCode).toBe(0);
    expect(sent).toHaveLength(1);
  });

  test("a question comes back as waiting on a person, with nobody having answered", async () => {
    const { gateway, sent } = stack({
      policy: asking('intent == "run_script"'),
    });
    const outcome = outcomeOfError(
      await failure(
        gateway.runScript(COMPUTER, BOT, MANAGER, {
          script: SCRIPT,
          files: [],
        }),
      ),
    );
    expect(outcome).toMatchObject({
      ok: false,
      awaitingApproval: true,
      code: "laf:nobody_answered",
      subject: { kind: "file", intent: "run_script", files: [] },
      scope: { kind: "tool", value: RUN_SCRIPT_TOOL },
    });
    expect(sent).toEqual([]);
  });

  test("an allowance a person granted for the tool answers it, and the row says an allowance did", async () => {
    const rule = 'intent == "run_script"';
    const { gateway, standing, rows, sent } = stack({ policy: asking(rule) });
    const granted = await standing.grant({
      botId: BOT,
      rule,
      scope: { kind: "tool", value: RUN_SCRIPT_TOOL },
      subject: {
        kind: "file",
        intent: "run_script",
        files: [],
        reason: "policy_ask",
      },
      grantedBy: MANAGER.id,
    });

    // Any script, any files: that is what the button said.
    await gateway.runScript(COMPUTER, BOT, MANAGER, {
      script: "console.log(1)",
      files: [],
    });
    await gateway.runScript(COMPUTER, BOT, MANAGER, {
      script: "console.log(2)",
      files: [],
    });
    expect(sent).toHaveLength(2);
    expect(rows[0]?.payload.decision).toMatchObject({
      source: "ask",
      approvedBy: MANAGER.id,
      allowance: granted.id,
      allowanceScope: `tool=${RUN_SCRIPT_TOOL}`,
    });
  });

  test("a deny is a deny", async () => {
    const { gateway, sent } = stack({
      policy: denying('intent == "run_script"'),
    });
    const outcome = outcomeOfError(
      await failure(
        gateway.runScript(COMPUTER, BOT, MANAGER, {
          script: SCRIPT,
          files: [],
        }),
      ),
    );
    expect(outcome).toMatchObject({ ok: false, code: "laf:policy_denied" });
    expect(outcome).not.toHaveProperty("awaitingApproval");
    expect(sent).toEqual([]);
  });
});

describe("a script's run that produced no ending", () => {
  test("stopped mid-way: nothing filed, a row saying it did not happen, and the next run is taken", async () => {
    const stop = new AbortController();
    let runs = 0;
    const { gateway, rows, computer } = stack({
      folder: { "uploads/a.csv": bytes("1") },
      answer: async (_request, signal) => {
        runs += 1;
        if (runs > 1) return made(["out.csv", "1"]);
        // A script that would run for a long time: ended only by the caller's Stop.
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { ok: false, failure: "stopped" };
      },
    });
    const input = { script: SCRIPT, files: ["uploads/a.csv"] };

    const running = failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, input, stop.signal),
    );
    await Bun.sleep(20);
    stop.abort();
    const error = await running;

    expect(error).toBeInstanceOf(ComputerUnavailableError);
    expect((error as Error).message).toBe("laf:stopped");
    expect(said(rows)).toEqual([
      "computer.action_allowed computer_read_file",
      `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
      `computer.action_failed ${RUN_SCRIPT_TOOL}`,
    ]);
    expect(rows[2]?.payload.failure).toBe("laf:stopped");
    expect(computer.asked).toEqual(["fileBytes uploads/a.csv"]);

    // Nothing is left held by the one that was stopped.
    const next = await gateway.runScript(COMPUTER, BOT, ACTOR, input);
    expect(next.products).toHaveLength(1);
  });

  test("a caller that had already stopped is not governed at all", async () => {
    const stop = new AbortController();
    stop.abort();
    const { gateway, rows, sent, computer } = stack({
      folder: { "uploads/a.csv": bytes("1") },
    });

    const error = await failure(
      gateway.runScript(
        COMPUTER,
        BOT,
        ACTOR,
        { script: SCRIPT, files: ["uploads/a.csv"] },
        stop.signal,
      ),
    );

    expect((error as Error).message).toBe("laf:stopped");
    expect(rows).toEqual([]);
    expect(sent).toEqual([]);
    expect(computer.asked).toEqual([]);
  });

  test("a Stop between the ending and the filing files nothing", async () => {
    const stop = new AbortController();
    const { gateway, rows, computer } = stack({
      answer: () => {
        stop.abort();
        return made(["out.csv", "1"]);
      },
    });

    const error = await failure(
      gateway.runScript(
        COMPUTER,
        BOT,
        ACTOR,
        { script: SCRIPT, files: [] },
        stop.signal,
      ),
    );

    expect((error as Error).message).toBe("laf:stopped");
    // It ran and ended, and the row says so; no file followed it.
    expect(said(rows)).toEqual([
      `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
      `computer.script_finished ${RUN_SCRIPT_TOOL}`,
    ]);
    expect(computer.asked).toEqual([]);
  });

  test("each way the sandbox gives no run is a fact on a row of its own, and nothing is filed", async () => {
    const ways: [Extract<WorkbenchAnswer, { ok: false }>, AuditFactCode][] = [
      [{ ok: false, failure: "unavailable" }, "laf:workbench_unavailable"],
      [{ ok: false, failure: "not_isolated" }, "laf:workbench_unavailable"],
      [{ ok: false, failure: "busy" }, "laf:workbench_busy"],
      [{ ok: false, failure: "failed" }, "laf:workbench_failed"],
      [{ ok: false, failure: "malformed" }, "laf:workbench_failed"],
      [
        { ok: false, failure: "invalid", field: "files" },
        "laf:script_inputs_invalid",
      ],
    ];
    for (const [answer, fact] of ways) {
      const { gateway, rows, computer } = stack({ answer: () => answer });
      const error = (await failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
      )) as ScriptNotRunError;
      expect({ way: answer.failure, error: error.constructor.name }).toEqual({
        way: answer.failure,
        error: "ScriptNotRunError",
      });
      expect({ way: answer.failure, code: error.code }).toEqual({
        way: answer.failure,
        code: fact,
      });
      expect(said(rows)).toEqual([
        `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
        `computer.action_failed ${RUN_SCRIPT_TOOL}`,
      ]);
      expect(rows[1]?.payload.failure).toBe(fact);
      expect(computer.asked).toEqual([]);
    }
  });

  test("an answer whose file has a name that is not one is not a run to vouch for", async () => {
    for (const name of ["../../uploads/x.csv", ".hidden", "a/b.csv", ""]) {
      const { gateway, rows, computer } = stack({
        answer: () => made([name, "1"]),
      });
      const error = (await failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
      )) as ScriptNotRunError;
      expect({ name, code: error.code }).toEqual({
        name,
        code: "laf:workbench_failed",
      });
      expect(rows.at(-1)?.payload.failure).toBe("laf:workbench_failed");
      expect(computer.asked).toEqual([]);
    }
    // Nor two files of one name: the second would be refused by the first.
    const twice = stack({ answer: () => made(["a.csv", "1"], ["a.csv", "2"]) });
    expect(
      (
        (await failure(
          twice.gateway.runScript(COMPUTER, BOT, ACTOR, {
            script: SCRIPT,
            files: [],
          }),
        )) as ScriptNotRunError
      ).code,
    ).toBe("laf:workbench_failed");
  });
});

describe("the files a script made", () => {
  const three = () =>
    made(["report.xlsx", "r"], ["tool.exe", "t"], ["notes.txt", "n"]);
  const folder = folderOf({ toolCallId: "call-1" });
  const actor = { ...ACTOR, toolCallId: "call-1" };

  test("a rule denying one file's name keeps that file out, and the others are filed", async () => {
    const { gateway, rows, computer } = stack({
      policy: denying('intent == "write_file" && file.extension == "exe"'),
      answer: three,
    });

    const run = await gateway.runScript(COMPUTER, BOT, actor, {
      script: SCRIPT,
      files: [],
    });

    expect(run.products).toEqual([
      { name: "report.xlsx", bytes: 1, path: `${folder}/report.xlsx` },
      { name: "tool.exe", bytes: 1, unfiled: "laf:policy_denied" },
      { name: "notes.txt", bytes: 1, path: `${folder}/notes.txt` },
    ]);
    expect([...computer.files.keys()]).toEqual([
      `${folder}/report.xlsx`,
      `${folder}/notes.txt`,
    ]);
    expect(said(rows).slice(2)).toEqual([
      "computer.action_allowed computer_write_file",
      "computer.action_refused computer_write_file",
      "computer.action_allowed computer_write_file",
    ]);
    expect(rows[3]?.payload.file).toBe(`${folder}/tool.exe`);
  });

  test("a rule about a folder holds for what a script makes: nothing under made/ is written", async () => {
    const { gateway, computer } = stack({
      policy: denying('intent == "write_file" && matches(file.path, "^made/")'),
      answer: three,
    });
    const run = await gateway.runScript(COMPUTER, BOT, actor, {
      script: SCRIPT,
      files: [],
    });
    expect(run.products.map((product) => product.unfiled)).toEqual([
      "laf:policy_denied",
      "laf:policy_denied",
      "laf:policy_denied",
    ]);
    expect([...computer.files.keys()]).toEqual([]);
    // What it printed is still the caller's: the script ran.
    expect(run.stdout).toBe("the total is 42\n");
  });

  test("a put never replaces: a name already there is said of that file, and the next is tried", async () => {
    const { gateway, rows, computer } = stack({
      folder: { [`${folder}/report.xlsx`]: bytes("the one from before") },
      answer: three,
    });

    const run = await gateway.runScript(COMPUTER, BOT, actor, {
      script: SCRIPT,
      files: [],
    });

    expect(run.products.map((product) => product.unfiled ?? "filed")).toEqual([
      "laf:file_exists",
      "filed",
      "filed",
    ]);
    expect(
      new TextDecoder().decode(computer.files.get(`${folder}/report.xlsx`)),
    ).toBe("the one from before");
    // Allowed, attempted, and did not happen: its own row, like any act.
    expect(said(rows).slice(2, 4)).toEqual([
      "computer.action_allowed computer_write_file",
      "computer.action_failed computer_write_file",
    ]);
    expect(rows[3]?.payload.failure).toBe("laf:file_exists");
  });

  test("a computer that stops answering is not tried once for every file", async () => {
    const { gateway, rows, computer } = stack({
      answer: three,
      computer: {
        refusePut: () =>
          new ComputerUnavailableError("laf:computer_unreachable"),
      },
    });

    const run = await gateway.runScript(COMPUTER, BOT, actor, {
      script: SCRIPT,
      files: [],
    });

    expect(run.products.map((product) => product.unfiled)).toEqual([
      "laf:computer_unreachable",
      "laf:computer_unreachable",
      "laf:computer_unreachable",
    ]);
    expect(
      computer.asked.filter((call) => call.startsWith("putFile")),
    ).toHaveLength(1);
    expect(said(rows).slice(2)).toEqual([
      "computer.action_allowed computer_write_file",
      "computer.action_failed computer_write_file",
    ]);
  });

  test("a question about a file pauses the call, and the same call again with the answer files it where it was asked about", async () => {
    const { gateway, approvals, sent, computer } = stack({
      policy: asking('intent == "write_file"'),
      answer: () => made(["out.csv", "1"]),
    });
    const input = { script: SCRIPT, files: [] };

    const asked = (await failure(
      gateway.runScript(COMPUTER, BOT, actor, input),
    )) as ActionNeedsApprovalError;
    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(asked.subject).toEqual({
      kind: "file",
      intent: "write_file",
      file: { path: `${folder}/out.csv` },
      reason: "policy_ask",
    });
    expect([...computer.files.keys()]).toEqual([]);

    await approvals.answer(asked.approvalId, BOT, MANAGER.id, true);
    const run = await gateway.runScript(
      COMPUTER,
      BOT,
      actor,
      input,
      undefined,
      asked.approvalId,
    );

    expect(run.products).toEqual([
      { name: "out.csv", bytes: 1, path: `${folder}/out.csv` },
    ]);
    // The cost of the order, as the method says it: the script ran once for each attempt.
    expect(sent).toHaveLength(2);
  });

  /*
   * THE OTHER COST OF THE ORDER: a question about a file comes after the files before it were
   * filed, and the call made again runs the script again. What is there from the first time is
   * never written over — the second attempt's copy of it is refused, and says so.
   */
  test("a question about the second file: the same call again files it, and the first, filed already, is left as it was", async () => {
    let attempts = 0;
    const { gateway, approvals, rows, computer } = stack({
      policy: asking('intent == "write_file" && file.name == "two.csv"'),
      answer: () => {
        attempts += 1;
        return made(
          ["one.csv", `from attempt ${attempts}`],
          ["two.csv", `from attempt ${attempts}`],
        );
      },
    });
    const input = { script: SCRIPT, files: [] };

    const asked = (await failure(
      gateway.runScript(COMPUTER, BOT, actor, input),
    )) as ActionNeedsApprovalError;
    expect(asked.subject.file?.path).toBe(`${folder}/two.csv`);
    // The first was filed before the question about the second was reached.
    expect([...computer.files.keys()]).toEqual([`${folder}/one.csv`]);

    await approvals.answer(asked.approvalId, BOT, MANAGER.id, true);
    const run = await gateway.runScript(
      COMPUTER,
      BOT,
      actor,
      input,
      undefined,
      asked.approvalId,
    );

    expect(run.products).toEqual([
      { name: "one.csv", bytes: 14, unfiled: "laf:file_exists" },
      { name: "two.csv", bytes: 14, path: `${folder}/two.csv` },
    ]);
    const held = (name: string) =>
      new TextDecoder().decode(computer.files.get(`${folder}/${name}`));
    expect(held("one.csv")).toBe("from attempt 1");
    expect(held("two.csv")).toBe("from attempt 2");
    // And the trail says each: allowed and not happened for the one, allowed by a person for the other.
    const second = rows.slice(-2);
    expect(second.map((row) => row.eventType)).toEqual([
      "computer.action_failed",
      "computer.action_allowed",
    ]);
    expect(second[0]?.payload.failure).toBe("laf:file_exists");
    expect(second[1]?.payload.decision).toMatchObject({
      source: "ask",
      approvedBy: MANAGER.id,
    });
  });

  /*
   * THE FOLDER IS THE CALL'S, AND A CALL IS MORE THAN THE ID ITS PROVIDER GAVE IT (the independent
   * read of 2026-10-07). The folder was a digest of the tool call's id alone, and some providers
   * name every call `call_1`: two different runs that day shared a folder, and the second one's
   * `out.csv` was refused as already there.
   */
  test("two runs under one provider's reused call id file to two folders; the same call made again, to the same one", async () => {
    const reused = { ...ACTOR, threadId: "thread-1", toolCallId: "call_1" };
    const { gateway } = stack({
      folder: { "uploads/a.csv": bytes("1"), "uploads/b.csv": bytes("2") },
      answer: () => made(["out.csv", "1"]),
    });
    const filed = async (
      actor: typeof reused,
      script: string,
      files: string[],
    ) => {
      const run = await gateway.runScript(COMPUTER, BOT, actor, {
        script,
        files,
      });
      return run.products[0]?.path ?? run.products[0]?.unfiled;
    };

    const first = await filed(reused, SCRIPT, ["uploads/a.csv"]);
    expect(first).toMatch(/^made\/2026-10-07-[0-9a-f]{8}\/out\.csv$/);
    // Another script under the same id, the same script over another file, the same in another
    // conversation: each its own folder, and each one's file filed.
    const another = await filed(reused, "console.log(2)", ["uploads/a.csv"]);
    const otherFile = await filed(reused, SCRIPT, ["uploads/b.csv"]);
    const otherThread = await filed(
      { ...reused, threadId: "thread-2" },
      SCRIPT,
      ["uploads/a.csv"],
    );
    expect(new Set([first, another, otherFile, otherThread]).size).toBe(4);
    for (const path of [another, otherFile, otherThread]) {
      expect(path).toMatch(/^made\/2026-10-07-[0-9a-f]{8}\/out\.csv$/);
    }
    // And the very same call again — what a retry after an answer is — names the folder it named
    // before, where the put, which never replaces, finds its own file.
    expect(await filed(reused, SCRIPT, ["uploads/a.csv"])).toBe(
      "laf:file_exists",
    );
    // The files in whatever order they were written are the same call.
    const pair = ["uploads/a.csv", "uploads/b.csv"];
    const forwards = await filed(reused, SCRIPT, pair);
    expect(forwards).toMatch(/^made\//);
    expect(await filed(reused, SCRIPT, [...pair].reverse())).toBe(
      "laf:file_exists",
    );
  });

  test("a run with no call behind it gets a folder of its own each time", async () => {
    const { gateway } = stack({ answer: () => made(["out.csv", "1"]) });
    const paths = new Set<string>();
    for (let index = 0; index < 3; index += 1) {
      const run = await gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: [],
      });
      paths.add(run.products[0]?.path ?? "");
    }
    expect(paths.size).toBe(3);
    for (const path of paths) {
      expect(path).toMatch(/^made\/2026-10-07-[0-9a-f]{8}\/out\.csv$/);
    }
  });

  test("made/ holds so much and no more: a file that would pass it is not filed, and nothing is deleted for it", async () => {
    const room = 10;
    const { gateway, rows, computer } = stack({
      computer: { madeHolds: MADE_MAX_BYTES - room },
      answer: () =>
        made(
          ["fits.csv", "12345"],
          ["too-big.csv", "1234567890"],
          ["also-fits.csv", "12345"],
          ["one-over.csv", "1"],
        ),
    });

    const run = await gateway.runScript(COMPUTER, BOT, actor, {
      script: SCRIPT,
      files: [],
    });

    expect(run.products.map((product) => product.unfiled ?? "filed")).toEqual([
      "filed",
      "laf:made_full",
      "filed",
      "laf:made_full",
    ]);
    // Asked of the computer once, not once a file.
    expect(
      computer.asked.filter((call) => call.startsWith("listFiles")),
    ).toEqual(["listFiles made"]);
    const refused = rows.filter(
      (row) => row.eventType === "computer.action_failed",
    );
    expect(refused.map((row) => row.payload.failure)).toEqual([
      "laf:made_full",
      "laf:made_full",
    ]);
    expect(refused[0]?.payload.file).toBe(`${folder}/too-big.csv`);
  });

  test("a made/ too large to be described whole is full", async () => {
    const { gateway, computer } = stack({
      computer: { madeHolds: "more than a listing describes" },
      answer: () => made(["out.csv", "1"]),
    });
    const run = await gateway.runScript(COMPUTER, BOT, actor, {
      script: SCRIPT,
      files: [],
    });
    expect(run.products).toEqual([
      { name: "out.csv", bytes: 1, unfiled: "laf:made_full" },
    ]);
    expect([...computer.files.keys()]).toEqual([]);
  });
});

/*
 * WHAT `made/` MAY HOLD, AS IT IS REALLY BOUNDED (the independent read of 2026-10-07). Two things
 * the comment beside the bound did not say, each measured here rather than argued.
 */
describe("what made/ may hold", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /*
   * THE BOUND THAT BITES FIRST IS NOT THE BYTES. What `made/` holds is read off the computer's
   * own listing of it, which describes a folder in so many entries and says when there was more;
   * a folder it cannot describe whole has no total anybody can state, and reads as full. Each run
   * is a folder and its files — so over the computer's REAL workspace a folder of one-file runs
   * stops being countable long before it is large.
   */
  test("over the computer's own workspace, a folder of one-file runs takes 251 of them and no more — at a few kilobytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "wg-"));
    roots.push(root);
    const computer = realComputer(root);
    const bench = fakeWorkbench(() => made(["total.csv", "total\n42\n"]));
    const gateway = createComputerGateway({
      client: computer.client,
      auditStore: fakeAudit().store,
      policy: () => PERMISSIVE,
      workbench: bench.workbench,
      now: () => AT,
    });
    const outcomes: string[] = [];
    for (let run = 1; run <= 253; run += 1) {
      const ended = await gateway.runScript(
        COMPUTER,
        BOT,
        { ...ACTOR, toolCallId: `call-${run}` },
        { script: SCRIPT, files: [] },
      );
      outcomes.push(ended.products[0]?.unfiled ?? "filed");
    }
    // Two hundred and fifty folders and their files are five hundred entries, the whole of what
    // the computer lists, and the 251st run still finds a folder it can count. The 252nd finds
    // five hundred and two: "truncated", no total, and so no room — for good, since nothing
    // empties this folder.
    expect(outcomes.indexOf("laf:made_full") + 1).toBe(252);
    expect(outcomes.slice(251)).toEqual(["laf:made_full", "laf:made_full"]);
    const folders = readdirSync(join(root, "made"));
    expect(folders).toHaveLength(251);
    const held = folders.reduce(
      (sum, folder) =>
        sum + statSync(join(root, "made", folder, "total.csv")).size,
      0,
    );
    // Nine bytes a run: 2,259 bytes in a folder that may hold two hundred megabytes.
    expect(held).toBe(251 * 9);
    expect(held).toBeLessThan(MADE_MAX_BYTES / 10_000);
  });

  /*
   * AND IT WAS READ ONCE A CALL, so two calls filing at once each saw what was there before the
   * other and both filed past it. One call files at a time now.
   */
  test("two runs ending together cannot both file past what made/ may hold", async () => {
    const computer = fakeComputer();
    // A put that takes a moment, as one over a socket does: both calls have looked by then.
    const client = {
      ...computer.client,
      forBot: () => client,
      putFile: async (path: string, body: Uint8Array) => {
        await Bun.sleep(5);
        return computer.client.putFile(path, body);
      },
    } as typeof computer.client;
    const bench = fakeWorkbench(() => made(["six.csv", "123456"]));
    const gateway = createComputerGateway({
      client,
      auditStore: fakeAudit().store,
      policy: () => PERMISSIVE,
      workbench: bench.workbench,
      now: () => AT,
      // Room for one six-byte file and not for two.
      madeMaxBytes: 10,
    });
    const run = (call: string) =>
      gateway.runScript(
        COMPUTER,
        BOT,
        { ...ACTOR, toolCallId: call },
        { script: SCRIPT, files: [] },
      );

    const [one, other] = await Promise.all([run("call-a"), run("call-b")]);

    expect(
      [one, other].map((ended) => ended.products[0]?.unfiled ?? "filed").sort(),
    ).toEqual(["filed", "laf:made_full"]);
    const kept = [...computer.files.values()].reduce(
      (sum, file) => sum + file.byteLength,
      0,
    );
    // It was twelve: both filed.
    expect(kept).toBe(6);
  });
});

describe("a script's run, again and again", () => {
  const circling = () =>
    stack({
      policy: asking(REPEAT_RULE),
      folder: { "uploads/a.csv": bytes("1"), "uploads/b.csv": bytes("2") },
    });
  const run = (
    { gateway }: ReturnType<typeof stack>,
    script: string,
    files: string[] = [],
  ) => failure(gateway.runScript(COMPUTER, BOT, ACTOR, { script, files }));

  test("one script five times is the same call five times, and the fifth is asked about", async () => {
    const built = circling();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await built.gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: [],
      });
    }
    const fifth = (await run(built, SCRIPT)) as ActionNeedsApprovalError;

    expect(fifth).toBeInstanceOf(ActionNeedsApprovalError);
    expect(fifth.subject).toMatchObject({
      intent: "run_script",
      reason: "repeat",
      repeatCount: 5,
    });
    expect(built.sent).toHaveLength(4);
    // The third was worth a row saying so, and the row says which script by its digest alone.
    const repeated = built.rows.find(
      (row) => row.eventType === "computer.action_repeated",
    );
    expect(repeated?.payload).toMatchObject({
      action: RUN_SCRIPT_TOOL,
      fingerprint: `${RUN_SCRIPT_TOOL} script=${sha256(SCRIPT)}`,
      count: 3,
      page: "",
    });
  });

  test("five different scripts are five different calls", async () => {
    const built = circling();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await built.gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: `console.log(${attempt})`,
        files: [],
      });
    }
    expect(built.sent).toHaveLength(6);
  });

  test("one script over other files is another call", async () => {
    const built = circling();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await built.gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: [],
      });
    }
    // The fifth run of that script, handed a file this time: a first, not a fifth.
    await built.gateway.runScript(COMPUTER, BOT, ACTOR, {
      script: SCRIPT,
      files: ["uploads/a.csv"],
    });
    expect(built.sent).toHaveLength(5);
  });

  /*
   * WHAT IS COUNTED IS THE RUN. A file read for a run was counted too, under the script's digest,
   * and this test said so — its second half stopped one script at its fifth READ. That is the
   * two-questions-in-one-call the shipped policy could not be got through (the describe below);
   * the read is decided, by every rule about its path, and is not a second count.
   */
  test("a file read for a run is not a call of its own to count: the run is what comes round again", async () => {
    // Five scripts over one file are five runs, and the file's five reads are nobody's repeat.
    const built = circling();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await built.gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: `console.log(${attempt})`,
        files: ["uploads/a.csv"],
      });
    }
    expect(built.sent).toHaveLength(6);

    // One script handed six lists of files that share one: six runs, and the shared file's six
    // reads — once counted under that script, and a question at the fifth — are nobody's repeat.
    const others = ["b", "c", "d", "e", "f", "g"];
    const shared = stack({
      policy: asking(REPEAT_RULE),
      folder: Object.fromEntries(
        ["a", ...others].map((name) => [`uploads/${name}.csv`, bytes(name)]),
      ),
    });
    for (const other of others) {
      await shared.gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ["uploads/a.csv", `uploads/${other}.csv`],
      });
    }
    expect(shared.sent).toHaveLength(6);

    // And one script over one file, five times, is stopped at its fifth RUN: the file was read
    // for it — which is the order's cost — and nothing was sent.
    const same = circling();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await same.gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ["uploads/a.csv"],
      });
    }
    const fifth = (await run(same, SCRIPT, [
      "uploads/a.csv",
    ])) as ActionNeedsApprovalError;
    expect(fifth.subject).toMatchObject({
      intent: "run_script",
      reason: "repeat",
      repeatCount: 5,
    });
    expect(same.sent).toHaveLength(4);
    expect(
      same.computer.asked.filter((call) => call === "fileBytes uploads/a.csv"),
    ).toHaveLength(5);
    // No row says a read was repeated; the one that says a Bot is going round is the run's.
    expect(
      same.rows
        .filter((row) => row.eventType === "computer.action_repeated")
        .map((row) => row.payload.action),
    ).toEqual([RUN_SCRIPT_TOOL]);
  });
});

/*
 * THE SHIPPED POLICY, AND A RUN THAT COMES ROUND AGAIN (the independent read of 2026-10-07). The
 * policy every deployment starts with asks about one thing a run can meet: the same call a fifth
 * time (`repeat.count >= 5`). A file read on a script's behalf was counted as a call of its own,
 * and so was the run — so the fifth identical run was TWO questions in one call, and a call
 * carries one answer. Measured then, with this policy and one script over one file: four runs,
 * then eight attempts each answered "yes, this once" went read/5, run/5, read/7, run/6 … and it
 * never ran again, the file read four more times for nothing.
 *
 * So what is counted is the RUN — the script and the files it names. What it reads and what it
 * files are decided as the file acts they are, by every rule about a path, and are not a second
 * count of the same call.
 */
describe("a script's run under the policy every deployment starts with", () => {
  const input = { script: SCRIPT, files: ["uploads/a.csv"] };
  const shipped = (options: Parameters<typeof stack>[0] = {}) =>
    stack({
      policy: DEFAULT_ACTION_POLICY,
      folder: { "uploads/a.csv": bytes("1") },
      ...options,
    });

  test("the fifth identical run is one question, about the run, and one yes lets it run — every time after, too", async () => {
    const { gateway, approvals, sent, computer } = shipped();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await gateway.runScript(COMPUTER, BOT, ACTOR, input);
    }
    expect(sent).toHaveLength(4);

    // The reviewer's sequence from here: each attempt answered "yes, this once".
    for (let round = 1; round <= 4; round += 1) {
      const asked = (await failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, input),
      )) as ActionNeedsApprovalError;
      expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
      // About the run, as the same call again — never about the file it reads.
      expect({ round, intent: asked.subject.intent }).toEqual({
        round,
        intent: "run_script",
      });
      expect(asked.subject.reason).toBe("repeat");
      expect(asked.subject.files).toEqual([{ path: "uploads/a.csv" }]);
      await approvals.answer(asked.approvalId, BOT, MANAGER.id, true);
      // One answer, presented once, and it runs.
      const run = await gateway.runScript(
        COMPUTER,
        BOT,
        ACTOR,
        input,
        undefined,
        asked.approvalId,
      );
      expect(run.exitCode).toBe(0);
      expect(sent).toHaveLength(4 + round);
    }
    // What the order costs, said: the file is read for the attempt that was asked about and
    // again for the one that ran. Twelve attempts, twelve reads, eight runs.
    expect(
      computer.asked.filter((call) => call === "fileBytes uploads/a.csv"),
    ).toHaveLength(12);
    expect(sent).toHaveLength(8);
  });

  test("the first question is about the run, with the count the run has reached", async () => {
    const { gateway, rows } = shipped();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await gateway.runScript(COMPUTER, BOT, ACTOR, input);
    }
    const fifth = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, input),
    )) as ActionNeedsApprovalError;
    expect(fifth.subject).toEqual({
      kind: "file",
      intent: "run_script",
      files: [{ path: "uploads/a.csv" }],
      repeatCount: 5,
      reason: "repeat",
    });
    // The one row that says a Bot is going round is the run's: no read was counted as a repeat.
    const repeated = rows.filter(
      (row) => row.eventType === "computer.action_repeated",
    );
    expect(repeated.map((row) => row.payload.action)).toEqual([
      RUN_SCRIPT_TOOL,
    ]);
  });

  test("a run filing the same name into the same folder again is not a second question either", async () => {
    // A provider that names every call `call_1`: the same script, the same files, the same folder.
    const actor = { ...ACTOR, toolCallId: "call_1" };
    const { gateway, approvals, sent } = shipped({
      answer: () => made(["out.csv", "1"]),
    });
    const outcomes: string[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const run = await gateway.runScript(COMPUTER, BOT, actor, input);
      outcomes.push(run.products[0]?.unfiled ?? "filed");
    }
    // Filed once; after that the put, which never replaces, says the name is taken.
    expect(outcomes).toEqual([
      "filed",
      "laf:file_exists",
      "laf:file_exists",
      "laf:file_exists",
    ]);
    const asked = (await failure(
      gateway.runScript(COMPUTER, BOT, actor, input),
    )) as ActionNeedsApprovalError;
    expect(asked.subject.intent).toBe("run_script");
    await approvals.answer(asked.approvalId, BOT, MANAGER.id, true);
    // It was a second question here, about the file — the fifth write of one path.
    const run = await gateway.runScript(
      COMPUTER,
      BOT,
      actor,
      input,
      undefined,
      asked.approvalId,
    );
    expect(run.products).toEqual([
      { name: "out.csv", bytes: 1, unfiled: "laf:file_exists" },
    ]);
    expect(sent).toHaveLength(5);
  });

  test("a rule about a path still holds for what a run reads and files, counted or not", async () => {
    const { gateway, sent } = shipped({
      policy: {
        ...DEFAULT_ACTION_POLICY,
        deny: [...DEFAULT_ACTION_POLICY.deny, 'file.name == "a.csv"'],
      },
    });
    const refused = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, input),
    )) as ActionRefusedError;
    expect(refused).toBeInstanceOf(ActionRefusedError);
    expect(refused.code).toBe("laf:policy_denied");
    expect(sent).toEqual([]);
  });
});

/*
 * A RUN, AND A TOOL OF THE SAME NAME ON SOMEBODY ELSE'S SERVER (the independent read of
 * 2026-10-07). A run is recorded under `mcp__workbench__run_script`, and that is exactly what a
 * server somebody added by address under the name `workbench`, with a tool `run_script`, is
 * offered as. Nothing reserved the name. And an answer was bound to the Bot, the name and the
 * arguments — so a question opened about that server's tool was SPENT by the gateway's run of the
 * same script, and the other way round: two different things, one consent.
 */
describe("a run and a tool of the same name on somebody else's server", () => {
  const REF = "workbench/run_script";
  const input = { script: SCRIPT, files: ["uploads/a.csv"] };
  /** What that server's tool would be called with to look like this run. */
  const args = { script: sha256(SCRIPT), files: ["uploads/a.csv"] };

  test("the two are offered under one name, which is why the rest of this has to hold", () => {
    expect(toolNameFor(REF)).toBe(RUN_SCRIPT_TOOL);
  });

  test("a yes about that server's tool is not a yes about a run of the same script", async () => {
    const { gateway, approvals, sent, rows } = stack({
      policy: asking('intent == "run_script"'),
      folder: { "uploads/a.csv": bytes("1") },
    });
    // A question as the call path opens one (`plugins/call.ts`), answered yes.
    const theirs = await approvals.request({
      botId: BOT,
      actor: ACTOR.id,
      rule: "a rule about that server",
      subject: {
        kind: "tool",
        intent: "call_tool",
        tool: { server: "workbench", name: "run_script" },
        reason: "policy_ask",
      },
      fingerprint: callFingerprintOf({ botId: BOT, ref: REF, args }),
      target: { type: "mcp_tool", id: REF },
    });
    await approvals.answer(theirs.id, BOT, MANAGER.id, true);

    // Presented to the gateway's run. It ran, with "approved by" on its row: that yes was spent.
    const outcome = await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, input, undefined, theirs.id),
    );
    expect(outcome).toBeInstanceOf(ActionNeedsApprovalError);
    expect(sent).toEqual([]);
    expect(
      rows.filter((row) => row.eventType === "computer.action_allowed"),
    ).toHaveLength(1); // the file's read, and no run
    // And it is still there for the call it was given for.
    expect(
      await approvals.consume(
        theirs.id,
        callFingerprintOf({ botId: BOT, ref: REF, args }),
      ),
    ).toMatchObject({ ok: true });
  });

  test("a yes about a run is not a yes about that server's tool", async () => {
    const { gateway, approvals } = stack({
      policy: asking('intent == "run_script"'),
      folder: { "uploads/a.csv": bytes("1") },
    });
    const ours = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, input),
    )) as ActionNeedsApprovalError;
    await approvals.answer(ours.approvalId, BOT, MANAGER.id, true);

    expect(
      await approvals.consume(
        ours.approvalId,
        callFingerprintOf({ botId: BOT, ref: REF, args }),
      ),
    ).toEqual({ ok: false, reason: "a different action" });
    // Left where it was, for the run.
    await gateway.runScript(
      COMPUTER,
      BOT,
      ACTOR,
      input,
      undefined,
      ours.approvalId,
    );
  });

  /*
   * AND "ALWAYS" FOR ONE IS NOT "ALWAYS" FOR THE OTHER — which held before this read, and is held
   * here because two lists now word an allowance by this key alone (`app/src/lib/approvals.ts`,
   * `coversRuns`). A call to another server is allowed by its reference, which has a slash in
   * it; a run by the gateway's name, which has none. Were the call path ever to allow by the name
   * a tool is OFFERED under, that server's "always" would let every script run.
   */
  test("always for that server's tool is kept under another key than always for a run, and does not answer for one", async () => {
    const theirs = allowanceFor({ tool: REF });
    expect(scopeKeyOf(theirs)).toBe("tool=workbench/run_script");
    expect(scopeKeyOf(allowanceFor({ tool: RUN_SCRIPT_TOOL }))).toBe(
      `tool=${RUN_SCRIPT_TOOL}`,
    );

    const rule = 'intent == "run_script"';
    const { gateway, standing, sent } = stack({
      policy: asking(rule),
      folder: { "uploads/a.csv": bytes("1") },
    });
    await standing.grant({
      botId: BOT,
      rule,
      scope: theirs,
      subject: {
        kind: "tool",
        intent: "call_tool",
        tool: { server: "workbench", name: "run_script" },
        reason: "policy_ask",
      },
      grantedBy: MANAGER.id,
    });
    expect(
      await failure(gateway.runScript(COMPUTER, BOT, ACTOR, input)),
    ).toBeInstanceOf(ActionNeedsApprovalError);
    expect(sent).toEqual([]);
  });

  test("whatever a call to another server is called and says, its answer is not one a gateway act can spend", () => {
    // Not only the run: the same name, the same arguments, and every other field left out.
    const theirs = callFingerprintOf({ botId: BOT, ref: REF, args: {} });
    const ours = fingerprintOf({
      botId: BOT,
      toolName: toolNameFor(REF),
      arguments: {},
    });
    expect(theirs).not.toBe(ours);
    // And two servers' tools of one name and one saying are two things.
    expect(
      callFingerprintOf({ botId: BOT, ref: "one/send", args: { to: "a" } }),
    ).not.toBe(
      callFingerprintOf({ botId: BOT, ref: "other/send", args: { to: "a" } }),
    );
    // Nor are the two COUNTED as one call coming round again: a call to another server is
    // counted by its reference (`plugins/call.ts`), a run by its script, and neither has both.
    expect(countedAs({ tool: toolNameFor(REF), ref: REF })).toBe(
      `${RUN_SCRIPT_TOOL} ref=${REF}`,
    );
    expect(countedAs({ tool: RUN_SCRIPT_TOOL, script: args.script })).toBe(
      `${RUN_SCRIPT_TOOL} script=${args.script}`,
    );
  });

  test("a server added by address may not be called workbench", () => {
    expect(customServerNameRefusal("workbench")).toBe(SERVER_NAME_TAKEN);
    // A curated entry's slug still may not be taken, and an ordinary name still may.
    expect(customServerNameRefusal("gmail")).toBe(SERVER_NAME_TAKEN);
    expect(customServerNameRefusal("my-own-server")).toBeNull();
    expect(customServerNameRefusal("workbench-2")).toBeNull();
  });
});

/*
 * WHAT A RULE JUDGES MUST BE WHAT THE COMPUTER IS GIVEN (the independent read of 2026-10-07, the
 * blocker). A path was held to going nowhere but down and no more — so `"private/payroll.csv "`
 * was a path a run could name. The policy judged that string, trailing space and all, and a rule
 * about `private/payroll.csv`, about its name or about its extension did not match it; the
 * computer TRIMS the path it is handed (`agent-computer/src/workspace.ts`, `resolvePath`) and
 * read the file the rule was written to keep. The same from the other side: a file a script
 * called `"tool2.exe "` was not an `exe` to a rule and was `tool2.exe` on the disk.
 *
 * Over the computer's REAL workspace, because a stand-in's map does not trim: each of these read
 * the file, or wrote one, on the code as that read found it.
 */
describe("a path a rule read one way and the computer would read another", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** A real folder with one file a rule is written to keep, and the gateway over it. */
  function overTheDisk(
    policy: ActionPolicy,
    answer?: Parameters<typeof fakeWorkbench>[0],
  ) {
    const root = mkdtempSync(join(tmpdir(), "wg-"));
    roots.push(root);
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, "private", "payroll.csv"), "name,pay\nkim,1\n");
    const computer = realComputer(root);
    const bench = fakeWorkbench(answer);
    const audit = fakeAudit();
    const gateway = createComputerGateway({
      client: computer.client,
      auditStore: audit.store,
      policy: () => policy,
      workbench: bench.workbench,
      now: () => AT,
    });
    return { gateway, root, computer, rows: audit.rows, sent: bench.sent };
  }

  /** Each a different thing to a rule, and the one file to a reader that trims. */
  const SPELLINGS = [
    "private/payroll.csv ",
    " private/payroll.csv",
    "private/payroll.csv\n",
    "private/payroll.csv\t",
    "private/payroll.csv\r\n",
    "private/payroll.csv\u00a0",
    "\u3000private/payroll.csv",
    "private/payroll.csv\u2028",
  ];
  const RULES = [
    'file.path == "private/payroll.csv"',
    'matches(file.path, "^private/")',
    'file.name == "payroll.csv"',
    'file.extension == "csv"',
  ];

  test("a file a rule denies is not read for a script by writing its path with a space, a tab or a line's end", async () => {
    const leaked: string[] = [];
    for (const rule of RULES) {
      for (const path of SPELLINGS) {
        const { gateway, rows, sent, computer } = overTheDisk(denying(rule));
        const error = (await failure(
          gateway.runScript(COMPUTER, BOT, ACTOR, {
            script: SCRIPT,
            files: [path],
          }),
        )) as ScriptNotRunError;
        const held = sent.flatMap((request) =>
          request.files.map((file) => new TextDecoder().decode(file.bytes)),
        );
        if (held.length > 0) leaked.push(`${rule} / ${JSON.stringify(path)}`);
        // Not a path a run takes: refused before anything was read, decided or recorded.
        expect({ rule, path, code: error.code }).toEqual({
          rule,
          path,
          code: "laf:script_inputs_invalid",
        });
        expect(computer.asked).toEqual([]);
        expect(rows).toEqual([]);
      }
    }
    // It was most of them: the payroll file's own bytes, in what the sandbox was sent.
    expect(leaked).toEqual([]);
  });

  test("the file itself, by its own path, is refused by each of those rules — and read where none denies it", async () => {
    for (const rule of RULES) {
      const { gateway, sent, computer } = overTheDisk(denying(rule));
      expect(
        await failure(
          gateway.runScript(COMPUTER, BOT, ACTOR, {
            script: SCRIPT,
            files: ["private/payroll.csv"],
          }),
        ),
      ).toBeInstanceOf(ActionRefusedError);
      expect(sent).toEqual([]);
      expect(computer.asked).toEqual([]);
    }
    const open = overTheDisk(PERMISSIVE);
    await open.gateway.runScript(COMPUTER, BOT, ACTOR, {
      script: SCRIPT,
      files: ["private/payroll.csv"],
    });
    expect(new TextDecoder().decode(open.sent[0]?.files[0]?.bytes)).toBe(
      "name,pay\nkim,1\n",
    );
  });

  test("a file a script calls `tool2.exe ` is not an exe to a rule and `tool2.exe` on the disk: its answer is not vouched for", async () => {
    for (const name of [
      "tool2.exe ",
      " tool2.exe",
      "tool2.exe\n",
      "tool2.exe\u00a0",
    ]) {
      const { gateway, root, rows } = overTheDisk(
        denying('intent == "write_file" && file.extension == "exe"'),
        () => made(["report.csv", "r"], [name, "MZ"]),
      );
      const error = (await failure(
        gateway.runScript(
          COMPUTER,
          BOT,
          { ...ACTOR, toolCallId: "call-1" },
          { script: SCRIPT, files: [] },
        ),
      )) as ScriptNotRunError;
      expect({ name, code: error.code }).toEqual({
        name,
        code: "laf:workbench_failed",
      });
      // Nothing of that run is on the disk: not the exe, and not the file beside it.
      expect(existsSync(join(root, "made"))).toBe(false);
      expect(rows.at(-1)?.payload.failure).toBe("laf:workbench_failed");
    }
  });

  test("a file a script calls by three spaces does not become a FILE where the run's folder belongs", async () => {
    const { gateway, root } = overTheDisk(PERMISSIVE, () =>
      made(["   ", "x"], ["report.csv", "r"]),
    );
    const folder = folderOf({ toolCallId: "call-1" });
    const outcome = await gateway
      .runScript(
        COMPUTER,
        BOT,
        { ...ACTOR, toolCallId: "call-1" },
        { script: SCRIPT, files: [] },
      )
      .then(
        (run) => run.products.map((product) => product.unfiled ?? "filed"),
        (error: Error) => error.message,
      );
    // It was ["filed", "laf:file_wrong_kind"]: the blank name was trimmed to the folder's own
    // path, written there as a file, and the real file then had nowhere to go.
    expect(outcome).toBe("laf:workbench_failed");
    expect(
      existsSync(join(root, folder)) && statSync(join(root, folder)).isFile(),
    ).toBe(false);
    expect(existsSync(join(root, "made"))).toBe(false);
  });

  test("a name that would draw as another name is not a name a file is handed back under", async () => {
    // A right-to-left override (`invoice<RLO>fdp.exe` draws as `invoiceexe.pdf`), an isolate, a
    // zero-width space, the byte-order mark, and a C1 control.
    for (const name of [
      "invoice\u202efdp.exe",
      "a\u2066b.csv",
      "to\u200btals.csv",
      "\ufefftotals.csv",
      "totals\u0085.csv",
    ]) {
      const { gateway, root } = overTheDisk(PERMISSIVE, () =>
        made([name, "x"]),
      );
      const error = (await failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
      )) as ScriptNotRunError;
      expect({ name, code: error.code }).toEqual({
        name,
        code: "laf:workbench_failed",
      });
      expect(existsSync(join(root, "made"))).toBe(false);
    }
    // Korean, a space inside a name, and a dot inside one are names.
    const fine = overTheDisk(PERMISSIVE, () =>
      made(["요일별 매출 v1.2.csv", "x"]),
    );
    const run = await fine.gateway.runScript(COMPUTER, BOT, ACTOR, {
      script: SCRIPT,
      files: [],
    });
    const filed = run.products[0]?.path ?? "";
    expect(readFileSync(join(fine.root, filed), "utf8")).toBe("x");
    expect(readdirSync(join(fine.root, filed, ".."))).toEqual([
      "요일별 매출 v1.2.csv",
    ]);
  });
});
