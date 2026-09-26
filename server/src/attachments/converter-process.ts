/**
 * One file, read in a process of its own that dies when the reading is done.
 *
 * A FRESH PROCESS PER FILE. The parsers are pure JavaScript, so what a hostile file can do to them
 * is the JavaScript kind of harm: pollute a prototype, wedge a loop, balloon the heap. In a process
 * that lives on, each of those is inherited by the next file somebody sends — a polluted
 * `Object.prototype` reads every later workbook wrong. A process per file hands each one a clean
 * runtime. Measured cost is in docs/laf/deploying.md (converter); an upload is not a hot path.
 *
 * Bounded twice, from outside, because the parse is synchronous and a child cannot watch itself:
 * SheetJS in a loop never yields to a timer. The time bound is a SIGKILL at `timeoutMs`; the memory
 * bound is the child's resident set, read every few tens of milliseconds and killed past
 * `memoryBytes`. Not an rlimit: JavaScriptCore reserves tens of gigabytes of address space at start,
 * so `RLIMIT_AS` stops bun before it runs a line, and the container's cgroup is the backstop.
 *
 * The child is handed NOTHING of this process: an empty environment (a development server holds every
 * key in its own), `/` as its directory and `--no-env-file`, because bun reads a `.env` from where it
 * starts. Its stdout and stderr go nowhere — pdf.js prints warnings there, and they can quote the
 * file — and the answer comes back over the IPC channel, which only this parent reads.
 */
import { readFile } from "node:fs/promises";
import {
  type Conversion,
  type ConversionJob,
  conversionFrom,
} from "./conversion";

export type ConversionLimits = {
  /** How long one file may take, from the spawn to the answer. */
  timeoutMs: number;
  /** The most the child may hold resident. */
  memoryBytes: number;
};

/**
 * Twenty seconds: a 10 MB workbook, the largest file accepted, reads in a few on the recommended
 * 1-OCPU VM (measured, deploying.md), and the person is watching a chip spin while it does.
 * 512 MB: the same workbook peaks well under it, and the sidecar's ceiling holds two at once.
 */
export const CONVERSION_LIMITS: ConversionLimits = {
  timeoutMs: 20_000,
  memoryBytes: 512 * 1024 * 1024,
};

/**
 * A laptop's local child, run from source: bun transpiles pdf.js cold in every child — no cache
 * is handed over, because a cache a child can write is one a hostile file could leave something in
 * for the next — and that alone peaked at 570 MB resident for a one-page PDF (measured 2026-09-26).
 * The bundle the sidecar runs never transpiles and keeps {@link CONVERSION_LIMITS}.
 */
export const SOURCE_CONVERSION_LIMITS: ConversionLimits = {
  timeoutMs: 20_000,
  memoryBytes: 1024 * 1024 * 1024,
};

const fromSource = (command: readonly string[]) =>
  command.some((part) => part.endsWith(".ts"));

/** Why a reading produced no answer. Each is logged by name; the person sees one refusal for all. */
export type ConversionFailure = "timeout" | "memory" | "crashed" | "malformed";

export type ConversionOutcome =
  | { ok: true; conversion: Conversion }
  | { ok: false; failure: ConversionFailure };

/**
 * What the child is started with, and all it is started with.
 *
 * The transpiler cache is off for every child. The bundle (`dist/converter.js`, the sidecar's)
 * needs no transpiling and its read-only root has nowhere to keep one; from source — a laptop's
 * local child — a cache the child can write would outlive it, which is what a process per file is
 * for not letting happen. That child pays for it in memory instead ({@link SOURCE_CONVERSION_LIMITS}).
 */
function childEnvironment(): Record<string, string> {
  return {
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    // No colour codes in anything that does get printed, and no telemetry to phone home with.
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  };
}

/**
 * How a child is started from `entry` (`converter.ts`, or its bundle).
 *
 * `--no-install` because the bundle reaches for a package it does not carry: pdf.js asks for an
 * optional canvas module, and bun's auto-install answers a missing package — when no
 * `node_modules` is in sight — by trying to download it. Measured 2026-09-26 on the bundle run
 * outside the repository with the empty environment below: every PDF died with "bun is unable to
 * write files: ReadOnlyFileSystem", from the install cache it tried to write, and with a network
 * the child would have fetched code from the registry mid-parse. `--no-env-file`: see above.
 */
export function jobCommandFor(entry: string): string[] {
  return [process.execPath, "--no-env-file", "--no-install", entry, "--job"];
}

/** How often the child's memory is read. `ps` on a laptop costs more than `/proc` does. */
const WATCH_EVERY_MS = process.platform === "linux" ? 25 : 100;

/** The child's resident set in bytes, or null when it cannot be read (it has exited). */
async function residentBytes(pid: number): Promise<number | null> {
  try {
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const kilobytes = status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1];
      return kilobytes ? Number(kilobytes) * 1024 : null;
    }
    const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const kilobytes = Number.parseInt(
      (await new Response(ps.stdout).text()).trim(),
      10,
    );
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Read one file in a fresh child. `command` starts the child's side (`converter.ts --job`); it is a
 * parameter so a test can start a child that hangs or grows instead.
 */
export function convertInFreshProcess(
  job: ConversionJob,
  options: { command: readonly string[]; limits?: ConversionLimits },
): Promise<ConversionOutcome> {
  const limits =
    options.limits ??
    (fromSource(options.command)
      ? SOURCE_CONVERSION_LIMITS
      : CONVERSION_LIMITS);
  const [executable = process.execPath, ...rest] = options.command;
  return new Promise((resolve) => {
    let settled = false;
    let watching = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const settle = (outcome: ConversionOutcome) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      clearInterval(watch);
      // Answered or not, the child is done: one file per process, and nothing lingers.
      child.kill("SIGKILL");
      resolve(outcome);
    };

    const child = Bun.spawn({
      cmd: [executable, ...rest],
      cwd: "/",
      env: childEnvironment(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      serialization: "advanced",
      ipc(message) {
        const conversion = conversionFrom(message);
        settle(
          conversion
            ? { ok: true, conversion }
            : { ok: false, failure: "malformed" },
        );
      },
    });

    timers.push(
      setTimeout(
        () => settle({ ok: false, failure: "timeout" }),
        limits.timeoutMs,
      ),
    );
    const watch = setInterval(async () => {
      if (watching || settled) return;
      watching = true;
      const resident = await residentBytes(child.pid);
      watching = false;
      if (resident !== null && resident > limits.memoryBytes) {
        settle({ ok: false, failure: "memory" });
      }
    }, WATCH_EVERY_MS);

    // Exited without answering: killed from outside (the cgroup's OOM killer), or it threw.
    void child.exited.then(() => settle({ ok: false, failure: "crashed" }));

    child.send({ name: job.name, bytes: job.bytes });
  });
}

/**
 * The child's side: take one job from the parent, answer it, and go. Started as
 * `converter.ts --job`; never imported by the server.
 */
export function answerOneJob(): void {
  process.once("message", async (message: unknown) => {
    const job = message as Partial<ConversionJob> | null;
    const name = typeof job?.name === "string" ? job.name : "";
    const bytes = job?.bytes instanceof Uint8Array ? job.bytes : null;
    if (!bytes) {
      process.exit(2);
    }
    const { convertUpload } = await import("./conversion");
    const conversion = await convertUpload({ name, bytes });
    /*
     * NOT `disconnect()` after the send. Measured on bun 1.3.11: a sheet's answer is a few hundred
     * kilobytes, the send queues it, and a disconnect right behind it closed the channel with the
     * answer still in the queue — the child exited 0 and the parent heard nothing. The parent kills
     * this process the moment the answer arrives; the channel closing (the parent gone) ends it too.
     */
    process.send?.(conversion);
    process.once("disconnect", () => process.exit(0));
  });
}
