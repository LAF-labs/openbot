/**
 * THE ACT, DRIVEN AGAINST THE REAL SERVICE: the gateway's `runScript`
 * (`server/src/computer/gateway/acts.ts`) with the real daemon on the other end of the socket.
 *
 * The gateway's own tests hold the act's order and its boundary with a stand-in where a script
 * runs. This is the other half of knowing it works: the same method, the same decisions and the
 * same rows, with the server's own client and the service compose defines — a script that really
 * reads the bytes it was handed, really runs with no network, is really ended when its caller
 * stops, and whose daemon really takes the next run.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT, said so that nobody reads this as more:
 *
 *  - REAL: `createComputerGateway` and everything a run goes through in it (`govern`, the policy,
 *    the repeat count, the trail's writers and the redaction every row passes on its way to a
 *    store), the client (`server/src/workbench/client.ts`), the daemon, its sweep, the scripts.
 *  - NOT: the Bot's computer — a folder in memory that records what was asked of it; its routes
 *    are measured in its own workspace's tests. And the table — a list of what the store was
 *    handed; the same act writing to `audit_events` itself, and read back, is
 *    `server/tests/workbench-trail.integration.test.ts`.
 *
 * So the rows printed below are what the gateway hands a store, field for field, for runs that
 * really ran.
 *
 * NEVER STARTED ANYWHERE BUT THE REHEARSAL'S CONTAINER (`scripts/workbench-probe.ts` writes the
 * compose service that runs it). Its first act is to ask a script where it is, and when the answer
 * is not the sandbox it stops, having sent nothing else. The container has no network, so the only
 * things it can reach are the socket and its own memory.
 */
import type { AuditEventInput, AuditStore } from "../server/src/audit";
import {
  type ComputerClient,
  WorkspaceRequestError,
} from "../server/src/computer/client";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../server/src/computer/gateway";
import { RUN_SCRIPT_TOOL } from "../server/src/computer/gateway/intent";
import type { ScriptRun } from "../server/src/computer/gateway/script-run";
import type { ActionPolicy } from "../server/src/computer/policy";
import {
  createWorkbench,
  type Workbench,
} from "../server/src/workbench/client";
import { createLogger } from "../shared/log";
import { isKey, KEY_VARIABLE } from "../shared/workbench/protocol";
import {
  ACT_RESULT,
  ACT_ROWS,
  ACT_SCRIPTS,
  ACT_SENTINELS,
  type ProbeCheck,
} from "./workbench-probe";

const BOT = "act-probe-bot";
const COMPUTER = "act-probe-computer";
const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

const text = (value: string) => new TextEncoder().encode(value);
const said = (bytes: Uint8Array | undefined) =>
  bytes ? new TextDecoder().decode(bytes) : "";

/** The Bot's computer, standing in: a folder in memory and a record of what was asked of it. */
function folderOf(files: Record<string, string>) {
  const held = new Map<string, Uint8Array>(
    Object.entries(files).map(([path, value]) => [path, text(value)]),
  );
  const asked: string[] = [];
  const addressedAs: string[] = [];
  const client = {
    async fileBytes(path: string) {
      asked.push(`fileBytes ${path}`);
      const found = held.get(path);
      if (!found) throw new WorkspaceRequestError("laf:file_not_found");
      return found;
    },
    async putFile(path: string, body: Uint8Array) {
      asked.push(`putFile ${path}`);
      if (held.has(path)) throw new WorkspaceRequestError("laf:file_exists");
      held.set(path, body);
      return { path, kind: "file" as const, bytes: body.byteLength };
    },
    async listFiles(input: { path?: string }) {
      asked.push(`listFiles ${input.path ?? "."}`);
      const under = [...held].filter(([path]) =>
        path.startsWith(`${input.path}/`),
      );
      if (under.length === 0) {
        throw new WorkspaceRequestError("laf:file_not_found");
      }
      return {
        path: input.path ?? ".",
        entries: under.map(([path, body]) => ({
          path,
          kind: "file" as const,
          bytes: body.byteLength,
        })),
        truncated: false,
      };
    },
    forBot(botId: string) {
      addressedAs.push(botId);
      return client;
    },
  } as unknown as ComputerClient;
  return { client, held, asked, addressedAs };
}

/** One drive of the act: a gateway of its own, and everything that came of it. */
async function drive(options: {
  /** Absent is a deployment with nowhere to run a script. */
  workbench?: Workbench;
  policy?: ActionPolicy;
  files?: Record<string, string>;
  attempt: (
    gateway: ReturnType<typeof createComputerGateway>,
  ) => Promise<ScriptRun>;
}) {
  const computer = folderOf(options.files ?? {});
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = { insert: async (row) => void rows.push(row) };
  /** How many runs this drive handed the client: what "never reached the sandbox" is read off. */
  let sent = 0;
  const counted: Workbench | undefined = options.workbench && {
    health: options.workbench.health,
    run: (request, signal) => {
      sent += 1;
      return (options.workbench as Workbench).run(request, signal);
    },
  };
  const gateway = createComputerGateway({
    client: computer.client,
    auditStore,
    policy: () => options.policy ?? PERMISSIVE,
    ...(counted ? { workbench: counted } : {}),
  });
  const began = performance.now();
  let run: ScriptRun | null = null;
  let threw: Error | null = null;
  try {
    run = await options.attempt(gateway);
  } catch (error) {
    threw = error instanceof Error ? error : new Error(String(error));
  }
  return {
    run,
    threw,
    ms: Math.round(performance.now() - began),
    rows,
    computer,
    sent: () => sent,
  };
}

/** What a row is, in the two words a reader of the trail goes by. */
const kinds = (rows: AuditEventInput[]) =>
  rows.map((row) => `${row.eventType} ${String(row.payload.action ?? "")}`);

/** One scenario's rows as they were handed to the store, on a line the rehearsal prints. */
function printed(
  scenario: string,
  outcome: string,
  rows: AuditEventInput[],
): void {
  console.log(ACT_ROWS + JSON.stringify({ scenario, outcome, rows }));
}

async function probe(socketPath: string, checks: ProbeCheck[]): Promise<void> {
  const check = (name: string, ok: boolean | null, detail: string) => {
    checks.push({ name, ok, detail });
  };
  const log = createLogger("workbench-act-probe");
  const key = process.env[KEY_VARIABLE];
  if (!isKey(key)) {
    check(
      "everything about the act",
      false,
      `the probe's container was started without ${KEY_VARIABLE}, so it could believe nothing it was answered and sent nothing`,
    );
    return;
  }
  const workbench = createWorkbench({ socketPath, key, log });
  // The walls' probe ran before this and ended a daemon or two: wait for one that is idle.
  for (const deadline = Date.now() + 60_000; ; ) {
    if ((await workbench.health())?.busy === false) break;
    if (Date.now() > deadline) {
      check(
        "everything about the act",
        false,
        "no idle daemon answered within 60 s, so nothing was sent",
      );
      return;
    }
    await Bun.sleep(250);
  }

  // WHERE A SCRIPT IS. First, and by the client alone: everything after this is only for the sandbox.
  const first = await workbench.run({ script: ACT_SCRIPTS.where, files: [] });
  let where: { uid?: number; parent?: number; interfaces?: string[] } = {};
  try {
    where = first.ok ? JSON.parse(first.run.stdout) : {};
  } catch {
    // Left empty: not the sandbox, as far as this can tell.
  }
  const inSandbox =
    where.uid === 65534 &&
    where.parent === 1 &&
    Array.isArray(where.interfaces) &&
    where.interfaces.length === 0;
  check(
    "the act is driven where a script is nobody, a child of process 1, with no network",
    inSandbox,
    first.ok
      ? first.run.stdout.trim().slice(0, 300)
      : `no run: ${first.failure}`,
  );
  if (!inSandbox) return;

  const input = {
    script: ACT_SCRIPTS.total,
    files: ["uploads/sales.csv"],
  };
  const sales = `day,amount\nmon,40\ntue,2\n${ACT_SENTINELS.input},0\n`;
  const actor = { id: "act-probe", toolCallId: "act-probe-call-1" };

  // 1. A RUN THAT READS ONE NAMED FILE AND MAKES ONE PRODUCT.
  const whole = await drive({
    workbench,
    files: { "uploads/sales.csv": sales },
    attempt: (gateway) => gateway.runScript(COMPUTER, BOT, actor, input),
  });
  const product = whole.run?.products[0];
  const filed = said(whole.computer.held.get(product?.path ?? ""));
  printed(
    "a run that reads one named file and makes one product",
    whole.run
      ? `returned in ${whole.ms} ms: ending=${whole.run.ending} exit=${whole.run.exitCode} stdoutBytes=${whole.run.stdoutBytes} products=${JSON.stringify(whole.run.products)}`
      : `threw ${whole.threw?.name}: ${whole.threw?.message}`,
    whole.rows,
  );
  check(
    "a run through the gateway reads the named file, runs in the real sandbox, and files what it made",
    whole.run?.ending === "exited" &&
      whole.run.exitCode === 0 &&
      // Arithmetic done in the sandbox over the bytes the gateway read: 40 + 2 + 0.
      whole.run.stdout.includes("total 42") &&
      /^made\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\/totals\.csv$/.test(
        product?.path ?? "",
      ) &&
      filed.startsWith("total\n42\n") &&
      JSON.stringify(whole.computer.asked) ===
        JSON.stringify([
          "fileBytes uploads/sales.csv",
          "listFiles made",
          `putFile ${product?.path}`,
        ]) &&
      whole.computer.addressedAs.every((bot) => bot === BOT),
    whole.run
      ? `${whole.ms} ms; the script's own ${whole.run.ms} ms; filed ${product?.path} (${product?.bytes} bytes); the computer was asked ${JSON.stringify(whole.computer.asked)}, each time as ${[...new Set(whole.computer.addressedAs)].join(",")}`
      : `threw ${whole.threw?.name}: ${whole.threw?.message}`,
  );
  const [read, decided, ended, wrote] = whole.rows;
  const digest = (decided?.payload.script ?? {}) as {
    sha256?: string;
    bytes?: number;
  };
  check(
    "its rows are the read, the decision before the run, how it ended, and the file — in that order",
    JSON.stringify(kinds(whole.rows)) ===
      JSON.stringify([
        "computer.action_allowed computer_read_file",
        `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
        `computer.script_finished ${RUN_SCRIPT_TOOL}`,
        "computer.action_allowed computer_write_file",
      ]) &&
      read?.payload.file === "uploads/sales.csv" &&
      decided?.payload.page === "" &&
      digest.sha256 === whole.run?.sha256 &&
      digest.bytes === Buffer.byteLength(input.script) &&
      JSON.stringify(decided?.payload.files) ===
        JSON.stringify(["uploads/sales.csv"]) &&
      ended?.payload.ending === "exited" &&
      ended?.payload.exit === 0 &&
      ended?.payload.stdoutBytes === whole.run?.stdoutBytes &&
      JSON.stringify(ended?.payload.products) ===
        JSON.stringify([{ name: "totals.csv", bytes: product?.bytes }]) &&
      wrote?.payload.file === product?.path,
    `${JSON.stringify(kinds(whole.rows))}; the script is ${digest.bytes} bytes, sha256 ${String(digest.sha256).slice(0, 16)}…`,
  );
  const written = JSON.stringify(whole.rows);
  const leaked = Object.entries(ACT_SENTINELS)
    .filter(([, sentinel]) => written.includes(sentinel))
    .map(([where]) => where);
  check(
    "no row holds a line of the script, a character it printed, or a byte of either file",
    leaked.length === 0 &&
      // And each sentinel was really where it was meant to be, so its absence above means something.
      input.script.includes(ACT_SENTINELS.script) &&
      (whole.run?.stdout.includes(ACT_SENTINELS.stdout) ?? false) &&
      sales.includes(ACT_SENTINELS.input) &&
      filed.includes(ACT_SENTINELS.product),
    `sentinels found in ${written.length} characters of rows: ${leaked.length === 0 ? "none" : leaked.join(", ")}; each was in the script, in what it printed (${whole.run?.stdoutBytes} bytes, handed to the caller only), in the file it read and in the file it made`,
  );

  // 2. A RUN WHOSE INPUT READ IS REFUSED.
  const refused = await drive({
    workbench,
    policy: { ...PERMISSIVE, deny: ['file.path == "uploads/sales.csv"'] },
    files: { "uploads/sales.csv": sales },
    attempt: (gateway) => gateway.runScript(COMPUTER, BOT, actor, input),
  });
  printed(
    "a run whose input read is refused",
    refused.threw
      ? `threw ${refused.threw.name}: ${refused.threw.message} in ${refused.ms} ms`
      : "returned a run",
    refused.rows,
  );
  check(
    "a run whose input read is refused never reaches the sandbox, and the file is never read",
    refused.threw instanceof ActionRefusedError &&
      refused.threw.code === "laf:policy_denied" &&
      refused.sent() === 0 &&
      refused.computer.asked.length === 0 &&
      JSON.stringify(kinds(refused.rows)) ===
        JSON.stringify(["computer.action_refused computer_read_file"]),
    `${refused.threw?.name}: ${refused.threw?.message}; runs handed to the client: ${refused.sent()}; the computer was asked ${JSON.stringify(refused.computer.asked)}; rows ${JSON.stringify(kinds(refused.rows))}`,
  );

  // 3. A RUN STOPPED MID-WAY.
  const stop = new AbortController();
  const stopping = setTimeout(() => stop.abort(), 1_500);
  const stopped = await drive({
    workbench,
    attempt: (gateway) =>
      gateway.runScript(
        COMPUTER,
        BOT,
        actor,
        { script: ACT_SCRIPTS.long, files: [], timeoutMs: 30_000 },
        stop.signal,
      ),
  });
  clearTimeout(stopping);
  printed(
    "a run stopped mid-way",
    stopped.threw
      ? `threw ${stopped.threw.name}: ${stopped.threw.message} in ${stopped.ms} ms`
      : "returned a run",
    stopped.rows,
  );
  check(
    "a run stopped mid-way is ended, files nothing, and its row says it did not happen",
    stopped.threw?.message === "laf:stopped" &&
      // Stopped at a second and a half of a script that sleeps thirty: ended, not waited out.
      stopped.ms < 15_000 &&
      stopped.sent() === 1 &&
      stopped.computer.asked.length === 0 &&
      JSON.stringify(kinds(stopped.rows)) ===
        JSON.stringify([
          `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
          `computer.action_failed ${RUN_SCRIPT_TOOL}`,
        ]) &&
      stopped.rows[1]?.payload.failure === "laf:stopped",
    `${stopped.threw?.name}: ${stopped.threw?.message} after ${stopped.ms} ms (stopped at 1,500 of a script that sleeps 30,000); rows ${JSON.stringify(kinds(stopped.rows))}; failure ${String(stopped.rows[1]?.payload.failure)}`,
  );
  const next = await drive({
    workbench,
    attempt: (gateway) =>
      gateway.runScript(COMPUTER, BOT, actor, {
        script: ACT_SCRIPTS.after,
        files: [],
      }),
  });
  printed(
    "the run after the stopped one",
    next.run
      ? `returned in ${next.ms} ms: ending=${next.run.ending} exit=${next.run.exitCode}`
      : `threw ${next.threw?.name}: ${next.threw?.message} in ${next.ms} ms`,
    next.rows,
  );
  check(
    "the daemon takes the next run after one that was stopped",
    next.run?.exitCode === 0 && next.run.stdout.trim() === "after the stop",
    next.run
      ? `answered in ${next.ms} ms, the wait for the daemon to clear up included: ${JSON.stringify(next.run.stdout.trim())}`
      : `threw ${next.threw?.name}: ${next.threw?.message} in ${next.ms} ms`,
  );

  // 4. A DEPLOYMENT WITH NO SERVICE.
  const none = await drive({
    files: { "uploads/sales.csv": sales },
    attempt: (gateway) => gateway.runScript(COMPUTER, BOT, actor, input),
  });
  printed(
    "a deployment with no service configured",
    none.threw
      ? `threw ${none.threw.name}: ${none.threw.message} in ${none.ms} ms`
      : "returned a run",
    none.rows,
  );
  check(
    "a deployment with no service configured refuses at once: nothing read, nothing recorded",
    none.threw?.message === "laf:workbench_unavailable" &&
      none.rows.length === 0 &&
      none.computer.asked.length === 0 &&
      none.computer.addressedAs.length === 0 &&
      none.ms < 100,
    `${none.threw?.name}: ${none.threw?.message} in ${none.ms} ms; rows ${none.rows.length}; the computer was asked ${JSON.stringify(none.computer.asked)}`,
  );
  // A service that is configured — a socket's path and the key — where nothing has ever answered.
  const nobody = createWorkbench({
    socketPath: `${socketPath}.nobody-is-here`,
    key,
    log,
  });
  const absent = await drive({
    workbench: nobody,
    attempt: (gateway) =>
      gateway.runScript(COMPUTER, BOT, actor, {
        script: ACT_SCRIPTS.after,
        files: [],
      }),
  });
  printed(
    "a service configured where nothing answers",
    absent.threw
      ? `threw ${absent.threw.name}: ${absent.threw.message} in ${absent.ms} ms`
      : "returned a run",
    absent.rows,
  );
  check(
    "a service configured where nothing has ever answered is unavailable on a row of its own, with no wait for a daemon between two lives",
    absent.threw?.message === "laf:workbench_unavailable" &&
      JSON.stringify(kinds(absent.rows)) ===
        JSON.stringify([
          `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
          `computer.action_failed ${RUN_SCRIPT_TOOL}`,
        ]) &&
      absent.rows[1]?.payload.failure === "laf:workbench_unavailable" &&
      // The wait for a daemon between two lives is four seconds; none was ever seen here.
      absent.ms < 1_500,
    `${absent.threw?.name}: ${absent.threw?.message} in ${absent.ms} ms; rows ${JSON.stringify(kinds(absent.rows))}`,
  );
}

if (import.meta.main) {
  const socketPath = process.argv[2];
  if (!socketPath) {
    console.error(
      "usage: bun workbench-act-probe.ts <socket>, inside the rehearsal's container",
    );
    process.exit(2);
  }
  const checks: ProbeCheck[] = [];
  await probe(socketPath, checks).catch((error) => {
    checks.push({
      name: "the act's probe ran to its end",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  });
  console.log(ACT_RESULT + JSON.stringify(checks));
  // Importing the gateway brings the server's own log and its timers: end here regardless.
  process.exit(0);
}
