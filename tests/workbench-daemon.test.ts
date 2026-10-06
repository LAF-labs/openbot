/**
 * The workbench's daemon and the server's client for it, joined by a real unix socket and running
 * real scripts in real child processes — on whatever machine runs the tests.
 *
 * WHAT THIS FILE CANNOT SHOW, AND DOES NOT PRETEND TO. The walls are a container's: no network, a
 * read-only root, a user with nothing. None of that is here; a script in these tests runs as
 * whoever ran `bun test`. And THE SWEEP IS NOT THE REAL ONE — it is a function that counts its
 * calls. The real one ends every process its user owns, which on this machine is everything
 * (`shared/workbench/sweep.ts`); it is exercised only by the service in its container
 * (`scripts/workbench-probe.ts`, from `scripts/upgrade-e2e.ts`). So no script here leaves a
 * process behind for a sweep to end.
 *
 * What it does show is everything on this side of the walls: the protocol both ways, every bound,
 * what counts as a file to hand back, the order of what happens after a script ends, and each way
 * the daemon decides it can no longer vouch for the next run.
 */
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createWorkbench,
  type Workbench,
  type WorkbenchAnswer,
} from "../server/src/workbench/client";
import { createLogger, type Logger } from "../shared/log";
import {
  type QuitReason,
  startWorkbenchDaemon,
  type WorkbenchDaemon,
} from "../shared/workbench/daemon";
import {
  filePart,
  JOB_PART,
  SCRIPT_PART,
  WORKBENCH_LIMITS,
} from "../shared/workbench/protocol";
import { runScript, type WorkbenchLimits } from "../shared/workbench/run";
import { bunTypeScript, type Runner } from "../shared/workbench/runner";

const repository = join(import.meta.dir, "..");

/** The daemon's log, unread: what it writes is facts about runs, and the tests ask the runs. */
const quiet: Logger = { svc: "workbench", info() {}, warn() {}, error() {} };

/** The runner the service has, pointed at this checkout's own SheetJS. */
const runner = bunTypeScript({
  bun: process.execPath,
  libraries: { xlsx: join(repository, "server/node_modules/xlsx") },
});

type Bench = {
  workbench: Workbench;
  daemon: WorkbenchDaemon;
  socketPath: string;
  workRoot: string;
  scratch: string;
  /** How many times the (counting, harmless) sweep was asked. */
  swept: () => number;
  quits: QuitReason[];
  /** Every line the daemon wrote, as the real log renders it. */
  logged: string[];
};

const started: { daemon: Pick<WorkbenchDaemon, "stop">; root: string }[] = [];

afterEach(async () => {
  for (const { daemon, root } of started.splice(0)) {
    await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

function bench(
  overrides: {
    limits?: Partial<WorkbenchLimits>;
    problems?: () => string[];
    sweep?: () => Promise<void>;
    worn?: () => boolean;
  } = {},
): Bench {
  // Short names: a unix socket's path may be 104 bytes on macOS, and the temp directory is most of it.
  const root = mkdtempSync(join(tmpdir(), "wb-"));
  const socketPath = join(root, "s", "w.sock");
  const workRoot = join(root, "work");
  const scratch = join(root, "shm");
  for (const made of [join(root, "s"), workRoot, scratch]) mkdirSync(made);
  let swept = 0;
  const quits: QuitReason[] = [];
  const logged: string[] = [];
  const limits = { ...WORKBENCH_LIMITS, ...overrides.limits };
  const daemon = startWorkbenchDaemon({
    socketPath,
    workRoot,
    runner,
    problems: overrides.problems ?? (() => []),
    sweep:
      overrides.sweep ??
      (async () => {
        swept += 1;
      }),
    scratch: [scratch],
    ...(overrides.worn ? { worn: overrides.worn } : {}),
    limits,
    // The real log, into a list: what the service would write, scrubbing and all.
    log: createLogger("workbench", (_level, line) => {
      logged.push(line);
    }),
    quit: (reason) => {
      quits.push(reason);
    },
  });
  started.push({ daemon, root });
  return {
    daemon,
    workbench: createWorkbench({ socketPath, limits, log: quiet }),
    socketPath,
    workRoot,
    scratch,
    swept: () => swept,
    quits,
    logged,
  };
}

const text = (value: string) => new TextEncoder().encode(value);

function ran(answer: WorkbenchAnswer) {
  if (!answer.ok) throw new Error(`no run: ${JSON.stringify(answer)}`);
  return answer;
}

/** A request as the daemon is sent one, built by hand: what the client would refuse to send. */
function rawRun(
  socketPath: string,
  job: unknown,
  parts: Record<string, string> = {},
  script: string | null = "console.log(1)",
) {
  const form = new FormData();
  form.set(JOB_PART, typeof job === "string" ? job : JSON.stringify(job));
  if (script !== null) form.set(SCRIPT_PART, new Blob([script]));
  for (const [name, value] of Object.entries(parts)) {
    form.set(name, new Blob([value]));
  }
  return fetch("http://workbench/run", {
    method: "POST",
    unix: socketPath,
    body: form,
  });
}

const until = async (what: () => boolean | Promise<boolean>, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > deadline) throw new Error("it never became true");
    await Bun.sleep(20);
  }
};

test("a script reads the file it was handed, with SheetJS, and hands back the file it made", async () => {
  const { workbench, workRoot, swept } = bench();
  const answer = ran(
    await workbench.run({
      script: `
        import * as XLSX from "xlsx";
        const sheet = XLSX.read(await Bun.file("uploads/2026-10-06-매출.csv").text(), { type: "string" });
        const rows = XLSX.utils.sheet_to_json<{ 금액: number }>(sheet.Sheets[sheet.SheetNames[0]!]!);
        const total = rows.reduce((sum, row) => sum + row.금액, 0);
        console.log("합계 " + total);
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["합계"], [total]]), "합계");
        await Bun.write("out/요일별 합계.xlsx", XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
      `,
      files: [
        {
          path: "uploads/2026-10-06-매출.csv",
          bytes: text("요일,금액\n월,10\n화,20\n수,30\n"),
        },
      ],
    }),
  );
  expect(answer.run).toMatchObject({
    ending: "exited",
    exitCode: 0,
    signal: null,
    stdout: "합계 60\n",
    stderr: "",
    skipped: 0,
  });
  expect(answer.products.map((product) => product.name)).toEqual([
    "요일별 합계.xlsx",
  ]);
  // A workbook is a zip.
  expect([...(answer.products[0]?.bytes.subarray(0, 2) ?? [])]).toEqual([
    0x50, 0x4b,
  ]);
  // The sweep ran, and nothing of the run is left where it ran.
  expect(swept()).toBe(1);
  expect(readdirSync(workRoot)).toEqual([]);
});

test("a script is sent as it was written, line endings and all", async () => {
  const { workbench } = bench();
  const script = "const said = `a\nb`;\r\nconsole.log(JSON.stringify(said));\n";
  const answer = ran(await workbench.run({ script, files: [] }));
  expect(answer.run.stdout).toBe('"a\\nb"\n');
});

test("a script starts with nothing of the daemon's environment, in a home of its own", async () => {
  const { workbench, workRoot } = bench();
  process.env.LAF_WORKBENCH_TEST_SECRET = "must-not-cross";
  try {
    const answer = ran(
      await workbench.run({
        script:
          "console.log(JSON.stringify({ env: Object.keys(process.env).sort(), home: process.env.HOME, cwd: process.cwd() }))",
        files: [],
      }),
    );
    const said = JSON.parse(answer.run.stdout) as {
      env: string[];
      home: string;
      cwd: string;
    };
    expect(said.env).toEqual([
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
      "DO_NOT_TRACK",
      "HOME",
      "NO_COLOR",
      "TMPDIR",
    ]);
    // The run's directory is the real one: macOS reaches its temp directory through a link.
    expect(said.home).toStartWith(realpathSync(workRoot));
    expect(said.cwd).toEndWith("/files");
  } finally {
    delete process.env.LAF_WORKBENCH_TEST_SECRET;
  }
});

test("a script that fails hands nothing back, and what it said is kept", async () => {
  const { workbench } = bench();
  const answer = ran(
    await workbench.run({
      script:
        'await Bun.write("out/half.txt", "half"); console.error("틀렸다"); process.exit(3);',
      files: [],
    }),
  );
  expect(answer.run).toMatchObject({
    ending: "exited",
    exitCode: 3,
    stderr: "틀렸다\n",
  });
  expect(answer.products).toEqual([]);
});

test("a script that never ends is ended at its time", async () => {
  const { workbench, workRoot } = bench();
  const answer = ran(
    await workbench.run({ script: "for (;;) {}", files: [], timeoutMs: 400 }),
  );
  expect(answer.run).toMatchObject({
    ending: "timed_out",
    exitCode: null,
    signal: "SIGKILL",
  });
  expect(answer.run.ms).toBeGreaterThanOrEqual(400);
  expect(answer.run.ms).toBeLessThan(5_000);
  expect(readdirSync(workRoot)).toEqual([]);
});

test("a script that takes too much memory is ended for that, and said to have been", async () => {
  const { workbench } = bench({ limits: { memoryBytes: 200 * 1024 * 1024 } });
  const answer = ran(
    await workbench.run({
      script:
        "const held = []; for (;;) { held.push(new Uint8Array(16 * 1024 * 1024).fill(1)); await Bun.sleep(20); }",
      files: [],
      timeoutMs: 20_000,
    }),
  );
  expect(answer.run).toMatchObject({
    ending: "out_of_memory",
    exitCode: null,
    signal: "SIGKILL",
  });
});

test("what a script prints is kept to a bound, read past it, and counted", async () => {
  const { workbench } = bench({ limits: { streamBytes: 1_000 } });
  const answer = ran(
    await workbench.run({
      script:
        'process.stdout.write("가".repeat(100_000)); process.stderr.write("x".repeat(5_000));',
      files: [],
    }),
  );
  expect(answer.run.exitCode).toBe(0);
  expect(answer.run.stdoutBytes).toBe(300_000);
  expect(answer.run.stderrBytes).toBe(5_000);
  expect(answer.run.stderr).toBe("x".repeat(1_000));
  // 1,000 bytes of a three-byte character: 333 whole, and the mark for the one that was cut.
  expect(answer.run.stdout).toBe(`${"가".repeat(333)}�`);
});

test("only plain, visible files directly in out/ go back, and never through a link", async () => {
  const { workbench } = bench();
  const answer = ran(
    await workbench.run({
      script: `
        import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
        writeFileSync("out/kept.txt", "kept");
        writeFileSync("out/.hidden", "hidden");
        mkdirSync("out/folder");
        writeFileSync("out/folder/inside.txt", "inside");
        symlinkSync("/etc/hosts", "out/hosts.txt");
        writeFileSync("out/bad\\nname.txt", "x");
      `,
      files: [],
    }),
  );
  expect(
    answer.products.map((product) => [
      product.name,
      new TextDecoder().decode(product.bytes),
    ]),
  ).toEqual([["kept.txt", "kept"]]);
  expect(answer.run.skipped).toBe(4);
});

test("an out/ that a script swapped for a link hands back nothing from where it points", async () => {
  const { workbench } = bench();
  const answer = ran(
    await workbench.run({
      script:
        'import { rmSync, symlinkSync } from "node:fs"; rmSync("out", { recursive: true }); symlinkSync("/etc", "out");',
      files: [],
    }),
  );
  expect(answer.run.exitCode).toBe(0);
  expect(answer.products).toEqual([]);
  expect(answer.run.skipped).toBe(0);
});

test("an out/ reached through a link a script left above it hands back nothing either", async () => {
  const { workbench } = bench();
  const answer = ran(
    await workbench.run({
      script: `
        import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
        mkdirSync("../elsewhere/out", { recursive: true });
        writeFileSync("../elsewhere/out/planted.txt", "not made in out/");
        renameSync("../files", "../was");
        symlinkSync("elsewhere", "../files");
      `,
      files: [],
    }),
  );
  expect(answer.run.exitCode).toBe(0);
  expect(answer.products).toEqual([]);
});

test("files past a bound are refused together, never handed back in part", async () => {
  const { workbench } = bench({
    limits: { products: 2, productBytes: 100, productsBytes: 150 },
  });
  const made = async (script: string) =>
    ran(await workbench.run({ script, files: [] }));
  const many = await made(
    'for (const name of ["a", "b", "c"]) await Bun.write(`out/${name}.txt`, name);',
  );
  expect(many.run.productsRefused).toBe("too_many");
  expect(many.products).toEqual([]);
  const large = await made(
    'await Bun.write("out/a.txt", "x".repeat(101)); await Bun.write("out/b.txt", "y");',
  );
  expect(large.run.productsRefused).toBe("too_large");
  expect(large.products).toEqual([]);
  const together = await made(
    'await Bun.write("out/a.txt", "x".repeat(100)); await Bun.write("out/b.txt", "y".repeat(51));',
  );
  expect(together.run.productsRefused).toBe("too_large_together");
  expect(together.products).toEqual([]);
  const fits = await made(
    'await Bun.write("out/a.txt", "x".repeat(100)); await Bun.write("out/b.txt", "y".repeat(50));',
  );
  expect(fits.run.productsRefused).toBeUndefined();
  expect(fits.products.map((product) => product.bytes.byteLength)).toEqual([
    100, 50,
  ]);
});

test("a file may not land on a name the daemon or the interpreter reads", async () => {
  const { workbench, swept } = bench();
  for (const path of ["out/earlier.xlsx", "bunfig.toml"]) {
    expect(
      await workbench.run({
        script: "console.log(1)",
        files: [{ path, bytes: text('preload = ["./x.ts"]') }],
      }),
    ).toEqual({ ok: false, failure: "invalid", field: "files" });
  }
  // Deeper down the name means nothing to anybody.
  const nested = ran(
    await workbench.run({
      script: 'console.log(await Bun.file("notes/bunfig.toml").text())',
      files: [{ path: "notes/bunfig.toml", bytes: text("just a file") }],
    }),
  );
  expect(nested.run.stdout).toBe("just a file\n");
  // Nothing ran for the two that were refused.
  expect(swept()).toBe(1);
});

test("the daemon holds a request to every bound itself, whatever sent it", async () => {
  const { socketPath, swept, workRoot } = bench({
    limits: { files: 2, fileBytes: 10, filesBytes: 15, scriptBytes: 50 },
  });
  const refusedFor = async (response: Promise<Response>) => {
    const answer = await response;
    const body = (await answer.json()) as { code: string; field?: string };
    return [answer.status, body.code, body.field];
  };
  const invalid = (field: string) => [
    400,
    "laf:workbench_request_invalid",
    field,
  ];
  const one = (path: unknown) => ({ files: [{ path, part: filePart(0) }] });
  // A path that leaves, in each of the ways one can.
  for (const path of ["../x", "/etc/x", "a/../../x", "a//b", "", "a\\b", 7]) {
    expect(
      await refusedFor(rawRun(socketPath, one(path), { file0: "x" })),
    ).toEqual(invalid("files"));
  }
  // The same path twice; a file where another's folder is.
  expect(
    await refusedFor(
      rawRun(
        socketPath,
        {
          files: [
            { path: "a", part: "file0" },
            { path: "a", part: "file1" },
          ],
        },
        { file0: "x", file1: "y" },
      ),
    ),
  ).toEqual(invalid("files"));
  expect(
    await refusedFor(
      rawRun(
        socketPath,
        {
          files: [
            { path: "a", part: "file0" },
            { path: "a/b", part: "file1" },
          ],
        },
        { file0: "x", file1: "y" },
      ),
    ),
  ).toEqual(invalid("files"));
  // A part the job names and the form does not hold; a file over its bound; files over theirs.
  expect(await refusedFor(rawRun(socketPath, one("a")))).toEqual(
    invalid("files"),
  );
  expect(
    await refusedFor(rawRun(socketPath, one("a"), { file0: "x".repeat(11) })),
  ).toEqual(invalid("files"));
  expect(
    await refusedFor(
      rawRun(
        socketPath,
        {
          files: [
            { path: "a", part: "file0" },
            { path: "b", part: "file1" },
          ],
        },
        { file0: "x".repeat(8), file1: "y".repeat(8) },
      ),
    ),
  ).toEqual(invalid("files"));
  expect(
    await refusedFor(
      rawRun(
        socketPath,
        {
          files: [
            { path: "a", part: "file0" },
            { path: "b", part: "file0" },
            { path: "c", part: "file0" },
          ],
        },
        { file0: "x" },
      ),
    ),
  ).toEqual(invalid("files"));
  // The script, the job, the time.
  expect(
    await refusedFor(rawRun(socketPath, { files: [] }, {}, "x".repeat(51))),
  ).toEqual(invalid("script"));
  expect(await refusedFor(rawRun(socketPath, { files: [] }, {}, null))).toEqual(
    invalid("script"),
  );
  expect(await refusedFor(rawRun(socketPath, "{not json"))).toEqual(
    invalid("job"),
  );
  expect(await refusedFor(rawRun(socketPath, { files: "a" }))).toEqual(
    invalid("job"),
  );
  for (const timeoutMs of [0, -1, 1.5, "20", 60_001]) {
    expect(
      await refusedFor(rawRun(socketPath, { files: [], timeoutMs })),
    ).toEqual(invalid("timeoutMs"));
  }
  // Not a request for a run at all.
  expect(
    await refusedFor(
      fetch("http://workbench/elsewhere", { unix: socketPath, method: "POST" }),
    ),
  ).toEqual([404, "laf:workbench_route_unknown", undefined]);
  // And none of it ran anything or left anything.
  expect(swept()).toBe(0);
  expect(readdirSync(workRoot)).toEqual([]);
});

test("one script at a time: a second run meanwhile is refused, and health says why", async () => {
  const { workbench, socketPath } = bench();
  const long = workbench.run({
    script: "await Bun.sleep(700); console.log('done')",
    files: [],
  });
  await until(async () => (await workbench.health())?.busy === true);
  // Another caller entirely — this process's own client would have queued behind the first.
  const second = await createWorkbench({ socketPath, log: quiet }).run({
    script: "console.log(2)",
    files: [],
  });
  expect(second).toEqual({ ok: false, failure: "busy" });
  expect(ran(await long).run.stdout).toBe("done\n");
  expect(await workbench.health()).toEqual({ busy: false });
});

test("two runs from one client go one after the other, and both are answered", async () => {
  const { workbench } = bench();
  const [first, second] = await Promise.all([
    workbench.run({
      script: "await Bun.sleep(200); console.log(1)",
      files: [],
    }),
    workbench.run({ script: "console.log(2)", files: [] }),
  ]);
  expect(ran(first).run.stdout).toBe("1\n");
  expect(ran(second).run.stdout).toBe("2\n");
});

test("a caller that gives up ends the run, which is cleaned up after all the same", async () => {
  const { workbench, workRoot, swept } = bench();
  const gaveUp = new AbortController();
  const run = workbench.run(
    { script: "await Bun.sleep(30_000)", files: [], timeoutMs: 60_000 },
    gaveUp.signal,
  );
  await until(async () => (await workbench.health())?.busy === true);
  gaveUp.abort();
  expect(await run).toEqual({ ok: false, failure: "stopped" });
  await until(async () => (await workbench.health())?.busy === false);
  expect(swept()).toBe(1);
  expect(readdirSync(workRoot)).toEqual([]);
  // And the next caller is served.
  expect(
    ran(await workbench.run({ script: "console.log('next')", files: [] })).run
      .stdout,
  ).toBe("next\n");
});

test("the walls are asked before every run, and a daemon outside them runs nothing and stops", async () => {
  let outside = false;
  const { workbench, swept, quits } = bench({
    problems: () => (outside ? ["has_network"] : []),
  });
  ran(await workbench.run({ script: "console.log(1)", files: [] }));
  outside = true;
  expect(await workbench.run({ script: "console.log(2)", files: [] })).toEqual({
    ok: false,
    failure: "not_isolated",
  });
  expect(swept()).toBe(1);
  await until(() => quits.length > 0);
  expect(quits).toEqual(["not_isolated"]);
  // It has stopped listening: nothing more is taken.
  expect(await workbench.run({ script: "console.log(3)", files: [] })).toEqual({
    ok: false,
    failure: "unavailable",
  });
});

test("a sweep that fails is the end of the service, and no file of that run is handed back", async () => {
  const { workbench, quits, workRoot } = bench({
    sweep: async () => {
      throw new Error("something is still running");
    },
  });
  expect(
    await workbench.run({
      script: 'await Bun.write("out/made.txt", "made")',
      files: [],
    }),
  ).toEqual({ ok: false, failure: "failed" });
  await until(() => quits.length > 0);
  expect(quits).toEqual(["run_failed"]);
  expect(readdirSync(workRoot)).toEqual([]);
});

test("what a script left outside its own directory is gone before the next run", async () => {
  const { workbench, socketPath, scratch, workRoot } = bench();
  const beside = join(socketPath, "..", "note-for-the-next-run");
  const answer = ran(
    await workbench.run({
      script: `
        import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
        // The work root is its user's to write anywhere in, not only under its own run.
        writeFileSync("../../note-for-the-next-run", "hello");
        writeFileSync(${JSON.stringify(beside)}, "hello");
        mkdirSync(${JSON.stringify(join(scratch, "deep", "er"))}, { recursive: true });
        writeFileSync(${JSON.stringify(join(scratch, "deep", "er", "note"))}, "hello");
        // And both directories closed behind it.
        chmodSync(${JSON.stringify(join(socketPath, ".."))}, 0o000);
        chmodSync("../..", 0o000);
      `,
      files: [],
    }),
  );
  expect(answer.run.exitCode).toBe(0);
  expect(readdirSync(workRoot)).toEqual([]);
  expect(readdirSync(join(socketPath, ".."))).toEqual(["w.sock"]);
  expect(readdirSync(scratch)).toEqual([]);
  // And the service is still there for the next one.
  expect(
    ran(await workbench.run({ script: "console.log('next')", files: [] })).run
      .stdout,
  ).toBe("next\n");
});

test("a script that takes the socket's place is answered once, and then the daemon stops", async () => {
  const { workbench, socketPath, quits } = bench();
  const answer = ran(
    await workbench.run({
      script: `
        import { rmSync, writeFileSync } from "node:fs";
        rmSync(${JSON.stringify(socketPath)});
        writeFileSync(${JSON.stringify(socketPath)}, "not a socket");
        console.log("replaced");
      `,
      files: [],
    }),
  );
  // The run that did it is still reported: its connection was made before it ran.
  expect(answer.run.stdout).toBe("replaced\n");
  await until(() => quits.length > 0);
  expect(quits).toEqual(["socket_replaced"]);
});

test("what a script closed to its own user is still read where it is a file to hand back, and still removed", async () => {
  const { workbench, workRoot } = bench();
  const answer = ran(
    await workbench.run({
      script: `
        import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
        mkdirSync("locked/inner", { recursive: true });
        writeFileSync("locked/inner/file", "x");
        chmodSync("locked/inner", 0o000);
        chmodSync("locked", 0o000);
        // And a file it made and then closed, in a folder it closed: still the file it made.
        writeFileSync("out/closed.txt", "made");
        chmodSync("out/closed.txt", 0o000);
        chmodSync("out", 0o000);
      `,
      files: [],
    }),
  );
  expect(answer.run.exitCode).toBe(0);
  expect(
    answer.products.map((product) => [
      product.name,
      new TextDecoder().decode(product.bytes),
    ]),
  ).toEqual([["closed.txt", "made"]]);
  expect(readdirSync(workRoot)).toEqual([]);
});

test("the daemon retires itself once a run has left what only a fresh container clears", async () => {
  let worn = false;
  const { workbench, quits } = bench({ worn: () => worn });
  ran(await workbench.run({ script: "console.log(1)", files: [] }));
  await Bun.sleep(150);
  expect(quits).toEqual([]);
  worn = true;
  // Answered in full first; then it goes.
  expect(
    ran(await workbench.run({ script: "console.log(2)", files: [] })).run
      .stdout,
  ).toBe("2\n");
  await until(() => quits.length > 0);
  expect(quits).toEqual(["retired"]);
});

test("what the daemon logs is facts about a run: never a path, a name, or a word a script said", async () => {
  // A sweep that fails the way a filesystem does: with the path in its message.
  let fail = false;
  const { workbench, logged, workRoot } = bench({
    sweep: async () => {
      if (!fail) return;
      throw Object.assign(
        new Error(
          "EACCES: permission denied, rm '/work/run-abc/files/uploads/급여명세.xlsx'",
        ),
        { code: "EACCES" },
      );
    },
  });
  const job = {
    script:
      'console.log("속마음"); console.error("혼잣말"); await Bun.write("out/비밀 장부.txt", "x");',
    files: [{ path: "uploads/급여명세.xlsx", bytes: text("x") }],
  };
  expect(ran(await workbench.run(job)).products[0]?.name).toBe("비밀 장부.txt");
  fail = true;
  expect(await workbench.run(job)).toEqual({ ok: false, failure: "failed" });
  const everything = logged.join("\n");
  // Both runs are in it, as facts…
  expect(everything).toContain('"event":"workbench_run"');
  expect(everything).toContain('"event":"workbench_run_failed"');
  expect(everything).toContain('"code":"EACCES"');
  // …and nothing either of them was about.
  for (const told of [
    "급여명세",
    "uploads",
    "비밀",
    "속마음",
    "혼잣말",
    "permission denied",
    "run-",
    workRoot,
  ]) {
    expect(everything, told).not.toContain(told);
  }
});

test("a stale socket from a daemon that was killed does not stop the next one binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-"));
  mkdirSync(join(root, "s"));
  mkdirSync(join(root, "work"));
  const socketPath = join(root, "s", "w.sock");
  writeFileSync(socketPath, "left behind");
  const daemon = startWorkbenchDaemon({
    socketPath,
    workRoot: join(root, "work"),
    runner,
    problems: () => [],
    sweep: async () => {},
    log: quiet,
    quit: () => {},
  });
  started.push({ daemon, root });
  expect(await createWorkbench({ socketPath, log: quiet }).health()).toEqual({
    busy: false,
  });
  expect(existsSync(socketPath)).toBe(true);
});

/*
 * WHAT THE INDEPENDENT READ OF 2026-10-06 FOUND ON THIS SIDE OF THE SOCKET. Each test below failed
 * on the code as it was read, and is the reproduction of its finding.
 */

/** A daemon on a socket and a work root that are already there — as compose starts one on a volume that outlived the last. */
function daemonOn(socketPath: string, workRoot: string) {
  const quits: QuitReason[] = [];
  const daemon = startWorkbenchDaemon({
    socketPath,
    workRoot,
    runner,
    problems: () => [],
    sweep: async () => {},
    log: quiet,
    quit: (reason) => {
      quits.push(reason);
    },
  });
  started.push({ daemon, root: "/nonexistent-nothing" });
  return {
    daemon,
    quits,
    workbench: createWorkbench({ socketPath, log: quiet }),
  };
}

test("a DIRECTORY a script left where the socket belongs does not keep the next daemon from binding", async () => {
  const first = bench();
  const { socketPath } = first;
  const answer = ran(
    await first.workbench.run({
      script: `
        import { mkdirSync, rmSync, writeFileSync } from "node:fs";
        rmSync(${JSON.stringify(socketPath)});
        mkdirSync(${JSON.stringify(socketPath)});
        writeFileSync(${JSON.stringify(join(socketPath, "held"))}, "so that it is not empty");
        console.log("a directory now");
      `,
      files: [],
    }),
  );
  expect(answer.run.stdout).toBe("a directory now\n");
  await until(() => first.quits.length > 0);
  expect(first.quits).toEqual(["socket_replaced"]);
  // The container ends; compose starts another. The socket's volume is the server's too by then,
  // so it is the same directory — and until 2026-10-06 the new daemon threw on the first line that
  // touched it, every time it was started: a loop only removing the volume by hand would end.
  const second = daemonOn(socketPath, first.workRoot);
  expect(await second.workbench.health()).toEqual({ busy: false });
  expect(readdirSync(dirname(socketPath))).toEqual(["w.sock"]);
  expect(
    ran(
      await second.workbench.run({
        script: "console.log('served')",
        files: [],
      }),
    ).run.stdout,
  ).toBe("served\n");
});

test("a daemon starts with nothing beside its socket, whatever a run it did not outlive left there", async () => {
  // What a script wrote and then ended process 1 under — a signal the daemon takes, a crash: no
  // cleanup ran, and the volume kept all of it for the next container.
  const root = mkdtempSync(join(tmpdir(), "wb-"));
  started.push({ daemon: { stop: async () => {} }, root });
  const socketDirectory = join(root, "s");
  const workRoot = join(root, "work");
  mkdirSync(join(socketDirectory, "locked", "inner"), { recursive: true });
  mkdirSync(join(workRoot, "run-left", "files"), { recursive: true });
  writeFileSync(join(socketDirectory, "note-for-the-next-run"), "hello");
  writeFileSync(join(socketDirectory, "locked", "inner", "note"), "hello");
  writeFileSync(join(workRoot, "run-left", "files", "note"), "hello");
  mkdirSync(join(socketDirectory, "w.sock"));
  writeFileSync(join(socketDirectory, "w.sock", "held"), "x");
  chmodSync(join(socketDirectory, "locked", "inner"), 0o000);
  chmodSync(join(socketDirectory, "locked"), 0o000);
  chmodSync(socketDirectory, 0o000);

  const { workbench } = daemonOn(join(socketDirectory, "w.sock"), workRoot);
  expect(await workbench.health()).toEqual({ busy: false });
  expect(readdirSync(socketDirectory)).toEqual(["w.sock"]);
  expect(readdirSync(workRoot)).toEqual([]);
});

test("a daemon told to leave takes what is beside its socket with it, mid-run or not", async () => {
  // The service's own exit (`main.ts`, on the signal `docker stop` sends) goes through this:
  // synchronous, because the process is ended on the line after.
  const { workbench, socketPath, daemon } = bench();
  const beside = join(dirname(socketPath), "note");
  const running = workbench.run({
    script: `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(beside)}, "for the next run");
      await Bun.sleep(30_000);
    `,
    files: [],
    timeoutMs: 60_000,
  });
  await until(() => existsSync(beside));
  daemon.leave();
  expect(readdirSync(dirname(socketPath))).toEqual([]);
  // Whoever was waiting is told there is no run; nothing is left hanging on a socket that is gone.
  expect((await running).ok).toBe(false);
});

test("a caller that gives up while a run's files are being placed ends the run there, not at its time", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "wb-"));
  started.push({ daemon: { stop: async () => {} }, root: workRoot });
  const gaveUp = new AbortController();
  // Gives up after the first check of the signal and before the script is started: the gap in
  // which, until 2026-10-06, nothing was listening.
  const slow: Runner = {
    ...runner,
    async prepare(directory) {
      await runner.prepare(directory);
      gaveUp.abort();
    },
  };
  let swept = 0;
  const began = performance.now();
  const outcome = await runScript(
    { script: "await Bun.sleep(30_000)", files: [], timeoutMs: 3_000 },
    {
      workRoot,
      runner: slow,
      limits: WORKBENCH_LIMITS,
      sweep: async () => {
        swept += 1;
      },
      signal: gaveUp.signal,
    },
  ).then(
    (ran) => `ran: ${ran.report.ending}`,
    (error: unknown) => (error instanceof Error ? error.name : "?"),
  );
  expect(outcome).toBe("RunAbandonedError");
  expect(performance.now() - began).toBeLessThan(1_500);
  // Nothing was started, so there was nothing to sweep — and nothing is left where it would have run.
  expect(swept).toBe(0);
  expect(readdirSync(workRoot)).toEqual([]);
});
