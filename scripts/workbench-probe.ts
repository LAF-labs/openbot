/**
 * THE WORKBENCH, MEASURED WHERE IT IS REAL: the service compose defines, on Linux, with scripts
 * that try each wall.
 *
 * Everything the workbench promises is a property of its container — no network, a read-only
 * root, a user with nothing, nothing of one run left for the next. None of that can be shown by a
 * test on the machine that runs the tests (`tests/workbench-daemon.test.ts` says so at its top),
 * and one part of it must never be tried there: the sweep ends every process its user owns
 * (`shared/workbench/sweep.ts`). So this is where it is tried. It is the only place anything in
 * this repository reaches that call.
 *
 * TWO HALVES, ONE FILE.
 *
 *  - `rehearseWorkbench` runs on the machine that runs `scripts/upgrade-e2e.ts`, after the upgrade
 *    it rehearses. It first holds the upgrade to having started NO workbench — the service is
 *    behind a profile, and nothing uses it yet — then starts it the way a deployment would, reads
 *    what the engine made of it and what it idles at, and starts a second container on the same
 *    socket volume to run the other half.
 *  - Run as a program (`bun workbench-probe.ts <socket>`), inside that second container: the
 *    server's image, the server's own client (`server/src/workbench/client.ts`), the real daemon
 *    on the other end of a socket the two containers share. It sends scripts that try to leave —
 *    by the network, by the filesystem, by outliving their run, by stopping the daemon — and
 *    prints what happened as one line of JSON.
 *
 * The second half is never started anywhere but there. Its first act is to ask a script where it
 * is, and when the answer is not the sandbox it stops, having sent nothing else.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  createWorkbench,
  type WorkbenchAnswer,
} from "../server/src/workbench/client";
import { createLogger } from "../shared/log";

/** One thing measured. `ok: null` is "could not be measured here", said rather than passed. */
export type ProbeCheck = { name: string; ok: boolean | null; detail: string };

/** What the line the inner half prints starts with, so it is found among anything else printed. */
export const PROBE_RESULT = "WORKBENCH_PROBE_RESULT ";

const SOCKET_DIRECTORY = "/run/laf-workbench";
const SOCKET = `${SOCKET_DIRECTORY}/workbench.sock`;

// --- the scripts a probe sends. `String.raw` where one holds a backslash, so that it arrives. ----

/** Where a script finds itself, and what it can reach from there. */
const WHERE = String.raw`
import { openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
const status = readFileSync("/proc/self/status", "utf8");
const field = (name) => status.match(new RegExp("^" + name + ":\\s*(.+)$", "m"))?.[1]?.trim() ?? null;
const mounts = readFileSync("/proc/self/mounts", "utf8").trim().split("\n").map((line) => line.split(" "));
const mount = (at) => (mounts.filter((fields) => fields[1] === at).at(-1) ?? []).slice(2, 4).join(" ");
const who = {
  uid: process.getuid(), pid: process.pid, parent: process.ppid,
  interfaces: Object.entries(networkInterfaces())
    .filter(([, addresses]) => (addresses ?? []).some((address) => !address.internal)).map(([name]) => name),
  bounding: field("CapBnd"), effective: field("CapEff"), permitted: field("CapPrm"),
  noNewPrivileges: field("NoNewPrivs"), seccomp: field("Seccomp"),
};
// Who and where, before anything is TRIED: outside the sandbox this script says so and does nothing.
if (who.uid !== 65534 || who.parent !== 1 || who.interfaces.length > 0) {
  console.log(JSON.stringify(who));
  process.exit(0);
}
const writable = [];
for (const fields of mounts) {
  const probe = (fields[1] === "/" ? "" : fields[1]) + "/.laf-probe";
  try { writeFileSync(probe, "x"); unlinkSync(probe); writable.push(fields[1]); } catch {}
}
const elsewhere = {};
for (const path of ["/app/x", "/tmp/x", "/var/tmp/x", "/run/x", "/etc/x", "/home/x", "/x"]) {
  try { writeFileSync(path, "x"); elsewhere[path] = "written"; } catch (error) { elsewhere[path] = error.code; }
}
const reached = {};
for (const [name, url] of [
  ["public", "http://1.1.1.1/"],
  ["metadata", "http://169.254.169.254/"],
  ["server", "http://server:3001/api/health"],
  ["bridge", "http://172.17.0.1/"],
]) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }); reached[name] = "answered"; }
  catch (error) { reached[name] = error.code ?? error.name; }
}
let daemonMemory;
try { openSync("/proc/1/mem", "r"); daemonMemory = "opened"; } catch (error) { daemonMemory = error.code; }
console.log(JSON.stringify({
  ...who,
  root: mount("/"), work: mount("/work"), socket: mount("/run/laf-workbench"),
  writable, elsewhere, reached, daemonMemory,
}));
`;

/** Every process a script can see, with its state. Shared by the two scripts below. */
const PROCESSES = String.raw`
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const processes = () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map((pid) => {
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    const command = readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0").filter(Boolean).join(" ");
    return { pid: Number(pid), state, command };
  } catch { return { pid: Number(pid), state: "?", command: "" }; }
});
const NOTES = ["/work/note", "/dev/shm/note", "/run/laf-workbench/note"];
`;

/** Leave something for the next run everywhere a script can: three notes and two processes. */
const LEAVE = `${PROCESSES}
const left = {};
for (const path of NOTES) {
  try { writeFileSync(path, "for the next run"); left[path] = "written"; } catch (error) { left[path] = error.code; }
}
// A child that outlives the script, and one that has left its session and its parent behind.
// By their full paths: a script is started with no PATH.
Bun.spawn(["/bin/sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
Bun.spawnSync(["/bin/sh", "-c", "/usr/bin/setsid /usr/bin/nohup /bin/sleep 601 >/dev/null 2>&1 &"]);
await Bun.sleep(300);
console.log(JSON.stringify({ left, processes: processes() }));
`;

/** What a run finds of the runs before it. */
const LOOK = `${PROCESSES}
console.log(JSON.stringify({
  notes: NOTES.filter((path) => existsSync(path)),
  work: readdirSync("/work"), shm: readdirSync("/dev/shm"), socket: readdirSync("/run/laf-workbench"),
  self: process.pid, processes: processes(),
}));
`;

const SHEET = `
import * as XLSX from "xlsx";
const book = XLSX.read(await Bun.file("uploads/sales.csv").text(), { type: "string" });
const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
const total = rows.reduce((sum, row) => sum + row.amount, 0);
const made = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(made, XLSX.utils.aoa_to_sheet([["total"], [total]]), "total");
await Bun.write("out/total.xlsx", XLSX.write(made, { type: "buffer", bookType: "xlsx" }));
console.log("total " + total);
`;

type Seen = {
  pid: number;
  state: string;
  command: string;
};

/**
 * The inner half: what happens to each script, from the far side of the socket. Each thing
 * measured is added to `checks` as it is, so that a probe which cannot go on still says what it
 * had found.
 */
async function probe(socketPath: string, checks: ProbeCheck[]): Promise<void> {
  const check = (name: string, ok: boolean | null, detail: string) => {
    checks.push({ name, ok, detail });
  };
  const log = createLogger("workbench-probe");
  const workbench = createWorkbench({ socketPath, log });
  const run = (script: string, extra: { timeoutMs?: number } = {}) =>
    workbench.run({ script, files: [], ...extra });
  const said = (answer: WorkbenchAnswer) =>
    answer.ok ? answer.run.stdout.trim() : `no run: ${answer.failure}`;
  const json = <T>(answer: WorkbenchAnswer): T | null => {
    if (!answer.ok) return null;
    try {
      return JSON.parse(answer.run.stdout) as T;
    } catch {
      return null;
    }
  };
  /** Which daemon answers, by the name it gave itself at start; null while none does. */
  const health = async () => {
    try {
      const response = await fetch("http://workbench/health", {
        unix: socketPath,
        signal: AbortSignal.timeout(2_000),
      });
      return (await response.json()) as { boot?: string; busy?: boolean };
    } catch {
      return null;
    }
  };
  /** Wait for a daemon that answers and is running nothing; say which one it is. */
  const settled = async (ms = 60_000): Promise<string> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const now = await health();
      if (now?.busy === false && typeof now.boot === "string") return now.boot;
      if (Date.now() > deadline) {
        throw new Error(`no idle daemon answered within ${ms / 1000} s`);
      }
      await Bun.sleep(250);
    }
  };
  /** Wait for a daemon other than `was` — the container having been started again. */
  const restarted = async (was: string, ms = 60_000): Promise<string> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const now = await health();
      if (now?.busy === false && typeof now.boot === "string") {
        if (now.boot !== was) return now.boot;
      }
      if (Date.now() > deadline) {
        throw new Error(`the same daemon still answers after ${ms / 1000} s`);
      }
      await Bun.sleep(250);
    }
  };

  let boot = await settled();
  const mounted = readFileSync("/proc/self/mounts", "utf8")
    .split("\n")
    .filter((line) => line.split(" ")[1] === SOCKET_DIRECTORY)
    .at(-1);
  check(
    "the socket's volume is one megabyte of memory, shared by two containers",
    /^\S+ \S+ tmpfs \S*size=1024k/.test(mounted ?? ""),
    `a second container reached the daemon through it; mounted there as: ${mounted ?? "nothing"}`,
  );

  // WHERE A SCRIPT IS. First, because everything after this is only fit to send to the sandbox.
  const first = await run(WHERE);
  const where = json<{
    uid: number;
    pid: number;
    parent: number;
    interfaces: string[];
    bounding: string | null;
    effective: string | null;
    permitted: string | null;
    noNewPrivileges: string | null;
    seccomp: string | null;
    root: string;
    work: string;
    socket: string;
    writable: string[];
    elsewhere: Record<string, string>;
    reached: Record<string, string>;
    daemonMemory: string;
  }>(first);
  const zero = (mask: string | null) => mask !== null && /^0+$/.test(mask);
  const isSandbox =
    where !== null &&
    where.uid === 65534 &&
    where.parent === 1 &&
    where.interfaces.length === 0 &&
    zero(where.bounding);
  check(
    "a script runs as nobody, a child of process 1, with no capability and none to gain",
    isSandbox &&
      zero(where.effective) &&
      zero(where.permitted) &&
      where.noNewPrivileges === "1",
    where
      ? JSON.stringify({
          uid: where.uid,
          parent: where.parent,
          bounding: where.bounding,
          effective: where.effective,
          permitted: where.permitted,
          noNewPrivileges: where.noNewPrivileges,
          seccomp: where.seccomp,
        })
      : first.ok
        ? `the script did not say where it was: exit ${first.run.exitCode}, ${first.run.ending}; stderr ${JSON.stringify(first.run.stderr.slice(0, 400))}`
        : `no run: ${first.failure}`,
  );
  if (!isSandbox || !where) {
    check(
      "everything else about the workbench",
      false,
      "the first script did not find itself in the sandbox, so no other script was sent",
    );
    return;
  }
  check(
    "a script has no network: no interface, and nothing answers",
    where.interfaces.length === 0 &&
      Object.values(where.reached).every((how) => how !== "answered"),
    JSON.stringify({ interfaces: where.interfaces, reached: where.reached }),
  );
  const emptied = ["/work", SOCKET_DIRECTORY, "/dev/shm", "/dev/mqueue"];
  check(
    "a script can write only where the daemon empties after it",
    where.writable.includes("/work") &&
      where.writable.every((at) => emptied.includes(at)) &&
      Object.values(where.elsewhere).every((how) => how !== "written") &&
      /^\S+ ro(,|$)/.test(where.root) &&
      /^tmpfs \S*noexec/.test(where.work) &&
      where.work.includes("size=98304k") &&
      where.work.includes("nr_inodes=4096"),
    JSON.stringify({
      writable: where.writable,
      elsewhere: where.elsewhere,
      // The root's kind and whether it may be written; the rest of that line is the image's layers.
      root: where.root.split(",")[0],
      work: where.work,
      socket: where.socket,
    }),
  );
  check(
    "a script cannot open the daemon's memory",
    where.daemonMemory !== "opened",
    `open("/proc/1/mem"): ${where.daemonMemory}`,
  );

  // A SCRIPT DOES WHAT IT IS FOR.
  const sheet = await workbench.run({
    script: SHEET,
    files: [
      {
        path: "uploads/sales.csv",
        bytes: new TextEncoder().encode("day,amount\nmon,10\ntue,20\nwed,30\n"),
      },
    ],
  });
  check(
    "a script reads the file it was handed with SheetJS and hands back a workbook",
    sheet.ok &&
      sheet.run.exitCode === 0 &&
      sheet.run.stdout === "total 60\n" &&
      sheet.products.length === 1 &&
      sheet.products[0]?.name === "total.xlsx" &&
      sheet.products[0].bytes[0] === 0x50 &&
      sheet.products[0].bytes[1] === 0x4b,
    sheet.ok
      ? `${said(sheet)} in ${sheet.run.ms} ms; ${sheet.products.map((product) => `${product.name} (${product.bytes.byteLength} bytes)`).join(", ") || "no file"}; stderr ${JSON.stringify(sheet.run.stderr.slice(0, 300))}`
      : said(sheet),
  );

  // NOTHING OF ONE RUN IS THERE FOR THE NEXT — the sweep, for real.
  const leaving = json<{ left: Record<string, string>; processes: Seen[] }>(
    await run(LEAVE),
  );
  const leftRunning = (leaving?.processes ?? []).filter((process) =>
    process.command.includes("sleep 60"),
  );
  const looking = json<{
    notes: string[];
    work: string[];
    shm: string[];
    socket: string[];
    self: number;
    processes: Seen[];
  }>(await run(LOOK));
  const alive = (looking?.processes ?? []).filter(
    (process) => process.state !== "Z" && process.state !== "X",
  );
  check(
    "a process a script left running is gone before the next run (the sweep)",
    leftRunning.length === 2 &&
      looking !== null &&
      alive.length === 2 &&
      alive.every(
        (process) => process.pid === 1 || process.pid === looking.self,
      ),
    `left running: ${JSON.stringify(leftRunning)}; the next run saw alive: ${JSON.stringify(alive)}, dead and unwaited: ${(looking?.processes ?? []).length - alive.length}`,
  );
  check(
    "a note a script left anywhere it can write is gone before the next run",
    leaving !== null &&
      leaving.left["/work/note"] === "written" &&
      looking !== null &&
      looking.notes.length === 0 &&
      looking.work.length === 1 &&
      looking.shm.length === 0 &&
      looking.socket.join() === "workbench.sock",
    `left: ${JSON.stringify(leaving?.left)}; the next run found notes ${JSON.stringify(looking?.notes)}, /work ${JSON.stringify(looking?.work)}, /dev/shm ${JSON.stringify(looking?.shm)}, the socket's directory ${JSON.stringify(looking?.socket)}`,
  );

  // THE BOUNDS.
  const endless = await run("for (;;) {}", { timeoutMs: 1_500 });
  check(
    "a script that never ends is ended at its time",
    endless.ok && endless.run.ending === "timed_out",
    endless.ok
      ? `${endless.run.ending} after ${endless.run.ms} ms of 1500`
      : said(endless),
  );
  const greedy = await run(
    "const held = []; for (;;) { held.push(new Uint8Array(16 * 1024 * 1024).fill(1)); await Bun.sleep(20); }",
    { timeoutMs: 60_000 },
  );
  check(
    "a script that takes more than 512 MB is ended for that",
    greedy.ok && greedy.run.ending === "out_of_memory",
    greedy.ok ? `${greedy.run.ending} after ${greedy.run.ms} ms` : said(greedy),
  );
  const long = run("await Bun.sleep(3000); console.log('done')");
  await Bun.sleep(1_000);
  // Another caller entirely: this client would have queued behind its own run.
  const meanwhile = await createWorkbench({ socketPath, log }).run({
    script: "console.log(2)",
    files: [],
  });
  const finished = await long;
  check(
    "one script at a time: a second run meanwhile is refused",
    !meanwhile.ok && meanwhile.failure === "busy" && said(finished) === "done",
    `the second caller: ${meanwhile.ok ? "ran" : meanwhile.failure}; the first: ${said(finished)}`,
  );
  const gaveUp = new AbortController();
  const abandoned = workbench.run(
    { script: "await Bun.sleep(50_000)", files: [], timeoutMs: 60_000 },
    gaveUp.signal,
  );
  await Bun.sleep(1_000);
  gaveUp.abort();
  const stopped = await abandoned;
  const idleAgain = Date.now();
  await settled(15_000);
  check(
    "a caller that gives up ends the run, long before the script would have ended",
    !stopped.ok && stopped.failure === "stopped",
    `${stopped.ok ? "ran" : stopped.failure}; the daemon was idle again ${Date.now() - idleAgain} ms later, of the 50 s the script asked for`,
  );

  // PROCESS 1 CANNOT BE STOPPED FROM INSIDE; WHAT DOES REACH IT ENDS THE CONTAINER.
  const signalled = await run(`
for (const signal of ["SIGSTOP", "SIGKILL"]) {
  try { process.kill(1, signal); console.log(signal + " sent"); } catch (error) { console.log(signal + " " + error.code); }
}
await Bun.sleep(500);
console.log("and the run went on");
`);
  const unmoved = await settled();
  check(
    "a script cannot stop or kill the daemon: it is process 1 of its own namespace",
    signalled.ok &&
      said(signalled).endsWith("and the run went on") &&
      unmoved === boot,
    `${said(signalled).replaceAll("\n", "; ")}; the same daemon answered afterwards: ${unmoved === boot}`,
  );
  const ended = await run(
    'process.kill(1, "SIGTERM"); await Bun.sleep(5000); console.log("outlived it");',
  );
  let fresh = await restarted(boot);
  check(
    "a signal the daemon does take ends the container, script and all, and compose starts a fresh one",
    !ended.ok && fresh !== boot,
    `the run: ${ended.ok ? said(ended) : ended.failure}; a new daemon answered on the same socket`,
  );
  boot = fresh;
  const replaced = await run(`
import { rmSync, writeFileSync } from "node:fs";
rmSync("/run/laf-workbench/workbench.sock");
writeFileSync("/run/laf-workbench/workbench.sock", "not a socket");
console.log("replaced");
`);
  fresh = await restarted(boot);
  check(
    "a script that takes the socket's place is answered once; the daemon then stops and a fresh one binds",
    said(replaced) === "replaced" && fresh !== boot,
    `the run: ${said(replaced)}; a new daemon answered on the same path`,
  );
  boot = fresh;
  const segment = await run(`
let made;
try { made = Bun.spawnSync(["/usr/bin/ipcmk", "-M", "4096"]); } catch { console.log("no ipcmk"); process.exit(0); }
console.log(made.exitCode === 0 ? "made" : "refused: " + made.stderr.toString().trim());
`);
  if (said(segment) === "made") {
    fresh = await restarted(boot);
    const listed = await run(
      'console.log(Bun.spawnSync(["/usr/bin/ipcs", "-m"]).stdout.toString().split("\\n").filter((line) => line.startsWith("0x")).length)',
    );
    check(
      "a System V segment a script left costs the daemon its container, and the next run finds none",
      fresh !== boot && said(listed) === "0",
      `a new daemon answered; the next run counted ${said(listed)} segment(s)`,
    );
  } else {
    check(
      "a System V segment a script left costs the daemon its container",
      null,
      `no segment could be made to try it with (${said(segment)})`,
    );
  }
}

// --- the outer half ------------------------------------------------------------------------------

type Ran = { code: number; stdout: string; stderr: string };

/** The file the rehearsal adds to compose's own: the second container, and nothing else. */
export const PROBE_COMPOSE_FILE = "upgrade-e2e.workbench.yml";

/**
 * A second service on the workbench's socket volume: the server's image, as the server will be —
 * root, the socket mounted where the server will find it — with this file mounted in as its
 * command. It shares nothing with the deployment being rehearsed but that volume: no network, no
 * dependency, and the server's own container is not touched, so nothing the rehearsal checked
 * before this is disturbed by it.
 */
export function probeOverride(input: {
  serverImage: string;
  /** This file, on the machine running the rehearsal. */
  probePath: string;
}): string {
  return [
    "# scripts/workbench-probe.ts: the container the workbench is driven from. Not part of any",
    "# deployment; written by the rehearsal into its own directory and removed with it.",
    "services:",
    "  workbench-probe:",
    `    image: ${input.serverImage}`,
    "    profiles:",
    "      - workbench",
    "    pull_policy: missing",
    "    network_mode: none",
    '    restart: "no"',
    "    volumes:",
    `      - workbench-socket:${SOCKET_DIRECTORY}`,
    `      - ${input.probePath}:/app/scripts/workbench-probe.ts:ro`,
    "    command:",
    `      ["bun", "--no-env-file", "/app/scripts/workbench-probe.ts", "${SOCKET}"]`,
    "",
  ].join("\n");
}

/** The inner half's line, out of everything a container printed. Null when it printed none. */
export function probeResultFrom(output: string): ProbeCheck[] | null {
  const line = output
    .split("\n")
    .filter((candidate) => candidate.startsWith(PROBE_RESULT))
    .at(-1);
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(PROBE_RESULT.length));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (check): check is ProbeCheck =>
        typeof check === "object" &&
        check !== null &&
        typeof check.name === "string" &&
        typeof check.detail === "string" &&
        (typeof check.ok === "boolean" || check.ok === null),
    );
  } catch {
    return null;
  }
}

/**
 * What an idle workbench may hold before the rehearsal calls it a fault. Measured at 17–18 MiB
 * before any run and 21 MiB after the probe's (2026-10-06, arm64 runner); three times that is room
 * for another runtime, and far below what importing something of the server's would cost.
 */
const IDLE_CEILING_MIB = 64;

/**
 * The first figure of `docker stats`' memory column — `17.36MiB / 768MiB` — in MiB. Null when
 * there is no figure, or the figure is nothing: a container between two lives prints `0B / 0B`,
 * and a process that holds no memory is a process that is not there.
 */
export function megabytesHeld(usage: string): number | null {
  const figure = usage.trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB)\b/);
  if (!figure) return null;
  const amount = Number(figure[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const perUnit = { B: 1 / (1024 * 1024), KiB: 1 / 1024, MiB: 1, GiB: 1024 };
  return amount * perUnit[figure[2] as keyof typeof perUnit];
}

/** What the daemon logged when it began to listen, or null when it has not. */
export function listeningLineFrom(
  logs: string,
): { undumpable: boolean; ptraceScope: number | null } | null {
  for (const line of logs.split("\n").reverse()) {
    const at = line.indexOf("{");
    if (at < 0 || !line.includes('"workbench_listening"')) continue;
    try {
      const fields = JSON.parse(line.slice(at)) as Record<string, unknown>;
      return {
        undumpable: fields.undumpable === true,
        ptraceScope:
          typeof fields.ptraceScope === "number" ? fields.ptraceScope : null,
      };
    } catch {
      // A line cut by the log's own rotation; the one before it will do.
    }
  }
  return null;
}

/**
 * The outer half. Never throws for a check that failed — it reports it; throws only when it could
 * not go on, and the rehearsal reports that as a check of its own.
 */
export async function rehearseWorkbench(tools: {
  /** `docker compose …` in the rehearsed deployment's directory, with the rehearsal's environment. */
  compose: (args: string[]) => Promise<Ran>;
  docker: (args: string[]) => Promise<Ran>;
  check: (name: string, ok: boolean, detail: string) => void;
  finding: (text: string) => void;
  /** The rehearsed deployment's directory. */
  deployment: string;
  /** The environment `compose` runs with: this adds the profile and the override to it. */
  environment: Record<string, string>;
  serverImage: string;
}): Promise<void> {
  const { compose, docker, check, finding } = tools;
  const containers = async () =>
    (
      await docker([
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project.working_dir=${tools.deployment}`,
        "--filter",
        "label=com.docker.compose.service=workbench",
      ])
    ).stdout
      .split("\n")
      .filter(Boolean);

  // WHAT AN UPGRADE STARTS: nothing of this. Asked before the profile is named anywhere.
  const without = (await compose(["config", "--services"])).stdout
    .split("\n")
    .filter(Boolean);
  const before = await containers();
  const known = (
    await compose(["--profile", "workbench", "config", "--services"])
  ).stdout
    .split("\n")
    .filter(Boolean);
  if (!known.includes("workbench")) {
    finding(
      "this build's compose file has no `workbench` service, so the workbench was not rehearsed",
    );
    return;
  }
  // The volume's record may exist already — compose makes what a file declares — and that is
  // nothing: a tmpfs is memory only while something mounts it. Said, because it was asked.
  const volumeBefore = (
    await docker([
      "volume",
      "ls",
      "--quiet",
      "--filter",
      "label=com.docker.compose.volume=workbench-socket",
      "--filter",
      `label=com.docker.compose.project=${basename(tools.deployment)}`,
    ])
  ).stdout.trim();
  check(
    "the upgrade started no workbench: the service is behind its profile",
    before.length === 0 && !without.includes("workbench"),
    `containers of the service after upgrade.sh: ${before.length}; its socket volume ${volumeBefore ? "was declared to the engine (unmounted, holding nothing)" : "does not exist yet"}; services compose knows without the profile: ${without.join(", ")}`,
  );

  // THE WAY A DEPLOYMENT WOULD START IT: the profile, named in the environment compose reads.
  writeFileSync(
    join(tools.deployment, PROBE_COMPOSE_FILE),
    probeOverride({
      serverImage: tools.serverImage,
      probePath: import.meta.path,
    }),
  );
  tools.environment.COMPOSE_FILE = `${tools.environment.COMPOSE_FILE ?? "docker-compose.yml"}:${PROBE_COMPOSE_FILE}`;
  tools.environment.COMPOSE_PROFILES = "workbench";
  try {
    const up = await compose(["up", "--detach", "--no-deps", "workbench"]);
    const logs = async () =>
      (await compose(["logs", "--no-color", "--tail", "60", "workbench"]))
        .stdout;
    let listening: ReturnType<typeof listeningLineFrom> = null;
    for (
      const deadline = Date.now() + 45_000;
      up.code === 0 && Date.now() < deadline;
    ) {
      listening = listeningLineFrom(await logs());
      if (listening) break;
      await Bun.sleep(500);
    }
    check(
      "the workbench starts inside its walls, on a tmpfs-backed volume, and listens",
      listening !== null,
      listening
        ? "it checked where it was and logged workbench_listening"
        : `compose up exited ${up.code}: ${(up.stderr.trim() || (await logs()).trim()).slice(-700)}`,
    );
    if (!listening) return;
    check(
      "the daemon closed its own memory to its user's other processes (prctl, through bun:ffi)",
      listening.undumpable,
      `undumpable: ${listening.undumpable}; the host's ptrace_scope: ${listening.ptraceScope ?? "none"}`,
    );

    const [container] = await containers();
    if (!container) throw new Error("the workbench's container was not found");
    const inspected = await docker([
      "inspect",
      "--format",
      "{{json .HostConfig}}\n{{json .Config.User}}",
      container,
    ]);
    const [hostLine, userLine] = inspected.stdout.trim().split("\n");
    const host = JSON.parse(hostLine ?? "{}") as Record<string, unknown>;
    const megabytes = 1024 * 1024;
    // Which engine and kernel this was measured on: the walls are theirs to keep.
    const engine = (
      await docker([
        "info",
        "--format",
        "Docker {{.ServerVersion}}, kernel {{.KernelVersion}}, {{.Architecture}}, cgroup v{{.CgroupVersion}}",
      ])
    ).stdout.trim();
    check(
      "the engine runs the workbench as compose wrote it",
      host.NetworkMode === "none" &&
        host.ReadonlyRootfs === true &&
        JSON.stringify(host.CapDrop) === '["ALL"]' &&
        JSON.stringify(host.SecurityOpt).includes("no-new-privileges") &&
        host.Memory === 768 * megabytes &&
        host.MemorySwap === 768 * megabytes &&
        host.PidsLimit === 128 &&
        host.CpuShares === 256 &&
        host.Init !== true &&
        host.ShmSize === megabytes &&
        userLine === '"65534:65534"',
      JSON.stringify({
        engine,
        user: userLine,
        NetworkMode: host.NetworkMode,
        ReadonlyRootfs: host.ReadonlyRootfs,
        CapDrop: host.CapDrop,
        SecurityOpt: host.SecurityOpt,
        Memory: host.Memory,
        MemorySwap: host.MemorySwap,
        PidsLimit: host.PidsLimit,
        CpuShares: host.CpuShares,
        Init: host.Init,
        ShmSize: host.ShmSize,
        Tmpfs: host.Tmpfs,
      }),
    );
    const memory = async () =>
      (
        await docker([
          "stats",
          "--no-stream",
          "--format",
          "{{.MemUsage}}",
          container,
        ])
      ).stdout.trim();
    // A few seconds after it began to listen, having run nothing: what a deployment would pay for
    // a workbench nobody is using.
    await Bun.sleep(5_000);
    const idle = await memory();
    const idleMegabytes = megabytesHeld(idle);
    check(
      `an idle workbench holds under ${IDLE_CEILING_MIB} MiB`,
      idleMegabytes !== null && idleMegabytes < IDLE_CEILING_MIB,
      `${idle || "nothing read"} — before it had run anything`,
    );

    // THE INNER HALF, in a second container on the same socket.
    const probed = await compose([
      "run",
      "--rm",
      "--no-TTY",
      "--no-deps",
      "workbench-probe",
    ]);
    const results = probeResultFrom(probed.stdout);
    if (!results) {
      check(
        "the probe ran to its end inside the deployment",
        false,
        `exit ${probed.code}: ${(probed.stderr.trim() || probed.stdout.trim()).slice(-700)}`,
      );
    }
    for (const result of results ?? []) {
      if (result.ok === null) {
        finding(`not measured — ${result.name}: ${result.detail}`);
      } else check(result.name, result.ok, result.detail);
    }
    // And once it has: a daemon that kept something of each run would show here first.
    const after = await memory();
    const afterMegabytes = megabytesHeld(after);
    check(
      `the workbench is back under ${IDLE_CEILING_MIB} MiB once the probe's runs are over`,
      afterMegabytes !== null && afterMegabytes < IDLE_CEILING_MIB,
      `${after || "nothing read"} — it held ${idle} before any of them`,
    );
    // The service's own account of the same minute: facts about runs, never what one said.
    console.log(
      (await compose(["logs", "--no-color", "--tail", "80", "workbench"]))
        .stdout,
    );

    // OUTSIDE ITS WALLS IT DOES NOT START. The same service, the same command, as root.
    const asRoot = await compose([
      "run",
      "--rm",
      "--no-TTY",
      "--no-deps",
      "--user",
      "0:0",
      "workbench",
    ]);
    const refusal = `${asRoot.stdout}\n${asRoot.stderr}`
      .split("\n")
      .find((line) => line.includes("workbench_not_isolated"));
    check(
      "started as root, the same service refuses to listen and says why",
      asRoot.code !== 0 &&
        refusal !== undefined &&
        refusal.includes("runs_as_root"),
      `exit ${asRoot.code}: ${(refusal ?? asRoot.stderr.trim()).slice(-400)}`,
    );
  } finally {
    await compose(["rm", "--stop", "--force", "workbench"]);
  }
}

if (import.meta.main) {
  const socketPath = process.argv[2];
  if (!socketPath) {
    console.error(
      "usage: bun workbench-probe.ts <socket>, inside the probe's container",
    );
    process.exit(2);
  }
  const checks: ProbeCheck[] = [];
  await probe(socketPath, checks).catch((error) => {
    checks.push({
      name: "the probe ran to its end",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  });
  console.log(PROBE_RESULT + JSON.stringify(checks));
  // The client's log keeps nothing open, but a run abandoned mid-probe might: end here regardless.
  process.exit(0);
}
