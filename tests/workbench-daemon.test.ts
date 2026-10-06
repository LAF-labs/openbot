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
  readFileSync,
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
  isProven,
  isRunPath,
  JOB_PART,
  NONCE_HEADER,
  newNonce,
  PROOF_HEADER,
  RUN_PATH_SEGMENTS,
  SCRIPT_PART,
  WORKBENCH_LIMITS,
} from "../shared/workbench/protocol";
import {
  emptyDirectory,
  emptyDirectorySync,
  isRequestsFault,
  runScript,
  type WorkbenchLimits,
} from "../shared/workbench/run";
import { bunTypeScript, type Runner } from "../shared/workbench/runner";

const repository = join(import.meta.dir, "..");

/** The daemon's log, unread: what it writes is facts about runs, and the tests ask the runs. */
const quiet: Logger = { svc: "workbench", info() {}, warn() {}, error() {} };

/** The key both ends are given, as compose gives a deployment's to both from its environment. */
const KEY = "the-key-of-a-deployment-in-tests-0123456789abcdef";

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
    key: KEY,
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
    // Nothing at the path is waited for a quarter of a second here, where a server waits four.
    workbench: createWorkbench({
      socketPath,
      key: KEY,
      limits,
      log: quiet,
      absentMs: 250,
    }),
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
  // Asked by hand, as nothing of ours asks: the daemon itself refuses a second run.
  const second = await rawRun(socketPath, { files: [] });
  expect(second.status).toBe(503);
  expect(await second.json()).toMatchObject({ code: "laf:workbench_busy" });
  // And there is no other caller in this process to be refused: a second client for the same
  // socket IS the first, so whatever asks through it waits its turn in the one queue.
  expect(createWorkbench({ socketPath, key: KEY, log: quiet })).toBe(workbench);
  expect(ran(await long).run.stdout).toBe("done\n");
  expect(await workbench.health()).toMatchObject({ busy: false });
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

/*
 * A NAME NEED NOT BE TEXT (the second independent read, 2026-10-06). On Linux a name is any bytes
 * but `/` and NUL. Listed as text, `6e ff` comes back as "n" and the mark for "not a character",
 * and a path built from that names nothing — so removing it removed nothing, and said nothing.
 * Measured on the service before the fix: every one of these outlived its run, and the daemon
 * answered as though it had cleaned. Only where a filesystem takes such a name, which APFS does
 * not: this runs on the machine CI has, and the rehearsal tries it on the service itself.
 */
test.skipIf(process.platform !== "linux")(
  "a name that is not text is removed like any other, wherever a script left it",
  async () => {
    const { workbench, socketPath, scratch, workRoot, quits } = bench();
    const socketDirectory = join(socketPath, "..");
    const answer = ran(
      await workbench.run({
        script: `
          import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
          const name = Buffer.from([0x6e, 0xff]);
          const under = (directory, leaf = name) => Buffer.concat([Buffer.from(directory + "/"), leaf]);
          for (const directory of [${JSON.stringify(workRoot)}, ${JSON.stringify(socketDirectory)}, ${JSON.stringify(scratch)}, "."]) {
            writeFileSync(under(directory), "left");
          }
          // And a folder of such a name with such a name in it, closed to its own user.
          const closed = under(${JSON.stringify(workRoot)}, Buffer.from([0x64, 0xfe]));
          mkdirSync(closed);
          writeFileSync(Buffer.concat([closed, Buffer.from("/"), name]), "left");
          chmodSync(closed, 0o000);
          console.log("left");
        `,
        files: [],
      }),
    );
    expect(answer.run.stdout).toBe("left\n");
    const byBytes = (directory: string) =>
      readdirSync(directory, { encoding: "buffer" }).map((name) =>
        Buffer.from(name).toString("hex"),
      );
    expect(byBytes(workRoot)).toEqual([]);
    expect(byBytes(socketDirectory)).toEqual([
      Buffer.from("w.sock").toString("hex"),
    ]);
    expect(byBytes(scratch)).toEqual([]);
    // Clean without having had to stop: nothing was left for a fresh container to clear.
    expect(quits).toEqual([]);
  },
);

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
    key: KEY,
    workRoot: join(root, "work"),
    runner,
    problems: () => [],
    sweep: async () => {},
    log: quiet,
    quit: () => {},
  });
  started.push({ daemon, root });
  expect(
    await createWorkbench({ socketPath, key: KEY, log: quiet }).health(),
  ).toMatchObject({ busy: false });
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
    key: KEY,
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
    workbench: createWorkbench({ socketPath, key: KEY, log: quiet }),
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
  expect(await second.workbench.health()).toMatchObject({ busy: false });
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
  expect(await workbench.health()).toMatchObject({ busy: false });
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

test("a path is at most sixteen folders deep, so the files of one request cannot use up the work root's names", async () => {
  expect(RUN_PATH_SEGMENTS).toBe(16);
  const deep = (segments: number) =>
    Array.from({ length: segments }, () => "d").join("/");
  expect(isRunPath(deep(16))).toBe(true);
  expect(isRunPath(deep(17))).toBe(false);
  // Eight files, five hundred folders each: four thousand names of the 4,096 the work root has.
  // Taken, as it was, the ninth `mkdir` failed for want of one and the daemon QUIT — a request's
  // mistake answered by ending the service.
  const { socketPath, quits, swept } = bench();
  const response = await rawRun(
    socketPath,
    { files: [{ path: `${deep(500)}/a.csv`, part: filePart(0) }] },
    { file0: "x" },
  );
  expect([response.status, await response.json()]).toEqual([
    400,
    {
      error: "laf:workbench_request_invalid",
      code: "laf:workbench_request_invalid",
      field: "files",
    },
  ]);
  expect(swept()).toBe(0);
  expect(quits).toEqual([]);
});

test("a file that cannot be placed for want of room is the request's fault; a disk that fails is not", () => {
  for (const code of [
    "EEXIST",
    "ENOTDIR",
    "EISDIR",
    "ENAMETOOLONG",
    "ENOSPC",
    "EDQUOT",
    "EMLINK",
  ]) {
    expect(isRequestsFault(code), code).toBe(true);
  }
  for (const code of ["EACCES", "EIO", "EROFS", "EPERM", ""]) {
    expect(isRequestsFault(code), code).toBe(false);
  }
});

/*
 * WHAT THE SECOND INDEPENDENT READ OF 2026-10-06 FOUND: A SCRIPT CAN MEET THE SOCKET. It runs as
 * the daemon's own user, so the directory the socket is bound in is its to write: it can remove
 * the socket and bind a listener of its own at the path. Measured on the service before the fix —
 * the server's `health()` answered by a script, and the run behind an abandoned one handed to what
 * that one left running, three times of three. No owner or mode keeps one's own user out, so the
 * daemon proves each answer under a key a script cannot read, and the client believes nothing
 * without that and sends nothing before it (`shared/workbench/protocol.ts`).
 */

/** Ask the socket's path as nothing of ours does: no number, and whatever answers is read. */
const whoSays = async (socketPath: string): Promise<unknown> => {
  try {
    const response = await fetch("http://workbench/health", {
      unix: socketPath,
      signal: AbortSignal.timeout(1_000),
    });
    return ((await response.json()) as { boot?: unknown }).boot;
  } catch {
    return null;
  }
};

test("the daemon proves every answer it gives, to the request it gives it to", async () => {
  const { socketPath, logged } = bench();
  const asked = async (
    method: "GET" | "POST",
    path: string,
    body?: FormData,
  ) => {
    const nonce = newNonce();
    const response = await fetch(`http://workbench${path}`, {
      unix: socketPath,
      method,
      headers: { [NONCE_HEADER]: nonce },
      ...(body ? { body } : {}),
    });
    const answered = {
      route: `${method} ${path}`,
      nonce,
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      body: new Uint8Array(await response.arrayBuffer()),
    };
    return { answered, proof: response.headers.get(PROOF_HEADER) };
  };
  const form = (job: string, script: string) => {
    const made = new FormData();
    made.set(JOB_PART, job);
    made.set(SCRIPT_PART, new Blob([script]));
    return made;
  };
  const each = [
    await asked("GET", "/health"),
    // The refusals: a route there is none of, and a request that is not a run.
    await asked("GET", "/nothing"),
    await asked("POST", "/run", form("{", "console.log(1)")),
    // And a run, whose answer is a form of the report and a file.
    await asked(
      "POST",
      "/run",
      form(
        JSON.stringify({ files: [] }),
        'await Bun.write("out/made.txt", "made"); console.log(1)',
      ),
    ),
  ];
  expect(each.map(({ answered }) => answered.status)).toEqual([
    200, 404, 400, 200,
  ]);
  for (const { answered, proof } of each) {
    expect(isProven(KEY, answered, proof), answered.route).toBe(true);
    // Of that answer to that request, and of nothing else.
    expect(isProven(`${KEY}x`, answered, proof)).toBe(false);
    expect(isProven(KEY, { ...answered, nonce: newNonce() }, proof)).toBe(
      false,
    );
    expect(
      isProven(
        KEY,
        { ...answered, body: new Uint8Array([...answered.body, 0x20]) },
        proof,
      ),
    ).toBe(false);
  }
  expect(each[3]?.answered.type).toStartWith("multipart/form-data; boundary=");
  // A proof of health is not a proof of a run that says the same bytes.
  const health = each[0];
  expect(
    health &&
      isProven(KEY, { ...health.answered, route: "POST /run" }, health.proof),
  ).toBe(false);
  // Whoever brings no number is answered, and proven nothing.
  const bare = await fetch("http://workbench/health", { unix: socketPath });
  expect(bare.status).toBe(200);
  expect(bare.headers.get(PROOF_HEADER)).toBeNull();
  // The key crosses nothing: not an answer, not the log.
  expect(logged.join("\n")).not.toContain(KEY);
  for (const { answered } of each) {
    expect(new TextDecoder().decode(answered.body)).not.toContain(KEY);
  }
});

test("while a script sits where the socket was, what it says there is believed by nobody", async () => {
  const { workbench, socketPath, quits } = bench();
  const taking = workbench.run({
    script: `
      import { unlinkSync } from "node:fs";
      unlinkSync(${JSON.stringify(socketPath)});
      Bun.serve({
        unix: ${JSON.stringify(socketPath)},
        fetch: () => Response.json({ status: "ok", busy: false, boot: "a script" }),
      });
      console.log("took it");
      await Bun.sleep(1200);
      process.exit(0);
    `,
    files: [],
    timeoutMs: 20_000,
  });
  await until(async () => (await whoSays(socketPath)) === "a script");
  // It says it is an idle daemon. It was believed: `health()` answered `{ busy: false }`.
  expect(await workbench.health()).toBeNull();
  // The script's own run is still answered — its connection was made before it ran — and then
  // the daemon, finding its path no longer its own, stops.
  expect(ran(await taking).run.stdout).toBe("took it\n");
  await until(() => quits.length > 0);
  expect(quits).toEqual(["socket_replaced"]);
});

test("the run behind one that was given up on is not handed to what that one left at the socket's path", async () => {
  // Where what the script leaves running says which process it is, and keeps what it is sent.
  const left = mkdtempSync(join(tmpdir(), "wb-left-"));
  started.push({ daemon: { stop: async () => {} }, root: left });
  const program = join(left, "taker.ts");
  const pidFile = join(left, "pid");
  const got = join(left, "got");
  /** End the one process this test left, and only if it is that process. */
  const endWhatWasLeft = () => {
    if (!existsSync(pidFile)) return;
    const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    if (!Number.isInteger(pid) || pid <= 1) return;
    const command = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    if (command.includes(program)) process.kill(pid, "SIGKILL");
  };
  try {
    const { workbench, socketPath, quits } = bench({
      // What the real sweep does, as far as this run needs it done: a moment later — the window —
      // the one process the run left is ended.
      sweep: async () => {
        await Bun.sleep(300);
        endWhatWasLeft();
      },
    });
    const taker = `
      import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
      try { unlinkSync(${JSON.stringify(socketPath)}); } catch {}
      Bun.serve({
        unix: ${JSON.stringify(socketPath)},
        async fetch(request) {
          if (new URL(request.url).pathname === "/health") {
            return Response.json({ status: "ok", busy: false, boot: "a script" });
          }
          appendFileSync(${JSON.stringify(got)}, new Uint8Array(await request.arrayBuffer()));
          const answer = new FormData();
          answer.set("report", JSON.stringify({ ending: "exited", exitCode: 0, signal: null, ms: 1, stdout: "A SCRIPT ANSWERED", stderr: "", stdoutBytes: 17, stderrBytes: 0, products: [], skipped: 0 }));
          return new Response(answer);
        },
      });
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const gaveUp = new AbortController();
    const given = workbench.run(
      {
        script: `
          import { writeFileSync } from "node:fs";
          writeFileSync(${JSON.stringify(program)}, ${JSON.stringify(taker)});
          Bun.spawn([process.execPath, "--no-install", ${JSON.stringify(program)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
          await Bun.sleep(30_000);
        `,
        files: [],
        timeoutMs: 60_000,
      },
      gaveUp.signal,
    );
    await until(async () => (await whoSays(socketPath)) === "a script");
    const behind = workbench.run({
      script: 'console.log("the daemon ran this")',
      files: [
        { path: "uploads/next.csv", bytes: text("the next run's workbook") },
      ],
    });
    gaveUp.abort();
    expect(await given).toEqual({ ok: false, failure: "stopped" });
    // It came back as the child's answer, "A SCRIPT ANSWERED", with the run's script and file in
    // the child's hands. Now: what is there proves nothing, is sent nothing, and once it has been
    // ended nothing is there at all — the daemon's path is no longer its own, and it has stopped.
    expect(await behind).toEqual({ ok: false, failure: "unavailable" });
    expect(existsSync(got)).toBe(false);
    await until(() => quits.length > 0);
    expect(quits).toEqual(["socket_replaced"]);
  } finally {
    endWhatWasLeft();
  }
});

/*
 * A TREE DEEPER THAN A PATH MAY BE LONG, AND CLOSED AT THE BOTTOM (the third read of 2026-10-07).
 * Removing a tree walks down it however deep it goes; opening up a folder a script closed went by
 * its path, and a path has a longest — 1,024 bytes on a laptop, 4,096 on Linux. A script can build
 * past it without ever naming it: two halves, and one moved under the other. Before the fix the
 * cleanup threw (EACCES; ENAMETOOLONG from its synchronous twin) and the tree stayed — which
 * beside the socket, the one place that outlives the container, is a daemon that cannot start
 * again for as long as anything holds that volume.
 */

/** Folders of 255 bytes in each half: enough, together, to pass the limit of the machine this is. */
const HALVES = process.platform === "linux" ? [8, 8] : [2, 3];

/** The builder as source: what a script would write, and what the tests that need no daemon run. */
const deepClosedTrees = (places: readonly string[]) => `
  import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
  const name = (letter) => letter.repeat(255);
  const chain = (root, letter, levels) => { let path = root; for (let n = 0; n < levels; n += 1) path += "/" + name(letter); return path; };
  for (const place of ${JSON.stringify(places)}) {
    mkdirSync(chain(place, "a", ${HALVES[0]}), { recursive: true });
    // The lower half beside it under a short name; its last folder holds a file and is closed.
    const lower = chain(place + "/b", "b", ${(HALVES[1] ?? 1) - 1});
    mkdirSync(lower, { recursive: true });
    writeFileSync(lower + "/held", "x");
    chmodSync(lower, 0o000);
    renameSync(place + "/b", chain(place, "a", ${HALVES[0]}) + "/" + name("b"));
  }
  console.log("built");
`;

const buildDeepClosedTree = (place: string) => {
  const built = Bun.spawnSync([
    process.execPath,
    "-e",
    deepClosedTrees([place]),
  ]);
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
};

test("a tree deeper than a path may be long, closed at the bottom, is emptied all the same", async () => {
  const levels = (HALVES[0] ?? 0) + (HALVES[1] ?? 0);
  for (const empty of [
    emptyDirectory,
    async (directory: string) => emptyDirectorySync(directory),
  ]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wd-")));
    started.push({ daemon: { stop: async () => {} }, root });
    buildDeepClosedTree(root);
    // Past what a path may be: nothing here could have named the bottom of it.
    expect(root.length + levels * 256).toBeGreaterThan(
      process.platform === "linux" ? 4096 : 1024,
    );
    expect(readdirSync(root)).toHaveLength(1);
    await empty(root);
    expect(readdirSync(root)).toEqual([]);
  }
});

test("a script that builds such a tree beside the socket, in the work root and in shared memory leaves none of it", async () => {
  const { workbench, socketPath, scratch, workRoot, quits } = bench();
  const socketDirectory = realpathSync(join(socketPath, ".."));
  const places = [
    socketDirectory,
    realpathSync(workRoot),
    realpathSync(scratch),
  ];
  const answer = ran(
    await workbench.run({
      script: deepClosedTrees(places),
      files: [],
      timeoutMs: 30_000,
    }),
  );
  expect(answer.run.stdout).toBe("built\n");
  expect(readdirSync(socketDirectory)).toEqual(["w.sock"]);
  expect(readdirSync(workRoot)).toEqual([]);
  expect(readdirSync(scratch)).toEqual([]);
  // Cleared without the daemon having had to stop — and a daemon that starts on the same socket
  // afterwards finds nothing in its way.
  expect(quits).toEqual([]);
  expect(
    ran(await workbench.run({ script: "console.log('next')", files: [] })).run
      .stdout,
  ).toBe("next\n");
});
