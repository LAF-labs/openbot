import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import {
  isProductName,
  isRunPath,
  RUN_PATH_CHARS as WORKBENCH_PATH_CHARS,
  WORKBENCH_LIMITS,
} from "../../shared/workbench/protocol";
import type { AuditEventInput, AuditFactCode, AuditStore } from "../src/audit";
import {
  createApprovalRegistry,
  fingerprintOf,
} from "../src/computer/approvals";
import { DEFAULT_ACTION_POLICY } from "../src/computer/default-policy";
import {
  ComputerUnavailableError,
  WorkspaceRequestError,
} from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import { createActs } from "../src/computer/gateway/acts";
import {
  hasNoOneReading,
  workspacePathOf,
} from "../src/computer/gateway/addresses";
import { RUN_SCRIPT_TOOL } from "../src/computer/gateway/intent";
import {
  filesNamedBy,
  MADE_MAX_BYTES,
  madeDirectoryFor,
  madeFull,
  requestProblem,
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
import {
  createWorkbench,
  type Workbench,
  type WorkbenchAnswer,
} from "../src/workbench/client";
import {
  EVERY_SPELLING,
  FILES as FOLDER_FILES,
  NOT_A_PATH,
  NOTE,
  PAYROLL,
  RULES as PAYROLL_RULES,
  SECRET,
} from "./support/path-spellings";
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
      JSON.stringify([
        BOT,
        call.threadId ?? "",
        call.toolCallId,
        sha256(call.script ?? SCRIPT),
        [...(call.files ?? [])].sort(),
      ]),
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
      // The names the script's files are under, and where the file it made is.
      files: ["uploads/sales.csv", "uploads/costs.csv"],
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
      // Nothing about HOW a path is written is here any more: a path that leaves the folder, an
      // absolute one, a file named twice each go on to `govern` (the describe at the foot of
      // this file). What is left is what is not a path to put on a row at all.
      [
        "a path that is not a string",
        { script: SCRIPT, files: [7] },
        "laf:script_inputs_invalid",
        { field: "files" },
      ],
      [
        // Every path goes on to `govern`, and its row carries it as written — so it is held to
        // a path's length first, and one over it is refused here.
        "a path too long for a row to carry",
        {
          script: SCRIPT,
          files: [`uploads/${"x".repeat(WORKBENCH_PATH_CHARS)}`],
        },
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

  /*
   * AND IT IS ON THE TRAIL BEFORE THE CALL WAITS ON ANYTHING (Codex, on the pull request that
   * moved it). For one afternoon the ending was written after the look at `made/` — a request
   * to the computer, which may take the whole of its timeout — and after the call's turn in the
   * line of calls filing. A server that stopped in that time left a run that had happened with
   * a row saying it was allowed and none saying how it ended. How it ended is known when the
   * sandbox answers, and is written then.
   */
  test("how a run ended is on the trail before the computer is asked anything about what it made", async () => {
    const computer = fakeComputer();
    const audit = fakeAudit();
    /** What the trail held each time the computer was asked what `made/` holds. */
    const heldWhenAsked: string[][] = [];
    const client = {
      ...computer.client,
      forBot: () => client,
      listFiles: async (
        input: Parameters<typeof computer.client.listFiles>[0],
      ) => {
        heldWhenAsked.push(audit.rows.map((row) => row.eventType));
        return computer.client.listFiles(input);
      },
    } as typeof computer.client;
    const gateway = createComputerGateway({
      client,
      auditStore: audit.store,
      policy: () => PERMISSIVE,
      workbench: fakeWorkbench(() => made(["out.csv", "1"])).workbench,
      now: () => AT,
    });

    await gateway.runScript(COMPUTER, BOT, ACTOR, {
      script: SCRIPT,
      files: [],
    });

    expect(heldWhenAsked).toEqual([
      ["computer.action_allowed", "computer.script_finished"],
    ]);
  });

  test("and before the call waits its turn behind another call's files", async () => {
    const computer = fakeComputer();
    const audit = fakeAudit();
    /** The first put waits here, holding the line, until the test lets it go. */
    const held = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const client = {
      ...computer.client,
      forBot: () => client,
      putFile: async (path: string, body: Uint8Array) => {
        reached.resolve();
        await held.promise;
        return computer.client.putFile(path, body);
      },
    } as typeof computer.client;
    const gateway = createComputerGateway({
      client,
      auditStore: audit.store,
      policy: () => PERMISSIVE,
      workbench: fakeWorkbench(() => made(["out.csv", "1"])).workbench,
      now: () => AT,
    });
    const run = (call: string) =>
      gateway.runScript(
        COMPUTER,
        BOT,
        { ...ACTOR, toolCallId: call },
        { script: SCRIPT, files: [] },
      );
    const endings = () =>
      audit.rows.filter((row) => row.eventType === "computer.script_finished")
        .length;

    const first = run("call-a");
    await reached.promise;
    // The first call is filing and holds the line. The second call's script runs meanwhile —
    // the sandbox here answers at once — and it can file nothing until the first has done.
    const second = run("call-b");
    for (let turn = 0; turn < 50 && endings() < 2; turn += 1) {
      await Bun.sleep(1);
    }
    const whileWaiting = endings();
    held.resolve();
    await Promise.all([first, second]);

    // It was 1: the second run's ending waited behind the first call's files.
    expect(whileWaiting).toBe(2);
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

  /*
   * AND FOR THE TIME IT ASKED FOR (the second read: an answer was bound to the script and its
   * files and to nothing else a call says). The time is the one thing a call can change about a
   * run without changing a byte of its script, and every argument of a call to another server
   * is part of what its answer is for; so is this one. Not asking for a time is asking for the
   * time a run gets, and is the same call as saying so.
   */
  test("a yes to a script for the time it asked is not a yes to the same script for longer", async () => {
    const { gateway, approvals, sent } = stack({
      policy: asking('intent == "run_script"'),
    });
    const input = { script: SCRIPT, files: [] };
    const asked = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, input),
    )) as ActionNeedsApprovalError;
    await approvals.answer(asked.approvalId, BOT, MANAGER.id, true);

    // For a minute instead: another call, and another question.
    const longer = await failure(
      gateway.runScript(
        COMPUTER,
        BOT,
        ACTOR,
        { ...input, timeoutMs: 60_000 },
        undefined,
        asked.approvalId,
      ),
    );
    expect(longer).toBeInstanceOf(ActionNeedsApprovalError);
    expect(sent).toEqual([]);
    // Saying the time a run gets anyway is the call that was asked about, and it runs.
    await gateway.runScript(
      COMPUTER,
      BOT,
      ACTOR,
      { ...input, timeoutMs: WORKBENCH_LIMITS.timeoutMs },
      undefined,
      asked.approvalId,
    );
    expect(sent).toHaveLength(1);
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
    const { gateway, sent, computer, rows } = stack({
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
    // And the row that says a person was asked says which run the read was for: without it a
    // question about a file read for a script is, on the trail, a question about the Bot's own.
    expect(rows.map((row) => row.eventType)).toEqual(["approval.requested"]);
    expect(rows[0]?.payload).toMatchObject({
      action: "computer_read_file",
      file: "uploads/book.xlsx",
      forScript: sha256(SCRIPT),
    });
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
    // It ran and ended, and the row says so; no file followed it — and the file the ending
    // names, which nobody got to and nothing was decided of, is said to have been left.
    expect(said(rows)).toEqual([
      `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
      `computer.script_finished ${RUN_SCRIPT_TOOL}`,
      `computer.script_files_left ${RUN_SCRIPT_TOOL}`,
    ]);
    expect(rows[2]?.payload).toEqual({
      action: RUN_SCRIPT_TOOL,
      bot: BOT,
      actor: ACTOR.id,
      script: { sha256: sha256(SCRIPT), bytes: Buffer.byteLength(SCRIPT) },
      because: "laf:stopped",
      left: [{ name: "out.csv", bytes: 1 }],
    });
    // A caller that has stopped dials nothing: not the folder's listing either.
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

  test("the row of a run that was allowed and did not happen says which script it was, and over which files", async () => {
    const { gateway, rows } = stack({
      folder: { "uploads/a.csv": bytes("1") },
      answer: () => ({ ok: false, failure: "unavailable" }),
    });
    await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ["uploads/a.csv"],
      }),
    );
    const failed = rows.at(-1);
    expect(failed?.eventType).toBe("computer.action_failed");
    // The same two things its decision's row carries: nothing else ties the two together.
    expect(failed?.payload).toMatchObject({
      action: RUN_SCRIPT_TOOL,
      script: { sha256: sha256(SCRIPT), bytes: Buffer.byteLength(SCRIPT) },
      files: ["uploads/a.csv"],
      failure: "laf:workbench_unavailable",
    });
  });

  test("an answer whose file has a name that is not one is not a run to vouch for", async () => {
    // The last: the daemon leaves a file so named where it is (`tests/workbench-daemon.test.ts`),
    // so an answer that hands one back is not that daemon's.
    for (const name of [
      "../../uploads/x.csv",
      ".hidden",
      "a/b.csv",
      "",
      "a\\b.txt",
    ]) {
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

  test("a computer that stops answering is not tried once for every file — and each file left still has its decision and a row that says it did not happen", async () => {
    const { gateway, rows, computer } = stack({
      // A rule about a name still decides a file nobody will dial for.
      policy: denying('intent == "write_file" && file.extension == "exe"'),
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
      "laf:policy_denied",
      "laf:computer_unreachable",
    ]);
    expect(
      computer.asked.filter((call) => call.startsWith("putFile")),
    ).toHaveLength(1);
    // Every file the ending names has something said of it. Until 2026-10-07 only the first
    // did: the two after it were on the ending's row and nowhere else.
    expect(
      rows
        .slice(2)
        .map((row) => [
          row.eventType,
          String(row.payload.file).slice(folder.length + 1),
          row.payload.failure ?? null,
        ]),
    ).toEqual([
      ["computer.action_allowed", "report.xlsx", null],
      ["computer.action_failed", "report.xlsx", "laf:computer_unreachable"],
      ["computer.action_refused", "tool.exe", null],
      ["computer.action_allowed", "notes.txt", null],
      ["computer.action_failed", "notes.txt", "laf:computer_unreachable"],
    ]);
  });

  /*
   * A FAILURE NOBODY NAMED, WHILE ONE FILE IS PUT, IS THAT FILE'S (the second read). The first
   * was a name that was half a character: the computer's client throws on it as it writes the
   * path. It left the loop as itself — the call died after the script had run, the failed row
   * held an exception's words, the files after it were never tried and the caller was told
   * nothing. A name like that is no name now (`isProductName`); this is what any other throw
   * that is not a fact comes to.
   */
  test("a throw that is no fact while one file is put is that file's alone: a fact on its row, the next file tried, and the caller has its list", async () => {
    const { gateway, rows, computer } = stack({
      answer: three,
      computer: {
        refusePut: (path) =>
          path.endsWith("report.xlsx")
            ? new URIError("String contained an illegal UTF-16 sequence.")
            : undefined,
      },
    });

    const run = await gateway.runScript(COMPUTER, BOT, actor, {
      script: SCRIPT,
      files: [],
    });

    expect(run.exitCode).toBe(0);
    expect(run.products).toEqual([
      { name: "report.xlsx", bytes: 1, unfiled: "laf:computer_failed" },
      { name: "tool.exe", bytes: 1, path: `${folder}/tool.exe` },
      { name: "notes.txt", bytes: 1, path: `${folder}/notes.txt` },
    ]);
    expect(said(rows).slice(2)).toEqual([
      "computer.action_allowed computer_write_file",
      "computer.action_failed computer_write_file",
      "computer.action_allowed computer_write_file",
      "computer.action_allowed computer_write_file",
    ]);
    // A fact, and never what an exception said.
    expect(rows[3]?.payload.failure).toBe("laf:computer_failed");
    expect(JSON.stringify(rows)).not.toContain("UTF-16");
    expect(
      computer.asked.filter((call) => call.startsWith("putFile")),
    ).toHaveLength(3);
  });

  /*
   * THE FILES NOBODY GOT TO ARE NAMED (the second read). Two things end the filing with files
   * untried and nothing to decide them by. The ending's row lists every file, so without this
   * the trail said a file was handed back and never what became of it.
   */
  test("a Stop while the second file is put: that file has its rows, and the one after it is named as left", async () => {
    const stop = new AbortController();
    const { gateway, rows, computer } = stack({
      answer: three,
      computer: {
        refusePut: (path) => {
          if (!path.endsWith("tool.exe")) return undefined;
          stop.abort();
          return new ComputerUnavailableError("laf:stopped");
        },
      },
    });

    const error = await failure(
      gateway.runScript(
        COMPUTER,
        BOT,
        actor,
        { script: SCRIPT, files: [] },
        stop.signal,
      ),
    );

    expect((error as Error).message).toBe("laf:stopped");
    expect(said(rows).slice(2)).toEqual([
      "computer.action_allowed computer_write_file",
      "computer.action_allowed computer_write_file",
      "computer.action_failed computer_write_file",
      `computer.script_files_left ${RUN_SCRIPT_TOOL}`,
    ]);
    expect(rows.at(-1)?.payload).toMatchObject({
      because: "laf:stopped",
      left: [{ name: "notes.txt", bytes: 1 }],
    });
    expect([...computer.files.keys()]).toEqual([`${folder}/report.xlsx`]);
  });

  test("a question about the second file: the one after it is named as left, waiting on that answer", async () => {
    const { gateway, rows } = stack({
      policy: asking('intent == "write_file" && file.extension == "exe"'),
      answer: three,
    });

    const asked = await failure(
      gateway.runScript(COMPUTER, BOT, actor, { script: SCRIPT, files: [] }),
    );

    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(rows.at(-1)?.eventType).toBe("computer.script_files_left");
    expect(rows.at(-1)?.payload).toMatchObject({
      script: { sha256: sha256(SCRIPT), bytes: Buffer.byteLength(SCRIPT) },
      because: "laf:awaiting_approval",
      left: [{ name: "notes.txt", bytes: 1 }],
    });
    // And none is written where the question was about the last file: nothing was left.
    const last = stack({
      policy: asking('intent == "write_file" && file.extension == "txt"'),
      answer: three,
    });
    await failure(
      last.gateway.runScript(COMPUTER, BOT, actor, {
        script: SCRIPT,
        files: [],
      }),
    );
    expect(
      last.rows.filter((row) => row.eventType === "computer.script_files_left"),
    ).toEqual([]);
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

  /*
   * A FOLDER IS ONE CALL'S, AND A CALL IS A TUPLE (the second read). Its parts were joined with
   * a NUL and hashed — and half of them are whatever a provider wrote, so two different calls
   * whose parts merely run together the same way were one folder: a conversation `t` with a call
   * `x<NUL>c`, and a conversation `t<NUL>x` with a call `c`. Written as what it is now.
   */
  test("two calls whose parts only run together the same way are two folders", () => {
    const of = (threadId: string, toolCallId: string, files: string[] = []) =>
      madeDirectoryFor(AT, {
        botId: BOT,
        threadId,
        toolCallId,
        sha256: sha256(SCRIPT),
        files,
      });
    expect(of("t", "x\u0000c")).not.toBe(of("t\u0000x", "c"));
    // And a file's name that runs into the next is not two files.
    expect(of("t", "c", ["a\u0000b"])).not.toBe(of("t", "c", ["a", "b"]));
    // The same call is still the same folder, whatever order its files were named in.
    expect(of("t", "c", ["b", "a"])).toBe(of("t", "c", ["a", "b"]));
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
  test("a file refused because made/ is full says what was held, what it weighs and the bound — and no figure where the folder could not be counted", () => {
    expect(madeFull(190, 20, 200).facts).toEqual({
      held: 190,
      bytes: 20,
      limit: 200,
    });
    // A folder too long to be described whole has no total anybody can state.
    expect(madeFull(Number.POSITIVE_INFINITY, 20, 200).facts).toEqual({
      bytes: 20,
      limit: 200,
    });
    expect(madeFull(190, 20, 200).code).toBe("laf:made_full");
  });

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
    /*
     * GIVEN THE TIME IT TAKES. 253 runs over a real folder, each listing it: 2.1, 3.6, 4.0 and
     * 2.7 seconds on four of CI's runs, and past the five a test gets by default on a laptop
     * with other work on it (2026-10-07) — where it failed as a timeout with nothing wrong.
     */
  }, 30_000);

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

  test("the order a call names its files in does not make it another run: the fifth is asked about whichever way round they were", async () => {
    const built = circling();
    const ways = [
      ["uploads/a.csv", "uploads/b.csv"],
      ["uploads/b.csv", "uploads/a.csv"],
    ];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await built.gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ways[attempt % 2] as string[],
      });
    }
    const fifth = (await run(
      built,
      SCRIPT,
      ways[1],
    )) as ActionNeedsApprovalError;
    expect(fifth).toBeInstanceOf(ActionNeedsApprovalError);
    expect(fifth.subject).toMatchObject({
      intent: "run_script",
      reason: "repeat",
      repeatCount: 5,
    });
    expect(built.sent).toHaveLength(4);
  });

  /*
   * WHAT A RULE ABOUT THE COUNT SEES OF A RUN'S FILE ACT, held as what it is: ONE. A read or a
   * write made for a run is decided by every rule about its path and is not counted, so a rule
   * that decides BY the count on a file's intent sees a first attempt every time — twelve
   * scripts over one file are not "the same read twelve times" to it. That is the cost written
   * in `govern.ts`, and the hole the second read and Codex both named; it stays until a run is
   * one question (the change after this one). Held so that it cannot become TWO by accident.
   */
  test("a rule that decides by the count on a file's intent sees a run's read as a first attempt, every time", async () => {
    const { gateway, sent, rows } = stack({
      policy: denying('intent == "read_file" && repeat.count >= 2'),
      folder: { "uploads/a.csv": bytes("1") },
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: `console.log(${attempt});`,
        files: ["uploads/a.csv"],
      });
    }
    expect(sent).toHaveLength(3);
    expect(
      rows.filter((row) => row.eventType === "computer.action_refused"),
    ).toEqual([]);
    // The Bot's own read of that file IS counted, and the same rule refuses its second.
    await gateway.readFile(COMPUTER, BOT, ACTOR, { path: "uploads/a.csv" });
    expect(
      await failure(
        gateway.readFile(COMPUTER, BOT, ACTOR, { path: "uploads/a.csv" }),
      ),
    ).toBeInstanceOf(ActionRefusedError);
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
    // And that does not rest on the reference being well formed: one with no server before a
    // slash, or no slash, or nothing in it, is still not nobody's.
    for (const ref of ["", "/", "/run_script", "run_script", "x"]) {
      expect({
        ref,
        same:
          callFingerprintOf({ botId: BOT, ref, args: {} }) ===
          fingerprintOf({
            botId: BOT,
            toolName: toolNameFor(ref),
            arguments: {},
          }),
      }).toEqual({ ref, same: false });
    }
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
 *
 * WHO READS WHAT NOW (the rebase onto the path a rule judges, #125). A rule no longer judges a
 * path as written: `govern` reads every path once — trimmed, `.` and empty segments gone — and
 * the computer is sent that string. A run's files go through that reading like the Bot's own
 * read: the same spellings are judged as the file they name, and a rule about the file REFUSES
 * them, with a row that names it — where the first fix of this refused them unread and unsaid,
 * and its first rebase did still. A path with no one reading at all — a backslash — is the
 * gateway's to refuse, with a row. In front of the real workspace still, now through the
 * server's own client and the computer's own route handlers (`support/script-run.ts`,
 * `realComputer`); the same held over every spelling there is a list of is the describe at the
 * foot of this file.
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

  test("a file a rule denies is not read for a script by writing its path with a space, a tab or a line's end: the rule refuses it, by name", async () => {
    const leaked: string[] = [];
    for (const rule of RULES) {
      for (const path of SPELLINGS) {
        const { gateway, rows, sent, computer } = overTheDisk(denying(rule));
        const error = (await failure(
          gateway.runScript(COMPUTER, BOT, ACTOR, {
            script: SCRIPT,
            files: [path],
          }),
        )) as ActionRefusedError;
        const held = sent.flatMap((request) =>
          request.files.map((file) => new TextDecoder().decode(file.bytes)),
        );
        if (held.length > 0) leaked.push(`${rule} / ${JSON.stringify(path)}`);
        // Judged as the file it names, whatever was written around the name: the rule's own
        // refusal, on a row that says which file and for which script — and nothing read.
        expect({
          rule,
          path,
          refused: error instanceof ActionRefusedError,
          code: error.code,
        }).toEqual({ rule, path, refused: true, code: "laf:policy_denied" });
        expect(rows.map((row) => row.eventType)).toEqual([
          "computer.action_refused",
        ]);
        expect(rows[0]?.payload).toMatchObject({
          action: "computer_read_file",
          file: "private/payroll.csv",
          forScript: sha256(SCRIPT),
          decision: { allowed: false, rule, code: "laf:policy_denied" },
        });
        expect(computer.asked).toEqual([]);
      }
    }
    // On the code as the first read found it, it was most of them: the payroll file's own bytes,
    // in what the sandbox was sent.
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

  /*
   * WHAT NO RULE CAN BE ASKED ABOUT IS THE GATEWAY'S TO REFUSE, AND IT LEAVES A ROW (#125:
   * `addresses.ts`, `hasNoOneReading`). The computer reads a backslash as a separator and writes
   * it as a letter; white space at the edge of a first or last name survives only behind a mark
   * (`./ private/…`, `…/payroll.csv /`). A run refused both before anything, as it refuses `..` —
   * with no row, which is not what the floor is for: the attempt belongs on the trail.
   */
  const NO_ONE_READING = [
    "private\\payroll.csv",
    "\\private/payroll.csv",
    "private/payroll.csv\\",
    "./ private/payroll.csv",
    "private/payroll.csv /",
    "private/payroll.csv /.",
  ];

  test("a file named by a path with no one reading is refused with a row, and never read — whatever the policy allows", async () => {
    for (const path of NO_ONE_READING) {
      const { gateway, rows, sent, computer } = overTheDisk(PERMISSIVE);
      const error = (await failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, {
          script: SCRIPT,
          files: [path],
        }),
      )) as ActionRefusedError;
      expect({ path, refused: error instanceof ActionRefusedError }).toEqual({
        path,
        refused: true,
      });
      expect(error.code).toBe("laf:file_path_refused");
      // One row: the read, refused, under the string as it was written — there is no other —
      // and for which script.
      expect(rows.map((row) => row.eventType)).toEqual([
        "computer.action_refused",
      ]);
      expect(rows[0]?.payload).toMatchObject({
        action: "computer_read_file",
        file: path,
        forScript: sha256(SCRIPT),
        decision: { allowed: false, code: "laf:file_path_refused" },
      });
      expect(computer.asked).toEqual([]);
      expect(sent).toEqual([]);
    }
  });

  test("what that costs, said: a file named ahead of such a path has been read by the time it is refused, and no code runs", async () => {
    const { gateway, rows, sent, computer } = overTheDisk(PERMISSIVE);
    const error = await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: SCRIPT,
        files: ["private/payroll.csv", "private\\payroll.csv"],
      }),
    );
    expect(error).toBeInstanceOf(ActionRefusedError);
    expect(
      rows.map((row) => `${row.eventType} ${String(row.payload.file)}`),
    ).toEqual([
      "computer.action_allowed private/payroll.csv",
      "computer.action_refused private\\payroll.csv",
    ]);
    expect(computer.asked).toEqual(["fileBytes private/payroll.csv"]);
    expect(sent).toEqual([]);
  });

  test("a file a script calls `tool2.exe ` is not filed as `tool2.exe`, a name it did not give: its answer is not vouched for", async () => {
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

  /*
   * A FILE CALLED `made` (the second read). Where the folder for what programs make belongs,
   * something had put a file — a Bot's own write will do it. Every file of every run after that
   * was decided, dialled for and failed (`laf:file_wrong_kind`), a failed row apiece, for good:
   * nothing here removes a file. One row says it now, of all of them, and nothing is tried. Not
   * the ending's own row: that one is written before the folder is looked at (see "how a run
   * ended is on the trail before the computer is asked anything", above).
   */
  test("a file where made/ belongs: one row says so with a fact of its own and names every file, none is tried, and what is there is left as it was", async () => {
    const { gateway, root, rows, computer } = overTheDisk(PERMISSIVE, () =>
      made(["report.csv", "r"], ["notes.txt", "n"]),
    );
    writeFileSync(join(root, "made"), "a file, where the folder belongs");

    const run = await gateway.runScript(COMPUTER, BOT, ACTOR, {
      script: SCRIPT,
      files: [],
    });

    expect(run.exitCode).toBe(0);
    expect(run.products).toEqual([
      { name: "report.csv", bytes: 1, unfiled: "laf:made_not_a_folder" },
      { name: "notes.txt", bytes: 1, unfiled: "laf:made_not_a_folder" },
    ]);
    // Three rows: the run, how it ended, and the one that names both files and says why neither
    // was tried. No decision and no failed row for either file.
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
      "computer.script_finished",
      "computer.script_files_left",
    ]);
    expect(rows[1]?.payload).toMatchObject({
      products: [
        { name: "report.csv", bytes: 1 },
        { name: "notes.txt", bytes: 1 },
      ],
    });
    expect(rows[2]?.payload).toEqual({
      action: RUN_SCRIPT_TOOL,
      bot: BOT,
      actor: ACTOR.id,
      script: { sha256: sha256(SCRIPT), bytes: Buffer.byteLength(SCRIPT) },
      because: "laf:made_not_a_folder",
      left: [
        { name: "report.csv", bytes: 1 },
        { name: "notes.txt", bytes: 1 },
      ],
    });
    expect(computer.asked).toEqual(["listFiles made"]);
    expect(readFileSync(join(root, "made"), "utf8")).toBe(
      "a file, where the folder belongs",
    );
  });

  /*
   * A STOP THAT ARRIVES WHILE THE FOLDER IS BEING DESCRIBED (Codex, on the pull request). The
   * look at `made/` cannot be handed the caller's Stop — the computer's listing takes none — so
   * a Stop during it is seen only when it answers. Where it answered "that is not a folder",
   * the call went on to say so of every file and RETURNED: a call somebody had stopped,
   * reported as one that completed. It ends as a stopped call ends, whatever the computer went
   * on to say of the folder — as it already did where the folder was there.
   */
  test("a Stop while made/ is being looked at ends the call as stopped, whatever the computer goes on to say of the folder", async () => {
    const answers: [string, () => never | { entries: []; truncated: false }][] =
      [
        [
          "a file is there",
          () => {
            throw new WorkspaceRequestError("laf:file_wrong_kind");
          },
        ],
        [
          "nothing is there",
          () => {
            throw new WorkspaceRequestError("laf:file_not_found");
          },
        ],
        ["an empty folder is there", () => ({ entries: [], truncated: false })],
      ];
    for (const [said, answer] of answers) {
      const stop = new AbortController();
      const computer = fakeComputer();
      const audit = fakeAudit();
      const client = {
        ...computer.client,
        forBot: () => client,
        listFiles: async (input: { path?: string }) => {
          // The Stop lands while the computer is still describing the folder; then it answers.
          stop.abort();
          return { path: input.path ?? ".", ...answer() };
        },
      } as typeof computer.client;
      const gateway = createComputerGateway({
        client,
        auditStore: audit.store,
        policy: () => PERMISSIVE,
        workbench: fakeWorkbench(() =>
          made(["report.csv", "r"], ["notes.txt", "n"]),
        ).workbench,
        now: () => AT,
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

      expect({ said, ended: (error as Error).message }).toEqual({
        said,
        ended: "laf:stopped",
      });
      // The run, how it ended, and both files named as left — by the Stop, which is what ended
      // the call. Nothing was decided of either, and nothing was put.
      expect(audit.rows.map((row) => row.eventType)).toEqual([
        "computer.action_allowed",
        "computer.script_finished",
        "computer.script_files_left",
      ]);
      expect(audit.rows.at(-1)?.payload).toMatchObject({
        because: "laf:stopped",
        left: [
          { name: "report.csv", bytes: 1 },
          { name: "notes.txt", bytes: 1 },
        ],
      });
      expect([...computer.files.keys()]).toEqual([]);
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

  /*
   * THE CLASS, NOT FIVE RANGES OF IT (the second read of this change). "A name that draws as
   * another" was held by the ranges somebody thought of — zero-width characters, the bidi
   * overrides, the BOM — and the same trick has more spellings than that: a soft hyphen, a
   * Hangul filler (which is a LETTER to Unicode, and draws as nothing), a variation selector, a
   * tag, an Arabic letter mark. Each of these was a name. And so was half a character, which is
   * not text at all: the call died of it after the script had run (`encodeURIComponent` in the
   * computer's client), with the files after it never tried and the caller told nothing.
   */
  const NOT_NAMES: [string, string][] = [
    ["a soft hyphen at its end", "tool.exe\u00ad"],
    ["a soft hyphen inside", "tool.e\u00adxe"],
    ["the soft-hyphen twin of a zero-width name", "to\u00adtals.csv"],
    ["a Mongolian vowel separator", "tool.exe\u180e"],
    ["a Hangul filler at its end", "tool.exe\u3164"],
    ["nothing but a Hangul filler", "\u3164"],
    ["a Hangul jamo filler", "a\u1160b.csv"],
    ["a halfwidth Hangul filler", "a\uffa0b.csv"],
    ["a variation selector", "tool.exe\ufe0f"],
    ["a combining grapheme joiner", "tool.exe\u034f"],
    ["an Arabic letter mark", "tool.exe\u061c"],
    ["a tag character", "tool.exe\u{e0020}"],
    ["a byte-order mark INSIDE it", "tot\ufeffals.csv"],
    ["a line separator inside it", "a\u2028b.csv"],
    ["a private-use character", "a\ue000b.csv"],
    ["half a character, the first half", "b\ud800.txt"],
    ["half a character, the second half", "\udc00a.txt"],
    // What holding the class costs, said: these are honest names somewhere, and are refused.
    ["an emoji with a variation selector", "\u2764\ufe0f.txt"],
    ["an emoji joined to another", "\u{1f468}\u200d\u{1f469}.txt"],
  ];
  const NAMES_STILL: [string, string][] = [
    ["Korean", "요일별 매출 v1.2.csv"],
    ["Korean written as its parts", "\u1100\u1161\u1102\u1161.txt"],
    ["Korean letters on their own", "ㄱㄴㄷ.txt"],
    ["spaces inside", "a b  c.txt"],
    ["ordinary punctuation", "a-b_c (1), [x] & y's #2 +=~!@$%^{}.csv"],
    ["what only Windows refuses", 'a:b?c*d<e>f|g".txt'],
    ["an emoji that is one character", "\u{1f4ca} report.csv"],
    ["an ideographic space inside", "a\u3000b.txt"],
    ["Japanese", "売上レポート.xlsx"],
    ["accents and a dash", "résumé – final.docx"],
  ];

  test("a name is held to the class of what draws as another — or is not text — by what Unicode says each character is", () => {
    expect(
      NOT_NAMES.filter(([, name]) => isProductName(name)).map(([what]) => what),
    ).toEqual([]);
    expect(
      NAMES_STILL.filter(([, name]) => !isProductName(name)).map(
        ([what]) => what,
      ),
    ).toEqual([]);
  });

  test("an answer that names a file by half a character, or by a name with a soft hyphen in it, is not a run to vouch for — and nothing is filed", async () => {
    for (const name of ["b\ud800.txt", "to\u00adtals.csv", "tool.exe\u3164"]) {
      const { gateway, root, rows, computer } = overTheDisk(PERMISSIVE, () =>
        made(["report.csv", "r"], [name, "x"]),
      );
      const error = (await failure(
        gateway.runScript(COMPUTER, BOT, ACTOR, { script: SCRIPT, files: [] }),
      )) as ScriptNotRunError;
      expect({
        name,
        error: error.constructor.name,
        code: error.code,
      }).toEqual({
        name,
        error: "ScriptNotRunError",
        code: "laf:workbench_failed",
      });
      expect(rows.at(-1)?.payload.failure).toBe("laf:workbench_failed");
      expect(computer.asked).toEqual([]);
      expect(existsSync(join(root, "made"))).toBe(false);
    }
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

/*
 * ONE READING OF EVERY PATH A RUN SENDS, AND IT IS `govern`'S (the rebase onto the path a rule
 * judges, #125: `addresses.ts`, `workspacePathOf`). Since that change every file path is read
 * once, there, and the act is handed the string to send. A run meets it three ways: the files
 * its call names, the folder this server names for what it made, and the names a script gave
 * its files. For each, what a run SENDS has to be a string that reading leaves exactly as it is
 * — or the rule would be asked about one path, the script handed a file under another and the
 * caller told a third. For a file a call names that is so because the act sends what `govern`
 * hands back; for the folder and the names, by how they are held and composed. This is where
 * each is ASSERTED rather than assumed, over spellings by the thousand, as that change's own
 * tests are — and the describe after this one holds the first of them in front of the disk.
 */
describe("every path a run sends has one reading, and is its own spelling", () => {
  /** Every way a model, a slip or a script that wants a rule walked past might write one path. */
  function spellingsOf(core: string): string[] {
    const before = [
      "",
      " ",
      "\t",
      "\n",
      " ",
      "　",
      "./",
      "./ ",
      " ./",
      ".//",
      "/",
      "../",
      "\\",
      ".\\",
    ];
    const after = [
      "",
      " ",
      "\n",
      "\r\n",
      " ",
      "　",
      "/",
      "/.",
      "/./",
      " /",
      " /.",
      "/ ",
      "/..",
      "\\",
      "\\.",
      "\0",
    ];
    return before.flatMap((head) =>
      after.map((tail) => `${head}${core}${tail}`),
    );
  }
  const PATHS = [
    "private/pay.csv",
    "private//pay.csv",
    "private/./pay.csv",
    "private\\pay.csv",
    " private/pay.csv",
    "private/pay.csv ",
    "private / pay.csv",
    "uploads/2026-10-06-1a2b3c4d-매출.xlsx",
    "made/2026-10-07-0a1b2c3d/요일별 매출 v1.2.csv",
    "a",
    ".env",
    "d/ a.csv",
    "d /a.csv",
  ].flatMap(spellingsOf);

  /*
   * WHAT `govern` HANDS BACK IS WHAT IS SENT. Every path that reaches the act is its own spelling
   * (the tests below), so over the real `govern` the path it hands back and the one it was given
   * are one string, and nothing in front of it can tell an act that sends the first from one
   * that sends the second — the fault that parameter exists to end. So here, and only here,
   * `govern` is a stand-in: one that marks every path it is given, as a reading that changed it
   * would. What is asserted is which of the two strings went on.
   */
  test("the act sends what `govern` hands it — to the computer, to the script, in the run's own name, and for a file it made", async () => {
    const governed: { tool: string; subject: Record<string, unknown> }[] = [];
    const govern = (async (
      _computerId: string,
      tool: string,
      _botId: string,
      _actor: unknown,
      subject: Record<string, unknown>,
      run: (judged: undefined, judgedPath: string | undefined) => unknown,
    ) => {
      governed.push({ tool, subject });
      return run(
        undefined,
        typeof subject.filePath === "string"
          ? `as-judged/${subject.filePath}`
          : undefined,
      );
    }) as unknown as Parameters<typeof createActs>[0]["govern"];
    const computer = fakeComputer({
      "as-judged/uploads/a.csv": bytes("1"),
    });
    const bench = fakeWorkbench(() => made(["out.csv", "x"]));
    const acts = createActs({
      as: (botId) => computer.client.forBot(botId),
      govern,
      auditStore: fakeAudit().store,
      workbench: bench.workbench,
      now: () => AT,
    });
    const run = await acts.runScript(
      COMPUTER,
      BOT,
      { ...ACTOR, toolCallId: "call-1" },
      { script: SCRIPT, files: ["uploads/a.csv"] },
    );

    // The run is named by the file as it was read, and its folder follows from that name.
    const folder = folderOf({
      toolCallId: "call-1",
      files: ["as-judged/uploads/a.csv"],
    });
    expect(
      governed.map(({ tool, subject }) => [
        tool,
        subject.filePath ?? (subject.script as { files: string[] }).files,
      ]),
    ).toEqual([
      ["computer_read_file", "uploads/a.csv"],
      [RUN_SCRIPT_TOOL, ["as-judged/uploads/a.csv"]],
      ["computer_write_file", `${folder}/out.csv`],
    ]);
    expect(computer.asked).toEqual([
      "fileBytes as-judged/uploads/a.csv",
      "listFiles made",
      `putFile as-judged/${folder}/out.csv`,
    ]);
    expect(bench.sent[0]?.files.map((file) => file.path)).toEqual([
      "as-judged/uploads/a.csv",
    ]);
    expect(run.products).toEqual([
      { name: "out.csv", bytes: 1, path: `as-judged/${folder}/out.csv` },
    ]);
  });

  /*
   * NOTHING ABOUT HOW A PATH IS WRITTEN IS JUDGED BEFORE `govern` (reversed 2026-10-07, before
   * this change's second read: its first rebase still refused a spelled path at the request, in
   * silence). Every string of a path's length goes on, and what becomes of it is that reading's:
   * one spelling, no one reading, or no path at all. What a run adds is the script — so for the
   * first kind, the string the file is STAGED under is that one spelling, and it has to be a path
   * the sandbox takes (`isRunPath`, which the gateway no longer asks: its client does, unsent).
   */
  test("no string a call names is refused before `govern` for how it is written, and what a spelled one is staged under is a path the sandbox takes", () => {
    const wrong: string[] = [];
    let spelled = 0;
    let forTheFloor = 0;
    let noPath = 0;
    for (const path of [...PATHS, ...EVERY_SPELLING, ...NOT_A_PATH, "", " "]) {
      if (requestProblem({ script: SCRIPT, files: [path] }) !== null) {
        wrong.push(`refused before govern: ${JSON.stringify(path)}`);
      }
      const staged = workspacePathOf(path);
      if (hasNoOneReading(path)) forTheFloor += 1;
      else if (staged === null) noPath += 1;
      else {
        spelled += 1;
        // Its own spelling — read again, it is the same string — and, but for the folder
        // itself, which is not a file and is never staged, a path the daemon places.
        if (workspacePathOf(staged) !== staged || hasNoOneReading(staged)) {
          wrong.push(`staged under what is not a spelling: ${staged}`);
        }
        if (!isRunPath(staged) && staged !== ".") {
          wrong.push(`staged under what the sandbox refuses: ${staged}`);
        }
      }
    }
    expect(wrong).toEqual([]);
    // Each of the three is most of nothing unless it is some of these.
    expect(spelled).toBeGreaterThan(500);
    expect(forTheFloor).toBeGreaterThan(500);
    expect(noPath).toBeGreaterThan(300);
  });

  test("a file named twice is named once: by one string, or by any two spellings of one path", () => {
    const once = (files: string[]) => filesNamedBy({ script: SCRIPT, files });
    expect(once(["uploads/a.csv", "uploads/a.csv"])).toEqual(["uploads/a.csv"]);
    // The first way it was written is the one handed to `govern`, which reads it.
    expect(
      once([
        "./uploads/a.csv",
        "uploads/a.csv",
        " uploads//a.csv ",
        "uploads/./a.csv/",
        "uploads/b.csv",
      ]),
    ).toEqual(["./uploads/a.csv", "uploads/b.csv"]);
    // Every spelling of the payroll that has one is the payroll, once.
    const payroll = EVERY_SPELLING.filter(
      (path) => workspacePathOf(path) === "private/pay.csv",
    );
    expect(payroll.length).toBeGreaterThan(100);
    expect(once(payroll)).toEqual([payroll[0] as string]);
    // What has no spelling stands as it was written, each string a thing of its own.
    expect(once(["a\\b", "a\\b", "../x", "../x", "..", ""])).toEqual([
      "a\\b",
      "../x",
      "..",
      "",
    ]);
  });

  const DIRECTORY = madeDirectoryFor(AT, {
    botId: BOT,
    threadId: "thread-1",
    toolCallId: "call_1",
    sha256: sha256(SCRIPT),
    files: ["uploads/2026-10-06-1a2b3c4d-매출.xlsx"],
  });
  /** Names a script might give a file: plain ones, and each dressed at either end. */
  const NAMES = [
    "totals.csv",
    "요일별 매출 v1.2.csv",
    "tool2.exe",
    "a b",
    "견적_10000.txt",
    "x",
    "..",
    ".",
    "",
    "   ",
  ].flatMap((name) =>
    ["", " ", "\t", " ", ".", "./", "\\", "/"].flatMap((head) =>
      ["", " ", "\n", "　", ".", "/", "/.", "\\", " /"].map(
        (tail) => `${head}${name}${tail}`,
      ),
    ),
  );

  test("the folder this server names for a run's files is its own spelling, whoever called", () => {
    expect(DIRECTORY).toMatch(/^made\/2026-10-07-[0-9a-f]{8}$/);
    for (const directory of [
      DIRECTORY,
      // With no call behind it, and with no conversation: a folder of its own.
      madeDirectoryFor(AT, { botId: BOT, sha256: sha256(SCRIPT), files: [] }),
      madeDirectoryFor(AT, {
        botId: BOT,
        toolCallId: "call 1\\/../ ",
        sha256: sha256(SCRIPT),
        files: [" a", "b\\c"],
      }),
    ]) {
      expect(workspacePathOf(directory)).toBe(directory);
      expect(hasNoOneReading(directory)).toBe(false);
    }
  });

  test("a file a script made is filed at the path this server composed: every name that is one composes to its own spelling", () => {
    const wrong: string[] = [];
    let names = 0;
    for (const name of NAMES) {
      if (!isProductName(name)) continue;
      names += 1;
      const path = `${DIRECTORY}/${name}`;
      if (hasNoOneReading(path) || workspacePathOf(path) !== path) {
        wrong.push(JSON.stringify(name));
      }
    }
    expect(wrong).toEqual([]);
    // Exactly: ten names, each dressed eight ways at one end and nine at the other — and of
    // those seven hundred and twenty, the twelve that are still a name afterwards. A floor of
    // "more than five" stood here, under a comment that said seven hundred and twenty.
    expect(NAMES.length).toBe(720);
    expect(names).toBe(12);
  });

  /*
   * WHY A NAME IS HELD TO WHAT A NAME IS BEFORE IT IS PART OF A PATH, now that a path is read in
   * one place: that reading does not REFUSE these, it SPELLS them — into another file's name, or
   * into the folder itself, which is where a name of three spaces was written as a file (the
   * independent read of the script act). A rule would be asked about that path, and it would be
   * the path written: one reading, of a name the script never gave.
   */
  test("what the one reading would do with a name that is not one: spell it into another file's, or into the folder", () => {
    expect(workspacePathOf(`${DIRECTORY}/tool2.exe `)).toBe(
      `${DIRECTORY}/tool2.exe`,
    );
    expect(hasNoOneReading(`${DIRECTORY}/tool2.exe `)).toBe(false);
    for (const name of ["   ", ".", "./", "\t"]) {
      expect(workspacePathOf(`${DIRECTORY}/${name}`)).toBe(DIRECTORY);
    }
    expect(workspacePathOf(`${DIRECTORY}/a/b.txt`)).toBe(
      `${DIRECTORY}/a/b.txt`,
    );
    for (const name of ["tool2.exe ", "   ", ".", "./", "\t", "a/b.txt"]) {
      expect({ name, taken: isProductName(name) }).toEqual({
        name,
        taken: false,
      });
    }
  });

  /*
   * A FILE A SCRIPT CALLS `a\b.txt` IS REFUSED ALONE, AT THE SOURCE (decided at that rebase). The
   * daemon leaves it where the script put it and counts it, and hands back the files beside it
   * (`tests/workbench-daemon.test.ts`); an answer that names one is not that daemon's, and the
   * client and the act above pass none of it on. And behind both, the one thing of a name's rule
   * the gateway's floor covers too: the path it would compose has no one reading, so `govern`
   * would refuse that file's write itself, with a row. `견적_\10000.txt` is a name a person can
   * mean — the ₩ key types that character.
   */
  test("a file a script names with a backslash is not a name, and the path it would make is one the floor refuses", () => {
    for (const name of ["a\\b.txt", "견적_\\10000.txt", "\\a", "a\\"]) {
      expect({ name, taken: isProductName(name) }).toEqual({
        name,
        taken: false,
      });
      expect(hasNoOneReading(`${DIRECTORY}/${name}`)).toBe(true);
      expect(workspacePathOf(`${DIRECTORY}/${name}`)).toBeNull();
    }
  });
});

/*
 * A FILE A CALL NAMES FOR A RUN IS READ AS THE BOT'S OWN READ IS — whatever way its path was
 * written (reversed 2026-10-07, before this change's second read). A run had refused a path that
 * was not written in its one spelling before anything, with no row: so a spelling tried against
 * a denied file left nothing on the trail through a run, where the same string through
 * `computer_read_file` leaves a refused row naming the file; and `./data.csv`, which is how a
 * model writes a file's name, was a refused call. Now every string goes through `govern`: judged
 * under its one spelling, read from the computer under it, and STAGED for the script under it.
 *
 * In front of the real workspace, through the server's own client and the computer's own route
 * handlers, over the folder, the spellings and the rules `gateway-file-paths.test.ts` is held by
 * (`support/path-spellings.ts`) — every file with contents of its own, so that what reached the
 * script says WHICH file was read.
 */
describe("a file a call names for a run, however its path is written", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wg-spell-"));
    for (const [file, contents] of FOLDER_FILES) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), contents);
    }
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The gateway over that folder: the real computer, a sandbox that records, a trail that lists.
   * `through` puts something else where the recording sandbox is.
   */
  function overTheFolder(policy: ActionPolicy, through?: Workbench) {
    const computer = realComputer(root);
    const bench = fakeWorkbench();
    const audit = fakeAudit();
    const gateway = createComputerGateway({
      client: computer.client,
      auditStore: audit.store,
      policy: () => policy,
      workbench: through ?? bench.workbench,
      now: () => AT,
    });
    /** One run naming these files, and everything that came of THAT call. */
    const run = async (files: string[]) => {
      const rowsBefore = audit.rows.length;
      const sentBefore = bench.sent.length;
      const askedBefore = computer.asked.length;
      let ended: Awaited<ReturnType<typeof gateway.runScript>> | undefined;
      let threw: Error | undefined;
      try {
        ended = await gateway.runScript(COMPUTER, BOT, ACTOR, {
          script: SCRIPT,
          files,
        });
      } catch (error) {
        threw = error as Error;
      }
      const written = audit.rows.slice(rowsBefore);
      return {
        ended,
        threw,
        // What was decided and what came of it. "The same call again" is an observation the
        // trail keeps beside those, and is handed back apart.
        rows: written.filter(
          (row) => row.eventType !== "computer.action_repeated",
        ),
        repeated: written.filter(
          (row) => row.eventType === "computer.action_repeated",
        ),
        staged: bench.sent
          .slice(sentBefore)
          .flatMap((request) => request.files)
          .map((file) => ({
            path: file.path,
            holds: new TextDecoder().decode(file.bytes),
          })),
        asked: computer.asked.slice(askedBefore),
      };
    };
    return { run };
  }

  test("a deny on a file holds through a run under every spelling of it, the refused row names the file, and no attempt is unsaid", async () => {
    let namedThePayroll = 0;
    for (const rule of PAYROLL_RULES) {
      const { run } = overTheFolder(denying(rule));
      for (const path of EVERY_SPELLING) {
        const { threw, rows, staged } = await run([path]);
        const said = `${rule} · ${JSON.stringify(path)}`;
        // The denied file's bytes are in nothing a script was handed.
        expect(
          `${said} · ${staged.map((file) => file.holds).join(" | ")}`,
        ).not.toContain(PAYROLL);
        // And whatever came of the attempt, the trail has it.
        expect({ said, rows: rows.length > 0 }).toEqual({ said, rows: true });
        if (workspacePathOf(path) !== "private/pay.csv") continue;
        namedThePayroll += 1;
        // A spelling of the payroll's own path: the rule's refusal, on one row, by the file's
        // one name — whatever was written around it.
        expect({
          said,
          refused: threw instanceof ActionRefusedError,
          code: (threw as ActionRefusedError | undefined)?.code,
        }).toEqual({ said, refused: true, code: "laf:policy_denied" });
        expect({
          said,
          rows: rows.map(
            (row) => `${row.eventType} ${String(row.payload.file)}`,
          ),
        }).toEqual({
          said,
          rows: ["computer.action_refused private/pay.csv"],
        });
        expect(rows[0]?.payload.forScript).toBe(sha256(SCRIPT));
      }
    }
    // Four rules, and well over a hundred ways of writing that one path under each.
    expect(namedThePayroll).toBeGreaterThan(400);
    expect(EVERY_SPELLING.length).toBeGreaterThan(2500);
  });

  test("allowed, every spelling hands the script the file the computer reads for it, under its one spelling — and the row, the run's own name and what the caller is told agree", async () => {
    const { run } = overTheFolder(PERMISSIVE);
    /** What each file a Bot can name holds, by its one spelling. */
    const holds: Record<string, string> = {
      "private/pay.csv": PAYROLL,
      ".env": SECRET,
      "notes/a.md": NOTE,
    };
    const handed: Record<string, number> = {};
    /** How often the trail said "the same call again", and of what. */
    const again: string[] = [];
    for (const path of EVERY_SPELLING) {
      const { ended, threw, rows, repeated, staged, asked } = await run([path]);
      const said = JSON.stringify(path);
      again.push(...repeated.map((row) => String(row.payload.action)));
      const spelling = workspacePathOf(path);
      if (!ended) {
        // No run: a path with no one reading, a folder, or a file that is not there. Nothing
        // was staged, and the trail says what became of the attempt.
        expect({ said, staged, rows: rows.length > 0 }).toEqual({
          said,
          staged: [],
          rows: true,
        });
        expect({
          said,
          named: (threw?.message ?? "").startsWith("laf:"),
        }).toEqual({ said, named: true });
        continue;
      }
      // A run: of the one file that spelling names, and of no other.
      expect({ said, known: spelling !== null && spelling in holds }).toEqual({
        said,
        known: true,
      });
      const file = spelling as string;
      handed[file] = (handed[file] ?? 0) + 1;
      expect({ said, staged }).toEqual({
        said,
        staged: [{ path: file, holds: holds[file] as string }],
      });
      // One name for it everywhere: what the computer was asked for, the read's row, the run's
      // own row, and what the caller is told its file is called.
      expect({ said, asked }).toEqual({ said, asked: [`fileBytes ${file}`] });
      expect({
        said,
        rows: rows.map((row) => [
          row.eventType,
          row.payload.file ?? row.payload.files ?? null,
        ]),
      }).toEqual({
        said,
        rows: [
          ["computer.action_allowed", file],
          ["computer.action_allowed", [file]],
          ["computer.script_finished", null],
        ],
      });
      expect({ said, told: ended.files }).toEqual({ said, told: [file] });
    }
    // Each of the three was reached, and by more than its own plain name.
    expect(Object.keys(handed).sort()).toEqual(Object.keys(holds).sort());
    for (const count of Object.values(handed)) {
      expect(count).toBeGreaterThan(20);
    }
    /*
     * AND A SPELLING DOES NOT MAKE IT ANOTHER RUN. One script over one file, named a hundred
     * ways, is the same run a hundred times to the count — which is kept on the run, by the
     * files as they were read — and the trail said so as it went. The reads were never counted
     * (`forScript`): the only thing that came round again here is the run.
     */
    expect(again.length).toBeGreaterThan(3);
    expect(new Set(again)).toEqual(new Set([RUN_SCRIPT_TOOL]));
  });

  test("the same file named twice — by one string or by several spellings — is judged once, read once and staged once", async () => {
    const { run } = overTheFolder(PERMISSIVE);
    const { ended, rows, staged, asked } = await run([
      "./private/pay.csv",
      "private/pay.csv",
      " private//pay.csv ",
      "private/./pay.csv/",
      "notes/a.md",
      "notes/a.md",
    ]);
    expect(staged).toEqual([
      { path: "private/pay.csv", holds: PAYROLL },
      { path: "notes/a.md", holds: NOTE },
    ]);
    expect(asked).toEqual([
      "fileBytes private/pay.csv",
      "fileBytes notes/a.md",
    ]);
    expect(
      rows.map((row) => [
        row.eventType,
        row.payload.file ?? row.payload.files ?? null,
      ]),
    ).toEqual([
      ["computer.action_allowed", "private/pay.csv"],
      ["computer.action_allowed", "notes/a.md"],
      ["computer.action_allowed", ["private/pay.csv", "notes/a.md"]],
      ["computer.script_finished", null],
    ]);
    expect(ended?.files).toEqual(["private/pay.csv", "notes/a.md"]);
  });

  /*
   * ONE ANSWER A CALL IS WHY A FILE IS NAMED ONCE BEFORE `govern` AND NOT AFTER. Two decisions
   * about one file are bound to one answer: the first spends a person's yes and the second asks
   * again, on every attempt.
   */
  test("where a rule asks about a file, a call that names it twice is one question, and one yes gets it through", async () => {
    const computer = realComputer(root);
    const bench = fakeWorkbench();
    const approvals = createApprovalRegistry();
    const gateway = createComputerGateway({
      client: computer.client,
      auditStore: fakeAudit().store,
      policy: () => asking('file.name == "pay.csv"'),
      approvals,
      workbench: bench.workbench,
      now: () => AT,
    });
    const input = {
      script: SCRIPT,
      files: ["./private/pay.csv", "private/pay.csv "],
    };
    const asked = (await failure(
      gateway.runScript(COMPUTER, BOT, ACTOR, input),
    )) as ActionNeedsApprovalError;
    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(asked.subject).toMatchObject({
      intent: "read_file",
      file: { path: "private/pay.csv" },
    });
    await approvals.answer(asked.approvalId, BOT, MANAGER.id, true);
    const run = await gateway.runScript(
      COMPUTER,
      BOT,
      ACTOR,
      input,
      undefined,
      asked.approvalId,
    );
    expect(run.files).toEqual(["private/pay.csv"]);
    expect(bench.sent).toHaveLength(1);
  });

  test("what is no path at all is judged as written and refused by the computer it is sent to: two rows, and nothing staged", async () => {
    const { run } = overTheFolder(PERMISSIVE);
    for (const [path, fact] of [
      ...NOT_A_PATH.map((none) => [none, "laf:file_path_refused"] as const),
      // Nothing named at all: the computer's own word for a request that names no file.
      ["", "laf:request_invalid"] as const,
      ["   ", "laf:request_invalid"] as const,
    ]) {
      const { ended, threw, rows, staged, asked } = await run([path]);
      const said = JSON.stringify(path);
      expect({ said, ran: ended !== undefined, fact: threw?.message }).toEqual({
        said,
        ran: false,
        fact,
      });
      // Allowed, and it did not happen — which is what it always was for the Bot's own read.
      expect({ said, rows: rows.map((row) => row.eventType) }).toEqual({
        said,
        rows: ["computer.action_allowed", "computer.action_failed"],
      });
      expect({ said, failure: rows[1]?.payload.failure }).toEqual({
        said,
        failure: fact,
      });
      expect(rows[1]?.payload.forScript).toBe(sha256(SCRIPT));
      // Sent as it was written — there is no other way to write it — and never to a script.
      expect({ said, asked }).toEqual({ said, asked: [`fileBytes ${path}`] });
      expect(staged).toEqual([]);
    }
  });

  /*
   * WHAT IS LEFT FOR THE SANDBOX'S OWN RULE TO SAY, now that the gateway asks it nothing: how
   * deep a path may go (`isRunPath`, `RUN_PATH_SEGMENTS`). A file that many folders down is a
   * file — judged, read, with its row — and one the daemon will not place. That is the client's
   * to find, unsent (`workbench/client.ts`, `wrongPartOf`), so this one test has the sandbox's
   * REAL client where the others have a recorder: a stand-in takes whatever it is handed. No
   * daemon is at its socket, and none is needed — the request never leaves.
   */
  test("a file deeper than the sandbox places is read, and then is not a run: said on the run's own row, with nothing sent", async () => {
    const deep = `${Array.from({ length: 16 }, (_, depth) => `d${depth}`).join("/")}/deep.csv`;
    mkdirSync(join(root, deep, ".."), { recursive: true });
    writeFileSync(join(root, deep), "x");
    expect(isRunPath(deep)).toBe(false);
    expect(workspacePathOf(deep)).toBe(deep);
    const sockets = mkdtempSync(join(tmpdir(), "wg-nobody-"));
    try {
      const { run } = overTheFolder(
        PERMISSIVE,
        createWorkbench({
          socketPath: join(sockets, "nobody-is-here.sock"),
          key: "a-key-for-tests-0123456789abcdef-0123456789",
          log: { svc: "test", info() {}, warn() {}, error() {} },
        }),
      );
      const began = performance.now();
      const { threw, rows, asked } = await run([`./${deep}`]);
      expect(threw).toBeInstanceOf(ScriptNotRunError);
      expect((threw as ScriptNotRunError).code).toBe(
        "laf:script_inputs_invalid",
      );
      expect((threw as ScriptNotRunError).facts).toEqual({ field: "files" });
      // Refused before the socket was dialled: with nobody there, a dial would have said
      // "unavailable", and after a wait.
      expect(performance.now() - began).toBeLessThan(1_000);
      expect(asked).toEqual([`fileBytes ${deep}`]);
      expect(
        rows.map((row) => `${row.eventType} ${String(row.payload.action)}`),
      ).toEqual([
        "computer.action_allowed computer_read_file",
        `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
        `computer.action_failed ${RUN_SCRIPT_TOOL}`,
      ]);
      expect(rows[0]?.payload.file).toBe(deep);
      expect(rows[2]?.payload.failure).toBe("laf:script_inputs_invalid");
    } finally {
      rmSync(sockets, { recursive: true, force: true });
    }
  });
});
