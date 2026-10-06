import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { REPEAT_RULE } from "../../shared/policy-rules";
import { WORKBENCH_LIMITS } from "../../shared/workbench/protocol";
import type { AuditEventInput, AuditFactCode, AuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import {
  type ComputerClient,
  ComputerUnavailableError,
  WorkspaceRequestError,
} from "../src/computer/client";
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
import type { SnapshotResult } from "../src/computer/schema";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { outcomeOfError } from "../src/runner/unattended";
import type {
  Workbench,
  WorkbenchAnswer,
  WorkbenchRequest,
} from "../src/workbench/client";

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
const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const id8 = (callId: string) =>
  createHash("sha256").update(callId).digest("hex").slice(0, 8);

/** A run that ended by itself with 0 and printed a line. */
const ENDED: Extract<WorkbenchAnswer, { ok: true }>["run"] = {
  ending: "exited",
  exitCode: 0,
  signal: null,
  ms: 412,
  stdout: "the total is 42\n",
  stderr: "",
  stdoutBytes: 16,
  stderrBytes: 0,
  skipped: 0,
};

const made = (...products: [string, string][]): WorkbenchAnswer => ({
  ok: true,
  run: ENDED,
  products: products.map(([name, text]) => ({ name, bytes: bytes(text) })),
});

/** The place a script runs, standing in: it records what it was sent and answers as told. */
function fakeWorkbench(
  answer: (
    request: WorkbenchRequest,
    signal: AbortSignal | undefined,
  ) => WorkbenchAnswer | Promise<WorkbenchAnswer> = () => made(),
) {
  const sent: WorkbenchRequest[] = [];
  const workbench: Workbench = {
    health: async () => ({ busy: false, boot: "fake" }),
    run: async (request, signal) => {
      sent.push(request);
      return answer(request, signal);
    },
  };
  return { workbench, sent };
}

/** The Bot's computer, standing in: a folder in memory, and a record of everything asked of it. */
function fakeComputer(
  folder: Record<string, Uint8Array> = {},
  options: {
    /** What the page it is parked on is, when a test looks at the screen first. */
    url?: string;
    /** What `made/` is said to hold already, in bytes; or that it cannot be described whole. */
    madeHolds?: number | "more than a listing describes";
    /** What a put is answered with instead of being taken. */
    refusePut?: (path: string) => Error | undefined;
  } = {},
) {
  const files = new Map(Object.entries(folder));
  /** Every call that reached the computer, by method and path, in order. */
  const asked: string[] = [];
  /** Which Bot each call was addressed as. */
  const addressedAs: string[] = [];
  const snapshot: SnapshotResult = {
    snapshotId: 1,
    url: options.url ?? "https://example.com/",
    title: "A page",
    truncated: false,
    elements: [{ ref: "e1", role: "button", name: "Submit order" }],
  };
  const client = {
    snapshot: async () => snapshot,
    click: async () => {
      asked.push("click");
      return { action: "click", url: snapshot.url, elapsedMs: 1 } as never;
    },
    async fileBytes(path: string) {
      asked.push(`fileBytes ${path}`);
      const found = files.get(path);
      if (!found) throw new WorkspaceRequestError("laf:file_not_found");
      return found;
    },
    async putFile(path: string, body: Uint8Array) {
      asked.push(`putFile ${path}`);
      const refused = options.refusePut?.(path);
      if (refused) throw refused;
      if (files.has(path)) throw new WorkspaceRequestError("laf:file_exists");
      files.set(path, body);
      return { path, kind: "file" as const, bytes: body.byteLength };
    },
    async listFiles(input: { path?: string }) {
      asked.push(`listFiles ${input.path ?? "."}`);
      const under = [...files].filter(([path]) =>
        path.startsWith(`${input.path}/`),
      );
      if (options.madeHolds === "more than a listing describes") {
        return { path: input.path ?? ".", entries: [], truncated: true };
      }
      if (typeof options.madeHolds === "number") {
        return {
          path: input.path ?? ".",
          entries: [
            { path: "made/earlier", kind: "folder" as const },
            {
              path: "made/earlier/old.xlsx",
              kind: "file" as const,
              bytes: options.madeHolds,
            },
          ],
          truncated: false,
        };
      }
      if (under.length === 0) {
        throw new WorkspaceRequestError("laf:file_not_found");
      }
      return {
        path: input.path ?? ".",
        entries: under.map(([path, held]) => ({
          path,
          kind: "file" as const,
          bytes: held.byteLength,
        })),
        truncated: false,
      };
    },
    forBot(botId: string) {
      addressedAs.push(botId);
      return client;
    },
  } as unknown as ComputerClient;
  return {
    client,
    files,
    asked,
    addressedAs,
    /** The browser goes somewhere else; the server sees it at its next look. */
    moveTo(url: string) {
      snapshot.url = url;
    },
  };
}

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

    const folder = `made/2026-10-07-${id8("call-1")}`;
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
  const folder = `made/2026-10-07-${id8("call-1")}`;
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

  test("one file read for two scripts is two reads, not the same read again", async () => {
    const built = circling();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await built.gateway.runScript(COMPUTER, BOT, ACTOR, {
        script: `console.log(${attempt})`,
        files: ["uploads/a.csv"],
      });
    }
    // A fifth script over the same file: its read is that script's first.
    await built.gateway.runScript(COMPUTER, BOT, ACTOR, {
      script: "console.log(5)",
      files: ["uploads/a.csv"],
    });
    expect(built.sent).toHaveLength(5);

    // And one script over one file, five times, is stopped at its fifth read — before it runs.
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
      intent: "read_file",
      reason: "repeat",
      repeatCount: 5,
    });
    expect(same.sent).toHaveLength(4);
  });
});
