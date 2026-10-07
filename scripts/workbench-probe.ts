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
 *
 * AND A THIRD CONTAINER, FOR THE ACT (since 2026-10-07). Once the walls have been tried, the
 * gateway's own act for a script's run is driven against the same service from
 * `scripts/workbench-act-probe.ts`, in a container like the second. That file is apart from this
 * one because it imports the gateway, and this file is also the half that runs on the machine
 * running the rehearsal — which installs nothing, and must go on importing nothing that needs
 * installing. What the two share is here: the lines the act's probe prints, the scripts it sends.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  createWorkbench,
  type WorkbenchAnswer,
} from "../server/src/workbench/client";
import { createLogger } from "../shared/log";
import { isKey, KEY_VARIABLE } from "../shared/workbench/protocol";

/** One thing measured. `ok: null` is "could not be measured here", said rather than passed. */
export type ProbeCheck = { name: string; ok: boolean | null; detail: string };

/** What the line the inner half prints starts with, so it is found among anything else printed. */
export const PROBE_RESULT = "WORKBENCH_PROBE_RESULT ";

/** The same, for the act's probe (`workbench-act-probe.ts`): what it found, as checks. */
export const ACT_RESULT = "WORKBENCH_ACT_RESULT ";
/**
 * And one line for each thing the act's probe drove: what came of it, and the rows the gateway
 * handed a store for it, whole. Printed by the rehearsal as they are, because they are the point —
 * what a run's trail holds, for runs that really ran.
 */
export const ACT_ROWS = "WORKBENCH_ACT_ROWS ";

/**
 * Four strings, each put in one place content lives during the act's first run, and then looked
 * for in every row that run left: the script's own text, what it printed, the file it read, the
 * file it made. Two are written here as halves and joined by the script, so that what the script
 * PRINTS and what it WRITES are not also lines of the script.
 */
export const ACT_SENTINELS = {
  script: "SCRIPT-SENTINEL-9f1c",
  stdout: "STDOUT-SENTINEL",
  input: "INPUT-SENTINEL-27ab",
  product: "PRODUCT-SENTINEL",
} as const;

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
const one = readFileSync("/proc/1/status", "utf8");
const ofOne = (name) => one.match(new RegExp("^" + name + ":\s*(.+)$", "m"))?.[1]?.trim() ?? null;
console.log(JSON.stringify({
  ...who,
  root: mount("/"), work: mount("/work"), socket: mount("/run/laf-workbench"), shm: mount("/dev/shm"),
  writable, elsewhere, reached, daemonMemory,
  one: { caught: ofOne("SigCgt"), ignored: ofOne("SigIgn"), blocked: ofOne("SigBlk") },
}));
`;

/** Every process a script can see, with its state. Shared by the two scripts below. */
const PROCESSES = String.raw`
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const stateOf = (path) => {
  const stat = readFileSync(path, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
};
// The threads of a process that can still run: its leader may have exited while they go on.
const liveThreads = (pid) => {
  try {
    return readdirSync("/proc/" + pid + "/task").filter((tid) => {
      try { return !["Z", "X"].includes(stateOf("/proc/" + pid + "/task/" + tid + "/stat")); } catch { return false; }
    }).length;
  } catch { return 0; }
};
const processes = () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map((pid) => {
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    const command = readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0").filter(Boolean).join(" ");
    return { pid: Number(pid), state, command, live: liveThreads(pid) };
  } catch { return { pid: Number(pid), state: "?", command: "", live: 0 }; }
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

/** The scripts the act's probe sends through the gateway (`workbench-act-probe.ts`). */
export const ACT_SCRIPTS = {
  /** Where a script is, in three facts: enough to stop before anything else is sent. */
  where: `
import { networkInterfaces } from "node:os";
console.log(JSON.stringify({
  uid: process.getuid(), parent: process.ppid,
  interfaces: Object.entries(networkInterfaces())
    .filter(([, addresses]) => (addresses ?? []).some((address) => !address.internal)).map(([name]) => name),
}));
`,
  /** Sum a column of the one file it was handed, print the total, and leave a file saying it. */
  total: String.raw`
// ${ACT_SENTINELS.script}: a line of the script, which no row may hold.
const rows = (await Bun.file("uploads/sales.csv").text()).trim().split("\n").slice(1);
const total = rows.reduce((sum, row) => sum + Number(row.split(",")[1]), 0);
await Bun.write("out/totals.csv", "total\n" + total + "\n" + ["PRODUCT", "SENTINEL"].join("-") + "\n");
console.log(["STDOUT", "SENTINEL"].join("-") + " total " + total);
`,
  /**
   * Sum the same column of a file it opens as `./data.csv` — the way a model writes a file's
   * name — for a call that names it that way too. The file is staged as `data.csv`; whether
   * this finds it is the operating system's answer, which is why it is asked on the real one.
   */
  spelled: String.raw`
const rows = (await Bun.file("./data.csv").text()).trim().split("\n").slice(1);
console.log("spelled total " + rows.reduce((sum, row) => sum + Number(row.split(",")[1]), 0));
`,
  /** Longer than anybody waits: ended only by its caller's Stop. */
  long: `
await Bun.sleep(30_000);
console.log("never said");
`,
  after: `console.log("after the stop");`,
} as const;

type Seen = {
  pid: number;
  state: string;
  command: string;
  /** Threads of it that can still run. A leader that has exited reads `Z` while its threads go on. */
  live: number;
};

/** What a run finds of the runs before it (`LOOK`). */
type Looked = {
  notes: string[];
  work: string[];
  shm: string[];
  socket: string[];
  self: number;
  processes: Seen[];
};

/** Signal numbers as Linux has them on both architectures the fleet could be. */
const SIGNALS = [
  "HUP",
  "INT",
  "QUIT",
  "ILL",
  "TRAP",
  "ABRT",
  "BUS",
  "FPE",
  "KILL",
  "USR1",
  "SEGV",
  "USR2",
  "PIPE",
  "ALRM",
  "TERM",
  "STKFLT",
  "CHLD",
  "CONT",
  "STOP",
  "TSTP",
  "TTIN",
  "TTOU",
  "URG",
  "XCPU",
  "XFSZ",
  "VTALRM",
  "PROF",
  "WINCH",
  "IO",
  "PWR",
  "SYS",
];

/** The names in a `/proc/<pid>/status` signal mask: bit n-1 is signal n. */
export function signalsIn(mask: string | null): string[] {
  if (!mask || !/^[0-9a-f]+$/i.test(mask)) return [];
  const bits = BigInt(`0x${mask}`);
  return SIGNALS.filter((_, index) => (bits >> BigInt(index)) & 1n).map(
    (name) => `SIG${name}`,
  );
}

/** Run a program from each place a script can write. Not executable is the mount's to say. */
const EXEC = `
import { chmodSync, copyFileSync } from "node:fs";
const tried = {};
for (const place of ["/work", "/run/laf-workbench", "/dev/shm"]) {
  const path = place + "/t-" + process.pid;
  try {
    copyFileSync("/bin/true", path);
    chmodSync(path, 0o755);
    const ran = Bun.spawnSync([path]);
    tried[place] = ran.exitCode === 0 ? "ran" : "exit " + ran.exitCode;
  } catch (error) { tried[place] = error.code ?? error.name; }
}
console.log(JSON.stringify(tried));
`;

/** As many empty names as each place will take, to twenty thousand. */
const NAMES = `
import { closeSync, openSync } from "node:fs";
const made = {};
const stoppedBy = {};
for (const place of ["/work", "/run/laf-workbench", "/dev/shm"]) {
  let n = 0;
  try { for (; n < 20000; n += 1) closeSync(openSync(place + "/n" + n, "w")); }
  catch (error) { stoppedBy[place] = error.code ?? error.name; }
  made[place] = n;
}
console.log(JSON.stringify({ made, stoppedBy }));
`;

/** The daemon's own socket, called by the script it is running. */
const CALL = `
const unix = "/run/laf-workbench/workbench.sock";
const health = await (await fetch("http://workbench/health", { unix })).json();
const form = new FormData();
form.set("job", JSON.stringify({ files: [] }));
form.set("script", new Blob(["console.log(1)"]));
const refused = await fetch("http://workbench/run", { unix, method: "POST", body: form });
console.log(JSON.stringify({ busy: health.busy, boot: typeof health.boot, status: refused.status, code: (await refused.json()).code }));
`;

/**
 * A process whose LEADER has exited while a thread of it runs on: the main thread leaves by the
 * thread's own exit call, a worker stays. `megabytes` is what the worker then holds.
 */
const ledByTheDead = (megabytes: number) => String.raw`
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
writeFileSync("held.ts", [
  'const held = [];',
  'const more = setInterval(() => {',
  '  if (held.length * 16 >= ${megabytes}) return clearInterval(more);',
  '  held.push(new Uint8Array(16 * 1024 * 1024).fill(1));',
  '}, 20);',
  'setInterval(() => {}, 1000);',
].join("\n"));
writeFileSync("leader.ts", [
  'import { dlopen } from "bun:ffi";',
  'new Worker(new URL("./held.ts", import.meta.url).href);',
  'await Bun.sleep(400);',
  '// The exit of the calling THREAD, not of the process: 93 on arm64, 60 on x86-64.',
  'dlopen("libc.so.6", { syscall: { args: ["i64", "i64"], returns: "i64" } }).symbols.syscall(process.arch === "arm64" ? 93 : 60, 0);',
].join("\n"));
const child = Bun.spawn([process.execPath, "--no-install", "leader.ts"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
child.unref();
await Bun.sleep(2500);
const stateOf = (path) => { const stat = readFileSync(path, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3); };
const rssOf = (path) => { try { return Number(readFileSync(path, "utf8").match(/^VmRSS:\s+(\d+)/m)?.[1] ?? NaN); } catch { return NaN; } };
const base = "/proc/" + child.pid;
let leader = "gone", live = [], leaderRss = NaN, liveRss = NaN;
try {
  leader = stateOf(base + "/stat");
  leaderRss = rssOf(base + "/status");
  live = readdirSync(base + "/task").filter((tid) => { try { return !["Z", "X"].includes(stateOf(base + "/task/" + tid + "/stat")); } catch { return false; } });
  liveRss = live.length > 0 ? rssOf(base + "/task/" + live[0] + "/status") : NaN;
} catch {}
console.log(JSON.stringify({ pid: child.pid, leader, leaderRssKb: Number.isNaN(leaderRss) ? null : leaderRss, live: live.length, liveRssKb: Number.isNaN(liveRss) ? null : liveRss }));
await Bun.sleep(${megabytes > 64 ? 8000 : 0});
console.log("outlived");
`;

/** Children until the engine refuses one. */
const FORK = `
let n = 0;
let stoppedBy = "the cap of 300";
try {
  for (; n < 300; n += 1) Bun.spawn(["/bin/sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
} catch (error) { stoppedBy = error.code ?? error.name; }
console.log(JSON.stringify({ n, stoppedBy }));
`;

/** What a script can read of the daemon that is not the daemon's memory: how it was started. */
const SECRETS = `
import { readFileSync } from "node:fs";
const read = {};
for (const path of ["/proc/1/environ", "/proc/1/cmdline"]) {
  try { read[path] = readFileSync(path).length + " bytes"; } catch (error) { read[path] = error.code; }
}
console.log(JSON.stringify({ read, env: Object.keys(process.env).sort() }));
`;

/** What answers at the socket's path when a script has put itself there. */
const AS_A_SCRIPT = "a script";

/**
 * A listener of a script's own, saying what an idle daemon says, and answering a run as a run is
 * answered — with what it was SENT where a script's output would be.
 */
const IMPOSTOR = `
Bun.serve({
  unix: "/run/laf-workbench/workbench.sock",
  async fetch(request) {
    if (new URL(request.url).pathname === "/health") {
      return Response.json({ status: "ok", busy: false, boot: "${AS_A_SCRIPT}" });
    }
    const form = await request.formData();
    const script = await form.get("script").text();
    const files = [];
    for (const [name, part] of form) {
      if (name.startsWith("file")) files.push(new TextDecoder().decode(await part.arrayBuffer()).slice(0, 80));
    }
    const stdout = "A SCRIPT ANSWERED, having been sent " + JSON.stringify({ script: script.slice(0, 60), files });
    const answer = new FormData();
    answer.set("report", JSON.stringify({ ending: "exited", exitCode: 0, signal: null, ms: 1, stdout, stderr: "", stdoutBytes: stdout.length, stderrBytes: 0, products: [], skipped: 0 }));
    return new Response(answer);
  },
});
`;

/** A script that takes the socket's place itself, and stays there a while. */
const TAKE = `
import { unlinkSync } from "node:fs";
const tried = {};
try { unlinkSync("/run/laf-workbench/workbench.sock"); tried.unlink = "removed"; } catch (error) { tried.unlink = error.code; }
try {
${IMPOSTOR}
  tried.bind = "bound";
} catch (error) { tried.bind = error.code ?? String(error); }
console.log(JSON.stringify(tried));
await Bun.sleep(5000);
`;

/** The same, as a program of its own: what a script leaves running when its own process is ended. */
const TAKER = `
import { unlinkSync } from "node:fs";
try { unlinkSync("/run/laf-workbench/workbench.sock"); } catch {}
${IMPOSTOR}
setInterval(() => {}, 1000);
`;

/** A script that starts that program and waits to be given up on. */
const LEAVE_TAKER = `
import { writeFileSync } from "node:fs";
writeFileSync("taker.ts", ${JSON.stringify(TAKER)});
Bun.spawn([process.execPath, "--no-install", "taker.ts"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
await Bun.sleep(50_000);
`;

/**
 * Names that are not text — a byte no encoding of a character holds — left everywhere a script can
 * write, and first what this runtime does with a path given as bytes, tried on names of the run's own.
 */
const UNTEXT = `
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
const name = Buffer.from([0x6e, 0xff]);
const under = (directory, leaf = name) => Buffer.concat([Buffer.from(directory + "/"), leaf]);
// The runtime lists names as plain byte arrays; a Buffer is made of each to compare it.
const has = (directory, leaf = name) => readdirSync(directory, { encoding: "buffer" }).some((entry) => Buffer.from(entry).equals(leaf));
const bun = {};
const attempt = (what, act) => { try { bun[what] = String(act()); } catch (error) { bun[what] = error.code ?? String(error); } };
const own = Buffer.from([0x61, 0xff]);
attempt("write by bytes", () => { writeFileSync(under(".", own), "x"); return has(".", own); });
attempt("listed as text", () => JSON.stringify(readdirSync(".").filter((entry) => entry.startsWith("a"))));
attempt("lstat by bytes", () => lstatSync(under(".", own)).isFile());
attempt("unlink by bytes", () => { unlinkSync(under(".", own)); return !has(".", own); });
const folder = Buffer.from([0x62, 0xff]);
attempt("rm -r by bytes", () => { mkdirSync(under(".", folder)); writeFileSync(Buffer.concat([under(".", folder), Buffer.from("/"), name]), "x"); rmSync(under(".", folder), { recursive: true, force: true }); return !has(".", folder); });
attempt("chmod and rmdir by bytes", () => { if (!has(".", folder)) mkdirSync(under(".", folder)); chmodSync(under(".", folder), 0o700); rmdirSync(under(".", folder)); return !has(".", folder); });
const made = {};
for (const directory of ["/work", "/dev/shm", "/run/laf-workbench", "."]) {
  try { writeFileSync(under(directory), "left"); made[directory] = has(directory) ? "written" : "written under another name"; } catch (error) { made[directory] = error.code ?? String(error); }
}
// A folder of such a name with such a name in it, closed to its own user, left in the work root.
try {
  const closed = under("/work", Buffer.from([0x64, 0xfe]));
  mkdirSync(closed);
  writeFileSync(Buffer.concat([closed, Buffer.from("/"), name]), "left");
  chmodSync(closed, 0o000);
  made["a closed folder in /work"] = "made";
} catch (error) { made["a closed folder in /work"] = error.code ?? String(error); }
console.log(JSON.stringify({ made, bun }));
`;

/**
 * A tree deeper than a path may be long — sixteen folders of 255 bytes, 4,096 and more — with a
 * file in its last folder and that folder closed. Built without ever naming a path that long: two
 * halves of eight, and one moved under the other.
 */
const deepIn = (place: string) => `
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
const name = (letter) => letter.repeat(255);
const chain = (root, letter, levels) => { let path = root; for (let n = 0; n < levels; n += 1) path += "/" + name(letter); return path; };
const place = ${JSON.stringify(place)};
const built = {};
try {
  mkdirSync(chain(place, "a", 8), { recursive: true });
  const lower = chain(place + "/b", "b", 7);
  mkdirSync(lower, { recursive: true });
  writeFileSync(lower + "/held", "x");
  chmodSync(lower, 0o000);
  renameSync(place + "/b", chain(place, "a", 8) + "/" + name("b"));
  built.folders = 16;
  built.bytesDeep = place.length + 16 * 256;
} catch (error) { built.stoppedBy = error.code ?? String(error); }
console.log(JSON.stringify(built));
`;

/** What is in each place a script can write, by the bytes of its name. */
const BYTES = `
import { readdirSync } from "node:fs";
const hex = (directory) => readdirSync(directory, { encoding: "buffer" }).map((entry) => Buffer.from(entry).toString("hex"));
console.log(JSON.stringify({ work: hex("/work"), shm: hex("/dev/shm"), socket: hex("/run/laf-workbench") }));
`;

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
  // The deployment's key, from this container's environment as the server will have it from its
  // own. Never printed: what is reported of it is whether there was one.
  const key = process.env[KEY_VARIABLE];
  if (!isKey(key)) {
    check(
      "everything about the workbench",
      false,
      `the probe's container was started without ${KEY_VARIABLE}, so it could believe nothing it was answered and sent nothing`,
    );
    return;
  }
  const workbench = createWorkbench({ socketPath, key, log });
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
  /**
   * Which daemon answers, by the name it gave itself at start — PROVEN to be the daemon, as the
   * client believes nothing else; null while none does.
   */
  const health = () => workbench.health();
  /**
   * Whatever answers at the path, asked as nothing of ours asks: no number, no proof looked for.
   * Only to show what a script put there; nothing here acts on it.
   */
  const whoSays = async () => {
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
      if (now?.busy === false) return now.boot;
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
      if (now?.busy === false && now.boot !== was) return now.boot;
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
    shm?: string;
    one?: {
      caught: string | null;
      ignored: string | null;
      blocked: string | null;
    };
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
  const look = async () => json<Looked>(await run(LOOK));
  /** Nothing of an earlier run: no thread but the daemon's and the looker's, nothing written anywhere. */
  const isClean = (seen: Looked | null): seen is Looked =>
    !!seen &&
    seen.processes.every(
      (process) =>
        process.live === 0 || process.pid === 1 || process.pid === seen.self,
    ) &&
    seen.notes.length === 0 &&
    seen.work.length === 1 &&
    seen.shm.length === 0 &&
    seen.socket.join() === "workbench.sock";
  const looking = await look();
  const alive = (looking?.processes ?? []).filter(
    (process) => process.live > 0,
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
  // A second run meanwhile, asked by hand as nothing of ours asks: another caller in this process
  // is the same client (there is one for a socket's path) and would wait its turn in its queue.
  const second = new FormData();
  second.set("job", JSON.stringify({ files: [] }));
  second.set("script", new Blob(["console.log(2)"]));
  const meanwhile = await fetch("http://workbench/run", {
    unix: socketPath,
    method: "POST",
    body: second,
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (response) => ({
      status: response.status,
      code: String(((await response.json()) as { code?: unknown }).code),
    }))
    .catch((error: unknown) => ({
      status: 0,
      code: error instanceof Error ? error.name : "unknown",
    }));
  const finished = await long;
  check(
    "one script at a time: a second run meanwhile is refused",
    meanwhile.status === 503 &&
      meanwhile.code === "laf:workbench_busy" &&
      said(finished) === "done",
    `the second: ${meanwhile.status} ${meanwhile.code}; the first: ${said(finished)}`,
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

  // WHAT THE INDEPENDENT READ OF 2026-10-06 ASKED TO BE MEASURED HERE RATHER THAN ARGUED.
  const one = where.one ?? { caught: null, ignored: null, blocked: null };
  check(
    "what process 1 catches was read: a signal it does not catch is dropped, whoever sends it",
    one.caught !== null,
    `caught: ${signalsIn(one.caught).join(" ") || "none"}; ignored: ${signalsIn(one.ignored).join(" ") || "none"}; blocked: ${signalsIn(one.blocked).join(" ") || "none"} — of the caught, SIGTERM is sent below and the others are not tried`,
  );
  const small = (mount: string, names: number) =>
    /^tmpfs \S*noexec/.test(mount) &&
    /nr_inodes=(\d+)/.test(mount) &&
    Number(/nr_inodes=(\d+)/.exec(mount)?.[1]) <= names;
  // Sixteen beside the socket, the one place that outlives the container: fewer names than it
  // takes to build a path longer than a path may be.
  check(
    "the two small mounts are held as /work is: not executable, and a handful of names",
    small(where.socket, 16) && small(where.shm ?? "", 64),
    JSON.stringify({ socket: where.socket, shm: where.shm ?? null }),
  );
  const ranFrom = json<Record<string, string>>(await run(EXEC));
  check(
    "a program a script wrote runs from nowhere it can write",
    ranFrom !== null &&
      Object.keys(ranFrom).length === 3 &&
      Object.values(ranFrom).every((how) => how !== "ran"),
    JSON.stringify(ranFrom),
  );
  const called = json<{
    busy: boolean;
    boot: string;
    status: number;
    code: string;
  }>(await run(CALL));
  check(
    "a script that calls the daemon's socket itself is told it is busy, and is run nothing",
    called?.busy === true &&
      called.status === 503 &&
      called.code === "laf:workbench_busy",
    `${JSON.stringify(called)} — it can read the daemon's name for itself; the daemon asks its socket who answers only after everything a run started has been ended`,
  );
  const ten = new Uint8Array(10 * 1024 * 1024).fill(7);
  const bigBegan = Date.now();
  const big = await workbench.run({
    script:
      'const a = new Uint8Array(await Bun.file("in/a.bin").arrayBuffer()); const b = new Uint8Array(await Bun.file("in/b.bin").arrayBuffer()); await Bun.write("out/a.bin", a.subarray(0, 5_000_000)); await Bun.write("out/b.bin", b.subarray(0, 5_000_000)); console.log(a.byteLength + b.byteLength);',
    files: [
      { path: "in/a.bin", bytes: ten },
      { path: "in/b.bin", bytes: ten },
    ],
  });
  check(
    "the largest request there is — twenty megabytes in, ten out — is taken and answered",
    big.ok &&
      said(big) === String(20 * 1024 * 1024) &&
      big.products.length === 2 &&
      big.products.every((product) => product.bytes.byteLength === 5_000_000),
    big.ok
      ? `${said(big)} bytes read, ${big.products.map((product) => product.bytes.byteLength).join(" + ")} handed back; ${Date.now() - bigBegan} ms there and back, ${big.run.ms} of them the script`
      : said(big),
  );

  // A THREAD-GROUP LEADER THAT HAS EXITED WHILE A THREAD RUNS ON reads `Z` — a dead letter on a
  // process that is alive. First the kernel's own account of one; then whether the sweep and the
  // memory watch see it.
  type Led = {
    pid: number;
    leader: string;
    leaderRssKb: number | null;
    live: number;
    liveRssKb: number | null;
  };
  const ledRun = await run(ledByTheDead(16));
  const led = ledRun.ok
    ? (() => {
        try {
          return JSON.parse(ledRun.run.stdout.split("\n")[0] ?? "") as Led;
        } catch {
          return null;
        }
      })()
    : null;
  const afterLed = await look();
  if (led && led.leader === "Z" && led.live > 0) {
    check(
      "a process whose leader has exited while a thread runs on is ended by the sweep like any other",
      isClean(afterLed),
      `the kernel's account of it while it ran: ${JSON.stringify(led)} — the leader reads Z and reports no memory, ${led.live} thread(s) run and one reports ${led.liveRssKb} kB; the next run saw ${JSON.stringify((afterLed?.processes ?? []).filter((process) => process.live > 0).map((process) => process.pid))} alive`,
    );
    const heavy = await run(ledByTheDead(576), { timeoutMs: 30_000 });
    check(
      "memory held by a process whose leader has exited counts against the run's 512 MB",
      heavy.ok && heavy.run.ending === "out_of_memory",
      heavy.ok
        ? `${heavy.run.ending} after ${heavy.run.ms} ms; it said: ${JSON.stringify(heavy.run.stdout.slice(0, 200))}`
        : said(heavy),
    );
  } else {
    // Two things were to be measured with it, and neither was.
    for (const name of [
      "a process whose leader has exited while a thread runs on is ended by the sweep like any other",
      "memory held by a process whose leader has exited counts against the run's 512 MB",
    ]) {
      check(
        name,
        null,
        `the fixture did not make one here: ${ledRun.ok ? JSON.stringify(ledRun.run.stdout.slice(0, 200)) : said(ledRun)}`,
      );
    }
  }

  const namesBegan = Date.now();
  const names = await run(NAMES, { timeoutMs: 60_000 });
  const namesWall = Date.now() - namesBegan;
  const named = json<{
    made: Record<string, number>;
    stoppedBy: Record<string, string>;
  }>(names);
  const clearing = names.ok ? namesWall - names.run.ms : null;
  check(
    "empty names are capped where a script can write, and clearing them takes no time to speak of",
    named !== null &&
      (named.made["/work"] ?? Number.POSITIVE_INFINITY) <= 4096 &&
      (named.made[SOCKET_DIRECTORY] ?? Number.POSITIVE_INFINITY) <= 16 &&
      (named.made["/dev/shm"] ?? Number.POSITIVE_INFINITY) <= 64 &&
      clearing !== null &&
      clearing < 5_000,
    `${names.ok ? JSON.stringify(named) : said(names)}; the script took ${names.ok ? names.run.ms : "?"} ms and the answer came ${clearing ?? "?"} ms after it ended (the daemon empties every place before it answers; the client gives it 10 s)`,
  );
  await settled(120_000);

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
  /** How long each new daemon took to answer after the one before it went, in order. */
  const gaps: number[] = [];
  const next = async (was: string): Promise<string> => {
    const went = Date.now();
    const now = await restarted(was, 180_000);
    gaps.push(Date.now() - went);
    return now;
  };
  // A note beside the socket, and then the signal: the daemon is ended under its own run, with no
  // sweep and nothing emptied. What the volume kept is the next daemon's to remove before it binds.
  const TERM =
    'require("node:fs").writeFileSync("/run/laf-workbench/note", "for the next run"); process.kill(1, "SIGTERM"); await Bun.sleep(5000); console.log("outlived it");';
  const ended = await run(TERM);
  let fresh = await next(boot);
  const afterTerm = await look();
  check(
    "a signal the daemon does take ends the container, script and all — and the next daemon starts with nothing beside its socket",
    !ended.ok && fresh !== boot && isClean(afterTerm),
    `the run: ${ended.ok ? said(ended) : ended.failure}; a new daemon answered on the same socket; the next run found beside it ${JSON.stringify(afterTerm?.socket)}`,
  );
  boot = fresh;
  const replaced = await run(`
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
rmSync("/run/laf-workbench/workbench.sock");
mkdirSync("/run/laf-workbench/workbench.sock");
writeFileSync("/run/laf-workbench/workbench.sock/held", "so that it is not empty");
console.log("replaced");
`);
  fresh = await next(boot);
  const afterSwap = await look();
  check(
    "a script that puts a DIRECTORY where the socket belongs is answered once; the daemon stops and a fresh one binds all the same",
    said(replaced) === "replaced" && fresh !== boot && isClean(afterSwap),
    `the run: ${said(replaced)}; a new daemon answered on the same path; the next run found beside it ${JSON.stringify(afterSwap?.socket)}`,
  );
  boot = fresh;
  const segment = await run(`
let made;
try { made = Bun.spawnSync(["/usr/bin/ipcmk", "-M", "4096"]); } catch { console.log("no ipcmk"); process.exit(0); }
console.log(made.exitCode === 0 ? "made" : "refused: " + made.stderr.toString().trim());
`);
  if (said(segment) === "made") {
    const was = boot;
    fresh = await next(boot);
    boot = fresh;
    const listed = await run(
      'console.log(Bun.spawnSync(["/usr/bin/ipcs", "-m"]).stdout.toString().split("\\n").filter((line) => line.startsWith("0x")).length)',
    );
    check(
      "a System V segment a script left costs the daemon its container, and the next run finds none",
      fresh !== was && said(listed) === "0",
      `a new daemon answered; the next run counted ${said(listed)} segment(s)`,
    );
  } else {
    check(
      "a System V segment a script left costs the daemon its container",
      null,
      `no segment could be made to try it with (${said(segment)})`,
    );
  }

  /*
   * EVERY SIGNAL PROCESS 1 CATCHES, SENT TO IT BY A SCRIPT. One it does not catch is dropped by the
   * kernel; one it catches runs a handler, and what that handler does is the runtime's business —
   * a crash handler, or something its collector uses between its own threads. A handler that ENDS
   * the daemon is the container ending, which is safe. The one outcome that is not is a daemon
   * left neither running nor ended. Ten seconds between them, so the engine's doubling wait is
   * not what is being measured.
   */
  const sent: string[] = [];
  let stuck = false;
  for (const signal of signalsIn(one.caught).filter(
    (name) => name !== "SIGTERM",
  )) {
    await Bun.sleep(11_000);
    const was = boot;
    const went = await run(
      `process.kill(1, "${signal}"); await Bun.sleep(1500); console.log("went on");`,
    );
    const now = await settled(90_000).catch(() => null);
    if (now === null) {
      stuck = true;
      sent.push(`${signal}: NOBODY ANSWERED for 90 s`);
      break;
    }
    sent.push(
      `${signal}: ${now === was ? "the same daemon went on" : "ended it, and a new daemon answered"}${went.ok ? "" : ` (the run: ${went.failure})`}`,
    );
    boot = now;
  }
  check(
    "no signal a script can send leaves the daemon neither running nor ended",
    !stuck && sent.length > 0,
    sent.join("; "),
  );
  await Bun.sleep(11_000);

  // CHILDREN UNTIL THE ENGINE REFUSES ONE. Each is ended by the sweep and then held, dead, by a
  // process 1 that waits for nobody — so this run also costs the daemon its container.
  const forked = await run(FORK, { timeoutMs: 60_000 });
  const afterFork = await settled(180_000);
  const served = await run("console.log('served')");
  check(
    "a script that starts children until it is refused one is answered, and the service is there for the next",
    said(served) === "served",
    `${forked.ok ? said(forked) : `no run: ${forked.failure}`}; ${afterFork === boot ? "the same daemon" : "a new daemon"} answered afterwards and ran the next script`,
  );
  if (afterFork !== boot) gaps.push(-1);
  boot = afterFork;

  // HOW LONG A DAEMON THAT WENT TAKES TO BE BACK, when it goes again and again: what "the daemon
  // quits after every run" would cost. The engine doubles its wait each time a container ends
  // within ten seconds of starting.
  for (let again = 0; again < 3; again += 1) {
    await run('process.kill(1, "SIGTERM"); await Bun.sleep(5000);');
    boot = await next(boot);
  }
  const measured = gaps.filter((gap) => gap >= 0);
  check(
    "a daemon that goes is back, each time it goes",
    measured.length >= 5 && measured.every((gap) => gap < 180_000),
    `ms until a new daemon answered, in the order they went (ended by SIGTERM, a directory at its socket, a System V segment, then SIGTERM three times running): ${measured.join(", ")}`,
  );

  // WHAT THE SECOND INDEPENDENT READ OF 2026-10-06 SAID A SCRIPT COULD DO, TRIED.
  await Bun.sleep(11_000);
  boot = await settled(180_000);
  const secrets = json<{ read: Record<string, string>; env: string[] }>(
    await run(SECRETS),
  );
  check(
    "a script cannot read how the daemon was started, and is handed nothing of it",
    secrets !== null &&
      secrets.read["/proc/1/environ"] !== undefined &&
      !secrets.read["/proc/1/environ"].endsWith("bytes") &&
      secrets.env.every((name) =>
        [
          "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
          "DO_NOT_TRACK",
          "HOME",
          "NO_COLOR",
          "TMPDIR",
        ].includes(name),
      ),
    JSON.stringify(secrets),
  );

  // NAMES THAT ARE NOT TEXT. Left everywhere a script can write; the next run reads what is there
  // by the bytes of each name.
  const untext = json<{
    made: Record<string, string>;
    bun: Record<string, string>;
  }>(await run(UNTEXT));
  await Bun.sleep(1_000);
  const afterUntext = await settled(180_000);
  const byBytes = json<{ work: string[]; shm: string[]; socket: string[] }>(
    await run(BYTES),
  );
  check(
    "a name that is not text is gone before the next run, wherever a script left it",
    untext !== null &&
      untext.made["/work"] === "written" &&
      byBytes !== null &&
      byBytes.work.length === 1 &&
      byBytes.shm.length === 0 &&
      byBytes.socket.join() === Buffer.from("workbench.sock").toString("hex"),
    `the script left: ${JSON.stringify(untext?.made)}; what the runtime does with a path of bytes: ${JSON.stringify(untext?.bun)}; ${afterUntext === boot ? "the same daemon" : "a new daemon"} answered afterwards, and the next run found, by the bytes of each name, /work ${JSON.stringify(byBytes?.work)}, /dev/shm ${JSON.stringify(byBytes?.shm)}, the socket's directory ${JSON.stringify(byBytes?.socket)}`,
  );
  boot = afterUntext;

  // A SCRIPT WHERE THE SOCKET WAS. While it runs, whoever asks at the path is answered by it.
  await Bun.sleep(11_000);
  boot = await settled(180_000);
  const taking = run(TAKE, { timeoutMs: 20_000 });
  await Bun.sleep(2_500);
  const atThePath = await whoSays();
  const believed = await health();
  const took = await taking;
  await Bun.sleep(1_000);
  boot = await settled(180_000);
  check(
    "what a script puts where the socket was is believed by nobody",
    atThePath?.boot === AS_A_SCRIPT && believed === null,
    `the script: ${said(took)}; while it ran, the path answered as ${JSON.stringify(atThePath)} and the client's health() said ${JSON.stringify(believed)}`,
  );

  // AND WHAT AN ABANDONED RUN LEFT RUNNING THERE, while the run behind it is on its way.
  const handed: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await Bun.sleep(11_000);
    boot = await settled(180_000);
    const leaving = new AbortController();
    const given = workbench.run(
      { script: LEAVE_TAKER, files: [], timeoutMs: 60_000 },
      leaving.signal,
    );
    let taken = false;
    for (const until = Date.now() + 15_000; Date.now() < until; ) {
      if ((await whoSays())?.boot === AS_A_SCRIPT) {
        taken = true;
        break;
      }
      await Bun.sleep(100);
    }
    const behind = workbench.run({
      script: 'console.log("the daemon ran this")',
      files: [
        {
          path: "uploads/next.csv",
          bytes: new TextEncoder().encode("the next run's workbook"),
        },
      ],
    });
    leaving.abort();
    const [, got] = await Promise.all([given, behind]);
    handed.push(
      taken
        ? got.ok
          ? got.run.stdout.trim().slice(0, 200)
          : `no run: ${got.failure}`
        : "what the script left never answered at the path",
    );
    await Bun.sleep(1_000);
  }
  boot = await settled(180_000);
  check(
    "the run behind an abandoned one is not handed to what that one left running",
    handed.some((outcome) => !outcome.startsWith("what the script left")) &&
      handed.every((outcome) => !outcome.startsWith("A SCRIPT ANSWERED")),
    `three times a run was given up on with its child at the socket's path and another run waiting behind it; that run came back as: ${handed.map((outcome) => JSON.stringify(outcome)).join(" · ")}`,
  );

  /*
   * A TREE DEEPER THAN A PATH MAY BE LONG, its last folder closed (the third read of 2026-10-07).
   * Removing a tree walks to any depth; opening up a folder a script closed went by its path, and
   * a path that long names nothing. LAST, and the socket's directory last of the three: it is the
   * one place that outlives the container, so a daemon that cannot empty it is a service that
   * never starts again while anything holds that volume — as this container does.
   */
  const deep: string[] = [];
  let deepGone = true;
  for (const place of ["/dev/shm", "/work", SOCKET_DIRECTORY]) {
    await Bun.sleep(11_000);
    const before = await settled(180_000).catch(() => null);
    if (before === null) {
      deepGone = false;
      deep.push(`${place}: no daemon answered to be sent it`);
      break;
    }
    const built = await run(deepIn(place), { timeoutMs: 30_000 });
    await Bun.sleep(1_000);
    const after = await settled(120_000).catch(() => null);
    const found =
      after === null
        ? null
        : json<{ work: string[]; shm: string[]; socket: string[] }>(
            await run(BYTES),
          );
    // What the next run finds there beyond what belongs: its own directory, the socket.
    const left =
      found === null
        ? null
        : place === "/work"
          ? found.work.length - 1
          : place === "/dev/shm"
            ? found.shm.length
            : found.socket.length - 1;
    if (after === null || left !== 0) deepGone = false;
    deep.push(
      `${place}: the script said ${said(built)}; afterwards ${after === null ? "NO DAEMON ANSWERED for 120 s" : after === before ? "the same daemon answered" : "a new daemon answered"}${left === null ? "" : `, and the next run found ${left} thing(s) left there`}`,
    );
    if (after === null) break;
  }
  check(
    "a tree deeper than a path may be long, its last folder closed, is gone before the next run — wherever a script built it",
    deepGone && deep.length === 3,
    deep.join(" · "),
  );
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
  /** The act's probe beside it (`workbench-act-probe.ts`). */
  actProbePath: string;
}): string {
  /** A container on the socket's volume: the server's image, the key, no network, one command. */
  const service = (name: string, files: string[], program: string) => [
    `  ${name}:`,
    `    image: ${input.serverImage}`,
    "    profiles:",
    "      - workbench",
    "    pull_policy: missing",
    "    network_mode: none",
    '    restart: "no"',
    "    environment:",
    "      # The deployment's key, as the server will be handed it: from the environment compose",
    "      # reads, never written into this file.",
    `      ${KEY_VARIABLE}: \${${KEY_VARIABLE}:?the rehearsal sets it}`,
    "    volumes:",
    `      - workbench-socket:${SOCKET_DIRECTORY}`,
    ...files.map((file) => `      - ${file}:/app/scripts/${basename(file)}:ro`),
    "    command:",
    `      ["bun", "--no-env-file", "/app/scripts/${program}", "${SOCKET}"]`,
  ];
  return [
    "# scripts/workbench-probe.ts: the containers the workbench is driven from. Not part of any",
    "# deployment; written by the rehearsal into its own directory and removed with it.",
    "services:",
    ...service("workbench-probe", [input.probePath], "workbench-probe.ts"),
    "  # The gateway's act for a script's run, against the same service. It imports this file's",
    "  # constants, so both are mounted; the gateway itself is the image's own source.",
    ...service(
      "workbench-act-probe",
      [input.probePath, input.actProbePath],
      "workbench-act-probe.ts",
    ),
    "",
  ].join("\n");
}

/**
 * The inner half's line, out of everything a container printed. Null when it printed none. The
 * act's probe prints the same kind of line under its own first word (`ACT_RESULT`).
 */
export function probeResultFrom(
  output: string,
  prefix: string = PROBE_RESULT,
): ProbeCheck[] | null {
  const line = output
    .split("\n")
    .filter((candidate) => candidate.startsWith(prefix))
    .at(-1);
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(prefix.length));
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

/**
 * How many things the inner half reports when it runs to its end. A floor in the only sense that
 * matters here: fewer is a probe that stopped, and a stopped probe has not found the walls sound.
 */
export const PROBE_CHECKS = 32;

/** The same floor for the act's probe: how many things it reports when it runs to its end. */
export const ACT_CHECKS = 10;

/** Every script the probe sends, by name — so that a test can at least parse them before a run does. */
export const PROBE_SCRIPTS: Readonly<Record<string, string>> = {
  WHERE,
  LEAVE,
  LOOK,
  SHEET,
  EXEC,
  NAMES,
  CALL,
  FORK,
  SECRETS,
  TAKE,
  TAKER,
  LEAVE_TAKER,
  UNTEXT,
  BYTES,
  deepInSharedMemory: deepIn("/dev/shm"),
  ledSmall: ledByTheDead(16),
  ledLarge: ledByTheDead(576),
};

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
  /**
   * Whether the build being rehearsed is one that has the service: this checkout's own, or `edge`.
   * An older release named by its version has none, and that is not a failure.
   */
  expected: boolean;
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
    // A release from before the service is a release with nothing here to try. A build that should
    // have it and does not is a rehearsal that tried nothing and must not be green for it.
    if (tools.expected) {
      check(
        "this build's compose file has the workbench service",
        false,
        `services with the profile on: ${known.join(", ")}`,
      );
    } else {
      finding(
        "this release's compose file has no `workbench` service, so the workbench was not rehearsed",
      );
    }
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
      actProbePath: join(dirname(import.meta.path), "workbench-act-probe.ts"),
    }),
  );
  tools.environment.COMPOSE_FILE = `${tools.environment.COMPOSE_FILE ?? "docker-compose.yml"}:${PROBE_COMPOSE_FILE}`;
  tools.environment.COMPOSE_PROFILES = "workbench";
  // A key minted for this run, handed to both containers the way a deployment's `.env` would hand
  // its own: through the environment compose reads. It opens nothing outside this run.
  tools.environment[KEY_VARIABLE] = randomBytes(24).toString("hex");
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
        typeof (host.Tmpfs as Record<string, string> | undefined)?.[
          "/dev/shm"
        ] === "string" &&
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
    // A probe that stopped early says less than it was written to, and must not pass for saying
    // nothing wrong: every check it has is counted.
    check(
      `the probe said all of what it tries (${PROBE_CHECKS} things)`,
      (results?.length ?? 0) === PROBE_CHECKS,
      `${results?.length ?? 0} reported`,
    );
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

    /*
     * THE ACT, AGAINST THE SAME SERVICE (`workbench-act-probe.ts`): the gateway's own method for
     * a script's run — its decisions, its rows, the server's client — with this daemon on the
     * other end. After the walls, so that a wall that did not hold is what a failed run is read
     * as; before the daemon is asked to start as root. What each drive left on the trail is
     * printed whole: that is what is being shown.
     */
    const acted = await compose([
      "run",
      "--rm",
      "--no-TTY",
      "--no-deps",
      "workbench-act-probe",
    ]);
    for (const line of acted.stdout.split("\n")) {
      if (line.startsWith(ACT_ROWS)) console.log(line);
    }
    const act = probeResultFrom(acted.stdout, ACT_RESULT);
    if (!act) {
      check(
        "the act's probe ran to its end inside the deployment",
        false,
        `exit ${acted.code}: ${(acted.stderr.trim() || acted.stdout.trim()).slice(-900)}`,
      );
    }
    for (const result of act ?? []) {
      if (result.ok === null) {
        finding(`not measured — ${result.name}: ${result.detail}`);
      } else check(result.name, result.ok, result.detail);
    }
    check(
      `the act's probe said all of what it tries (${ACT_CHECKS} things)`,
      (act?.length ?? 0) === ACT_CHECKS,
      `${act?.length ?? 0} reported`,
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

    // WITHOUT ITS KEY IT DOES NOT START EITHER. The same service, the same walls, and an empty
    // key where the deployment's was: a daemon that could prove nothing is not one to listen.
    const keyless = await compose([
      "run",
      "--rm",
      "--no-TTY",
      "--no-deps",
      "--env",
      `${KEY_VARIABLE}=`,
      "workbench",
    ]);
    const unkeyed = `${keyless.stdout}\n${keyless.stderr}`
      .split("\n")
      .find((line) => line.includes("workbench_refused"));
    check(
      "started without its key, the same service refuses to listen and says why",
      keyless.code !== 0 && unkeyed !== undefined && unkeyed.includes("no_key"),
      `exit ${keyless.code}: ${(unkeyed ?? keyless.stderr.trim()).slice(-400)}`,
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
