import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  type AuditEvent,
  createAuditReader,
  createAuditStore,
} from "../src/audit";
import {
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import { RUN_SCRIPT_TOOL } from "../src/computer/gateway/intent";
import type { ActionPolicy } from "../src/computer/policy";
import { createDatabase } from "../src/db/client";
import { TEST_POOL } from "./support/database";
import {
  bytes,
  ENDED,
  fakeComputer,
  fakeWorkbench,
} from "./support/script-run";

/**
 * A SCRIPT'S RUN, READ BACK OUT OF THE TABLE THE TRAIL IS.
 *
 * `workbench-gateway.test.ts` holds the order and the boundary against a store that is a list.
 * This is the same act writing to `audit_events` itself, and read back the way the trail's page
 * reads it (`createAuditReader`): what a row holds once it has been through the redaction every
 * row goes through and through `jsonb`, which is what somebody a year from now will be looking
 * at. The sandbox and the computer are stand-ins here; the store and the reader are not.
 *
 * NOTHING HERE CLEANS UP, AND CANNOT: the database refuses a delete on this table
 * (`audit-append-only.integration.test.ts`). Every row lands in the test database against a
 * computer whose id is this run's own, which is also what every read below is scoped by.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

afterAll(async () => {
  await database.$client.close();
});

const BOT = "workbench-trail-bot";
const ACTOR = { id: "workbench-trail-actor" };
const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function stack(
  options: {
    policy?: ActionPolicy;
    folder?: Record<string, Uint8Array>;
    answer?: Parameters<typeof fakeWorkbench>[0];
  } = {},
) {
  const computerId = `workbench-trail-${randomUUID()}`;
  const computer = fakeComputer(options.folder);
  const bench = fakeWorkbench(options.answer);
  const gateway = createComputerGateway({
    client: computer.client,
    auditStore: createAuditStore(database),
    policy: () => options.policy ?? PERMISSIVE,
    workbench: bench.workbench,
    now: () => new Date("2026-10-07T03:04:05.000Z"),
  });
  /** This run's rows as the trail's reader hands them out, oldest first. */
  const trail = async (): Promise<AuditEvent[]> => {
    const { events } = await createAuditReader(database).list({
      targetType: "computer",
      targetId: computerId,
      limit: 100,
    });
    // Newest first off the reader. Rows of one run are milliseconds apart, and each has its own
    // `created_at`, so this is the order they were written in.
    return events.reverse();
  };
  return { gateway, computerId, computer, sent: bench.sent, trail };
}

describe("the rows a script's run leaves in the table", () => {
  test("are what the gateway wrote, in the order things happened, with names as they were", async () => {
    const script = 'console.log("합계", 42);';
    const product = "요일,합계\n월,40\n";
    const { gateway, computerId, trail } = stack({
      folder: { "uploads/매출.csv": bytes("요일,금액\n월,40\n화,2\n") },
      answer: () => ({
        ok: true,
        run: { ...ENDED, stdout: "합계 42\n", stdoutBytes: 10 },
        products: [{ name: "요일별 매출.csv", bytes: bytes(product) }],
      }),
    });

    const run = await gateway.runScript(
      computerId,
      BOT,
      { ...ACTOR, toolCallId: "call-trail" },
      { script, files: ["uploads/매출.csv"] },
    );
    const filed = run.products[0]?.path ?? "";
    expect(filed).toMatch(/^made\/2026-10-07-[0-9a-f]{8}\/요일별 매출\.csv$/);

    const rows = await trail();
    expect(
      rows.map((row) => `${row.eventType} ${String(row.payload.action)}`),
    ).toEqual([
      "computer.action_allowed computer_read_file",
      `computer.action_allowed ${RUN_SCRIPT_TOOL}`,
      `computer.script_finished ${RUN_SCRIPT_TOOL}`,
      "computer.action_allowed computer_write_file",
    ]);
    const [read, decided, ended, wrote] = rows;
    expect(read?.payload.file).toBe("uploads/매출.csv");
    // The file it read and the file it made each say which run they were for.
    expect(read?.payload.forScript).toBe(sha256(script));
    expect(wrote?.payload.forScript).toBe(sha256(script));
    expect(decided?.payload).toMatchObject({
      bot: BOT,
      actor: ACTOR.id,
      page: "",
      script: { sha256: sha256(script), bytes: Buffer.byteLength(script) },
      files: ["uploads/매출.csv"],
      decision: { allowed: true, source: "allow", carriedOut: true },
    });
    // Whole, as the table holds it: every field of the row a run's ending leaves, and no other.
    expect(ended?.payload).toEqual({
      action: RUN_SCRIPT_TOOL,
      bot: BOT,
      actor: ACTOR.id,
      script: { sha256: sha256(script), bytes: Buffer.byteLength(script) },
      ending: "exited",
      exit: 0,
      signal: null,
      ms: 412,
      stdoutBytes: 10,
      stderrBytes: 0,
      products: [
        { name: "요일별 매출.csv", bytes: Buffer.byteLength(product) },
      ],
      skipped: 0,
    });
    expect(ended?.targetType).toBe("computer");
    // The local actor is not a row in `users`, and the row does not claim one.
    expect(ended?.actorUserId).toBeNull();
    expect(wrote?.payload.file).toBe(filed);
  });

  test("hold no line of the script, no character it printed and no byte of a file, after the table has had them", async () => {
    const inScript = "SENTINEL-IN-THE-SCRIPT-4f6b";
    const inStdout = "SENTINEL-IN-STDOUT-0d82";
    const inStderr = "SENTINEL-IN-STDERR-c1e7";
    const inInput = "SENTINEL-IN-AN-INPUT-73b9";
    const inProduct = "SENTINEL-IN-A-PRODUCT-a55d";
    const script = `console.log(${JSON.stringify(inScript)});`;
    const { gateway, computerId, trail } = stack({
      folder: { "uploads/in.csv": bytes(`a\n${inInput}\n`) },
      answer: () => ({
        ok: true,
        run: {
          ...ENDED,
          stdout: `${inStdout}\n`,
          stderr: `${inStderr}\n`,
          stdoutBytes: inStdout.length + 1,
          stderrBytes: inStderr.length + 1,
        },
        products: [{ name: "out.csv", bytes: bytes(`${inProduct}\n`) }],
      }),
    });

    await gateway.runScript(computerId, BOT, ACTOR, {
      script,
      files: ["uploads/in.csv"],
    });

    const rows = await trail();
    expect(rows).toHaveLength(4);
    const written = JSON.stringify(rows);
    for (const sentinel of [inScript, inStdout, inStderr, inInput, inProduct]) {
      expect({ sentinel, found: written.includes(sentinel) }).toEqual({
        sentinel,
        found: false,
      });
    }
    // What identifies the run is there, on every one of its rows: the read and the file it made
    // (`forScript`), the decision and the ending (`script`).
    expect(written.split(sha256(script)).length - 1).toBe(4);
  });

  test("say a refused file was refused and nothing more: no run was decided, and none is on the trail", async () => {
    const { gateway, computerId, sent, trail } = stack({
      policy: { ...PERMISSIVE, deny: ['file.name == "payroll.csv"'] },
      folder: { "uploads/payroll.csv": bytes("x") },
    });

    await expect(
      gateway.runScript(computerId, BOT, ACTOR, {
        script: "console.log(1)",
        files: ["uploads/payroll.csv"],
      }),
    ).rejects.toThrow(ActionRefusedError);

    expect(sent).toEqual([]);
    const rows = await trail();
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_refused",
    ]);
    expect(rows[0]?.payload).toMatchObject({
      action: "computer_read_file",
      file: "uploads/payroll.csv",
      decision: {
        allowed: false,
        source: "deny",
        rule: 'file.name == "payroll.csv"',
        code: "laf:policy_denied",
      },
    });
  });
});
