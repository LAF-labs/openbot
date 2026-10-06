/**
 * THE GUARD IN FRONT OF `kill(-1, SIGKILL)` — tested without ever making the call.
 *
 * The workbench's sweep ends every process its user owns. In the service's container that is one
 * script's leftovers. On the machine that runs these tests it is everything: a developer's whole
 * session, or the CI job. So:
 *
 *   - NOTHING HERE CALLS THE REAL SWEEP. `createSweep` is never imported by a test; the last test
 *     in this file reads the sources to keep that true, and to keep the call itself the single,
 *     unexported one it is.
 *   - What is tested is the guard: `sweepWith`, the function the real sweep is made of, handed
 *     facts of the test's own choosing and a "call" that only counts. For every fact that is not
 *     the sandbox's, alone, the count must stay at zero.
 *   - And the facts of THIS machine, read for real (reading is harmless), must be refused.
 *
 * That the call, once made, does end what a script left behind is shown only where it is safe to
 * make it: in the service's container on Linux (`scripts/workbench-probe.ts`).
 */
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";
import { KEY_VARIABLE } from "../shared/workbench/protocol";
import {
  otherProcesses,
  readSandboxFacts,
  residentBytesOf,
  SANDBOX_UID,
  type SandboxFacts,
  SweepIncompleteError,
  SweepRefusedError,
  sandboxProblems,
  stateIn,
  sweepWith,
} from "../shared/workbench/sweep";

const repository = resolve(import.meta.dir, "..");

/** The sandbox, as the daemon reads it from inside the service's container. */
const sandbox: SandboxFacts = {
  platform: "linux",
  pid: 1,
  uid: SANDBOX_UID,
  externalInterfaces: [],
  capabilityBounding: "0000000000000000",
  noNewPrivileges: true,
  rootReadOnly: true,
  workFilesystem: "tmpfs",
  memoryKept: true,
};

/** Each way of not being the sandbox, one fact at a time, and what the judgement calls it. */
const elsewhere: [string, Partial<SandboxFacts>, string][] = [
  ["not Linux", { platform: "darwin" }, "not_linux"],
  ["not process 1", { pid: 4242 }, "not_process_one"],
  ["root", { uid: 0 }, "runs_as_root"],
  ["a user that is not the sandbox's", { uid: 501 }, "not_the_sandbox_user"],
  ["no user that can be read", { uid: null }, "runs_as_root"],
  ["a network", { externalInterfaces: ["eth0"] }, "has_network"],
  [
    "a capability left in the bounding set",
    { capabilityBounding: "00000000a80425fb" },
    "holds_capabilities",
  ],
  [
    "no bounding set that can be read",
    { capabilityBounding: null },
    "holds_capabilities",
  ],
  [
    "privileges that may still be gained",
    { noNewPrivileges: false },
    "may_gain_privileges",
  ],
  ["a root that can be written", { rootReadOnly: false }, "root_writable"],
  [
    "a work directory on a disk",
    { workFilesystem: "overlay" },
    "work_not_tmpfs",
  ],
  [
    "a work directory that is no mount at all",
    { workFilesystem: null },
    "work_not_tmpfs",
  ],
  ["memory another process may read", { memoryKept: false }, "memory_readable"],
];

test("the sandbox's facts are judged to be the sandbox, and nothing short of them is", () => {
  expect(sandboxProblems(sandbox)).toEqual([]);
  for (const [name, change, problem] of elsewhere) {
    expect(sandboxProblems({ ...sandbox, ...change }), name).toContain(problem);
  }
});

for (const [name, change, problem] of elsewhere) {
  test(`the sweep refuses, before the call, with ${name}`, async () => {
    let calls = 0;
    let looked = 0;
    const attempt = sweepWith({
      facts: () => ({ ...sandbox, ...change }),
      killAll: () => {
        calls += 1;
      },
      others: () => {
        looked += 1;
        return [];
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(SweepRefusedError);
    await attempt.catch((error: SweepRefusedError) => {
      expect(error.problems).toContain(problem);
    });
    // Not made, and nothing after it done either.
    expect(calls).toBe(0);
    expect(looked).toBe(0);
  });
}

test("this machine, read for real, is not the sandbox — and a sweep given its facts makes no call", async () => {
  const facts = readSandboxFacts(tmpdir());
  const problems = sandboxProblems(facts);
  // Whatever else is true of a laptop or a CI runner, the process running a test is not process 1.
  expect(problems).toContain("not_process_one");
  let calls = 0;
  await expect(
    sweepWith({
      facts: () => facts,
      killAll: () => {
        calls += 1;
      },
      others: () => [],
    }),
  ).rejects.toBeInstanceOf(SweepRefusedError);
  expect(calls).toBe(0);
});

test("in the sandbox the call is made once, and the sweep returns only when nothing else runs", async () => {
  let calls = 0;
  const left = [[41, 42], [42], []];
  let looks = 0;
  await sweepWith({
    facts: () => sandbox,
    killAll: () => {
      calls += 1;
    },
    others: () => left[Math.min(looks++, left.length - 1)] ?? [],
  });
  expect(calls).toBe(1);
  expect(looks).toBe(3);
});

test("a sweep that leaves something running says so instead of returning", async () => {
  const attempt = sweepWith({
    facts: () => sandbox,
    killAll: () => {},
    others: () => [77],
    settleMs: 60,
  });
  await expect(attempt).rejects.toBeInstanceOf(SweepIncompleteError);
  await attempt.catch((error: SweepIncompleteError) => {
    expect(error.survivors).toEqual([77]);
  });
});

/** A file's code without its comments: what a file does, not what it says about it. */
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every TypeScript file that could reach the sweep: the product, the scripts, the tests. */
function sources(): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  for (const root of [
    "shared",
    "scripts",
    "tests",
    "server/src",
    "server/tests",
    "server/scripts",
    "agent-bot/src",
    "agent-computer/src",
    "evals",
  ]) {
    for (const file of new Glob("**/*.{ts,tsx}").scanSync({
      cwd: join(repository, root),
    })) {
      if (file.includes("node_modules/")) continue;
      const path = join(root, file);
      found.push({
        path,
        text: withoutComments(readFileSync(join(repository, path), "utf8")),
      });
    }
  }
  return found;
}

test("the call is one line, in one unexported function, and only the service's entry asks for the real sweep", () => {
  const all = sources();
  const sweep = all.find((file) => file.path === "shared/workbench/sweep.ts");
  expect(sweep).toBeDefined();
  const text = sweep?.text ?? "";
  // One call to `kill` in the file, and it is the one inside the guarded function.
  expect(text.match(/\bkill\s*\(/g)).toEqual(["kill("]);
  const guarded = text.slice(text.indexOf("function killEveryOtherProcess("));
  expect(guarded.slice(0, guarded.indexOf("\n}\n"))).toContain(
    'process.kill(-1, "SIGKILL")',
  );
  expect(text).not.toMatch(/export\s+(async\s+)?function\s+killEvery/);
  expect(text).not.toMatch(/export\s*\{[^}]*killEvery/);
  // Signalling every process, written any other way, anywhere else: nowhere.
  const everyProcess = /\bkill\s*\(\s*-\s*1\b/;
  expect(
    all
      .filter(
        (file) =>
          file.path !== "shared/workbench/sweep.ts" &&
          // This file names the call in order to forbid it.
          file.path !== "tests/workbench-sweep.test.ts" &&
          everyProcess.test(file.text),
      )
      .map((file) => file.path),
  ).toEqual([]);
  // The real sweep is asked for by the service's entry and by nothing else — no test, no script.
  expect(
    all
      .filter(
        (file) =>
          file.path !== "shared/workbench/sweep.ts" &&
          file.path !== "tests/workbench-sweep.test.ts" &&
          /\bcreateSweep\b/.test(file.text),
      )
      .map((file) => file.path),
  ).toEqual(["shared/workbench/main.ts"]);
});

test("the service's entry takes one argument and has no way to skip its check", () => {
  const entry = withoutComments(
    readFileSync(join(repository, "shared/workbench/main.ts"), "utf8"),
  );
  // Every flag it reads is `--socket`.
  expect(entry.match(/"--[a-z-]+"/g)).toEqual(['"--socket"']);
  // And of its environment it takes ONE thing — the key every answer is proven under
  // (`shared/workbench/protocol.ts`), read once and taken out — so nothing there can be a switch.
  // It read nothing at all of it until 2026-10-07; a second name here is a second thing to ask
  // about before this line is changed.
  expect(entry.match(/process\.env\b[^\n;]*/g)).toEqual([
    "process.env[KEY_VARIABLE]",
    "process.env[KEY_VARIABLE]",
  ]);
  expect(entry).toContain("const key = process.env[KEY_VARIABLE];");
  expect(entry).toContain("delete process.env[KEY_VARIABLE];");
  expect(KEY_VARIABLE).toBe("WORKBENCH_KEY");
  // And it only runs when it is the program that was started.
  expect(entry).toContain("if (import.meta.main) void main();");
});

/*
 * The key arrives in the daemon's environment, and `/proc/1/environ` asks only to READ: the host's
 * rule about tracing (Yama) keeps a script out of the daemon's memory and not out of that. So the
 * host's rule, which used to be enough, no longer counts at all — only the daemon having closed
 * itself does. Measured on the service: a script's read of `/proc/1/environ` is refused (EACCES).
 */
test("only the daemon's own closing of itself counts as its memory being kept", () => {
  const source = withoutComments(
    readFileSync(join(repository, "shared/workbench/sweep.ts"), "utf8"),
  );
  expect(source).toContain("memoryKept: isUndumpable() === true,");
  // The host's rule is still read, for the line the daemon logs when it listens — and by nothing
  // that decides anything: its one mention in this file is its own definition.
  expect(source.match(/ptraceScope\b/g)).toEqual(["ptraceScope"]);
  // A machine that is not the sandbox keeps nothing, whatever its host's rule is.
  expect(readSandboxFacts(tmpdir()).memoryKept).toBe(false);
});

test("the service's files import nothing but Bun, node and their neighbours in shared/", () => {
  // What lets the service start from any image that carries `shared/` and a Bun: no package of
  // any workspace's, and nothing outside `shared/`. Followed through every file they reach.
  const seen = new Set<string>();
  const outside: string[] = [];
  const follow = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const [, specifier] of text.matchAll(
      /(?:from\s+|import\s*\(\s*|^import\s+)"([^"]+)"/gm,
    )) {
      if (!specifier) continue;
      if (specifier.startsWith("node:") || specifier.startsWith("bun:")) {
        continue;
      }
      if (specifier === "bun") continue;
      const target = specifier.startsWith(".")
        ? resolve(dirname(file), `${specifier}.ts`)
        : null;
      if (
        !target ||
        relative(join(repository, "shared"), target).startsWith("..")
      ) {
        outside.push(`${relative(repository, file)} → ${specifier}`);
        continue;
      }
      follow(target);
    }
  };
  for (const name of readdirSync(join(repository, "shared/workbench"))) {
    follow(join(repository, "shared/workbench", name));
  }
  expect(outside).toEqual([]);
  // It did follow something: the entry, the daemon, and what they share with the converter.
  expect(seen.has(join(repository, "shared/isolation.ts"))).toBe(true);
  expect(seen.has(join(repository, "shared/log.ts"))).toBe(true);
});

test("the daemon closes its own memory where there is a kernel to ask, and says no where there is not", async () => {
  // In a child of its own: declaring a process undumpable changes who owns its entries under
  // /proc, and the process running every other test should stay as it was.
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
        import { isUndumpable } from ${JSON.stringify(join(repository, "shared/workbench/sweep.ts"))};
        import { makeUndumpable } from ${JSON.stringify(join(repository, "shared/workbench/undumpable.ts"))};
        const before = isUndumpable();
        const said = await makeUndumpable();
        console.log(JSON.stringify({ before, said, after: isUndumpable(), uid: process.getuid() }));
      `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, problem, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, problem }).toEqual({ code: 0, problem: "" });
  const measured = JSON.parse(out) as {
    before: boolean | null;
    said: boolean;
    after: boolean | null;
    uid: number;
  };
  if (process.platform !== "linux") {
    // No such call here: it says it did nothing, and the reading says it cannot tell.
    expect(measured).toMatchObject({ before: null, said: false, after: null });
  } else if (measured.uid === 0) {
    // Root's entries are root's either way, so the reading cannot tell; the call still succeeds.
    expect(measured).toMatchObject({ before: null, said: true, after: null });
  } else {
    expect(measured).toMatchObject({ before: false, said: true, after: true });
  }
});

test("a state is the field after the LAST closing bracket: a name may hold brackets and spaces of its own", () => {
  expect(stateIn("42 (bun) S 1 42 42 0 -1")).toBe("S");
  expect(stateIn("42 (a) b) c) Z 1 42")).toBe("Z");
  expect(stateIn("7 (sleep 600 (x)) R 1")).toBe("R");
  expect(stateIn("")).toBe("");
});

/*
 * A PROCESS WHOSE LEADER HAS EXITED WHILE A THREAD RUNS ON. Its own line in `/proc` reads `Z` and
 * reports no memory; it is alive and holding whatever its threads hold. Read by its leader's
 * letter alone, as it was until 2026-10-06, it was unseen by the check that nothing survived a
 * sweep and by the watch on a run's memory — measured on the service itself: 623 MB held, the run
 * never ended for it (the rehearsal's log has both the kernel's account and that run).
 *
 * Made here for real where there is a `/proc` to make it in: a child of this test whose main
 * thread leaves by the THREAD's exit call with a worker still running. Only read after that, and
 * ended by its own pid. Elsewhere there is nothing to read, and the test says so by its name.
 */
test.skipIf(process.platform !== "linux")(
  "a process whose leader has exited but whose thread runs on is seen as running, and its memory is read",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "wb-led-"));
    writeFileSync(
      join(directory, "held.ts"),
      "const held = new Uint8Array(48 * 1024 * 1024).fill(1); setInterval(() => held[0], 1000);",
    );
    writeFileSync(
      join(directory, "leader.ts"),
      [
        'import { dlopen } from "bun:ffi";',
        'new Worker(new URL("./held.ts", import.meta.url).href);',
        "await Bun.sleep(500);",
        // The exit of the calling THREAD, not of the process: 93 on arm64, 60 on x86-64.
        'dlopen("libc.so.6", { syscall: { args: ["i64", "i64"], returns: "i64" } }).symbols.syscall(process.arch === "arm64" ? 93 : 60, 0);',
      ].join("\n"),
    );
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", join(directory, "leader.ts")],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    try {
      const leader = () =>
        stateIn(readFileSync(`/proc/${child.pid}/stat`, "utf8"));
      const deadline = Date.now() + 10_000;
      while (leader() !== "Z" && Date.now() < deadline) await Bun.sleep(50);
      // The kernel's own word for it: dead, by its leader's line.
      expect(leader()).toBe("Z");
      expect(readFileSync(`/proc/${child.pid}/status`, "utf8")).not.toContain(
        "VmRSS",
      );
      // And what this file now says of it: running, and holding what its worker holds.
      expect(otherProcesses()).toContain(child.pid);
      expect(residentBytesOf(child.pid)).toBeGreaterThan(48 * 1024 * 1024);
    } finally {
      process.kill(child.pid, "SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
