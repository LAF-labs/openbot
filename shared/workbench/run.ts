/**
 * ONE RUN: a script, the files it may read, a directory that exists for it alone, and what is left
 * when it is over.
 *
 *   <work>/run-XXXXXX/
 *     script/   the script, the libraries it may import, the interpreter's config — nothing sent
 *     files/    where it starts: each file it was handed, at the path it was handed under
 *     files/out/  what it writes here is what it hands back
 *     home/ tmp/  somewhere for an interpreter to put what it insists on putting somewhere
 *
 * THE ORDER AFTER THE SCRIPT ENDS IS THE POINT. First everything it started is ended (`sweep`),
 * and only then is a byte of what it wrote read: a process still running could swap a file for a
 * link between the look and the read, and could hold a pipe open for ever. Then the files are
 * collected — plain files directly in `out/`, opened without following a link, never more of one
 * than its size said. Then the whole directory goes, whatever happened.
 *
 * Anything here that fails in a way the request did not cause — the sweep, the removal — is thrown
 * as it is, and the daemon stops taking runs: a service that could not clean up after one script
 * is not one to hand the next person's file to.
 */
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { residentBytes, WATCH_EVERY_MS } from "../resident-bytes";
import {
  isProductName,
  isRunPath,
  type ProductsRefusal,
  productPart,
  type RunEnding,
  type RunReport,
  type WORKBENCH_LIMITS,
} from "./protocol";
import type { Runner } from "./runner";

/** The bounds, as numbers a test can make small. */
export type WorkbenchLimits = {
  [Bound in keyof typeof WORKBENCH_LIMITS]: number;
};

export type RunInput = { path: string; bytes: Uint8Array };
export type RunJob = {
  script: string;
  files: readonly RunInput[];
  timeoutMs: number;
};
/** The report, and the bytes of each file it names, in the report's own order. */
export type RunOutcome = {
  report: RunReport;
  products: Uint8Array<ArrayBuffer>[];
};

/** A file could not be put where the request said. The request's fault, and nothing was run. */
export class UnplaceableInputError extends Error {
  constructor() {
    super("an input could not be placed");
    this.name = "UnplaceableInputError";
  }
}

/** Whoever asked has gone. The run was ended and cleaned up after; there is nobody to tell. */
export class RunAbandonedError extends Error {
  constructor() {
    super("the run was abandoned");
    this.name = "RunAbandonedError";
  }
}

/** The one name at the top of a run's files that is the daemon's: what is in it goes back. */
export const OUT = "out";

/**
 * How long the script's output is waited for once every process that could write it is gone. They
 * are gone, so this is the time it takes to read what is already in a pipe.
 */
const DRAIN_MS = 1_000;

/** Read a stream to its end, keep the first `keep` bytes of it, and count the rest. */
function capture(stream: ReadableStream<Uint8Array>, keep: number) {
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  let total = 0;
  const done = (async () => {
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) return;
      total += value.byteLength;
      if (keptBytes < keep) {
        // A copy: the piece is the stream's to reuse.
        const piece = value.slice(0, keep - keptBytes);
        kept.push(piece);
        keptBytes += piece.byteLength;
      }
    }
  })().catch(() => {});
  return {
    done,
    stop: () => void reader.cancel().catch(() => {}),
    // Bytes cut mid-character, or never text at all, become the mark for "not a character".
    text: () => new TextDecoder().decode(Buffer.concat(kept)),
    total: () => total,
  };
}

const errnoOf = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : "";

/** Put each file where its path says, under `files`, and nowhere else. */
async function place(
  files: string,
  inputs: readonly RunInput[],
  reserved: readonly string[],
): Promise<void> {
  for (const input of inputs) {
    // The daemon has asked already. Asked again here, because here is where a path becomes a write.
    if (!isRunPath(input.path)) throw new UnplaceableInputError();
    if (reserved.includes(input.path.split("/")[0] ?? "")) {
      throw new UnplaceableInputError();
    }
    const full = join(files, input.path);
    try {
      await mkdir(dirname(full), { recursive: true });
      // `wx`: two inputs under one path, or one under another's name, is a request that
      // contradicts itself, not a file to overwrite.
      await writeFile(full, input.bytes, { flag: "wx" });
    } catch (error) {
      if (
        ["EEXIST", "ENOTDIR", "EISDIR", "ENAMETOOLONG"].includes(errnoOf(error))
      ) {
        throw new UnplaceableInputError();
      }
      throw error;
    }
  }
}

/**
 * Take back each directory on the way down to what has to be read, outermost first: a script owns
 * all of them and may have closed any. Only what is still a directory — a link a script left in
 * one's place is not followed to whatever it points at.
 */
async function reclaim(directories: readonly string[]): Promise<void> {
  for (const directory of directories) {
    const entry = await lstat(directory).catch(() => null);
    if (entry?.isDirectory()) await chmod(directory, 0o700).catch(() => {});
  }
}

/** Give a tree back to its owner: a script may have closed a directory to its own user. */
async function unlock(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => {});
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    // The entry's own kind, as the directory records it: a link to a directory is a link.
    if (entry.isDirectory()) await unlock(join(directory, entry.name));
  }
}

/** Remove a path and everything under it. Throws when something is still there afterwards. */
export async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch {
    await unlock(path);
  }
  await rm(path, { recursive: true, force: true });
}

/** Remove everything in a directory but the names given. A directory that is not there is empty. */
export async function emptyDirectory(
  directory: string,
  keep: readonly string[] = [],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!keep.includes(name)) await removeTree(join(directory, name));
  }
}

type Collected = {
  products: { name: string; bytes: Uint8Array<ArrayBuffer> }[];
  refused?: ProductsRefusal;
  skipped: number;
};

/**
 * What the script left to hand back: the plain files directly in `out/`.
 *
 * All of them or none. A script that made nine files where eight are taken did not make "the
 * first eight"; handing back a part would be the daemon choosing which of somebody's results count.
 */
async function collect(
  out: string,
  limits: WorkbenchLimits,
): Promise<Collected> {
  // `out/` itself, where the daemon made it — not what a link left in its place, or in the place
  // of a directory above it, points at. `out` was resolved when it was made, so a path that
  // resolves to anything else now goes through something a script put there.
  const resolved = await realpath(out).catch(() => null);
  const directory = await lstat(out).catch(() => null);
  if (resolved !== out || !directory?.isDirectory()) {
    return { products: [], skipped: 0 };
  }
  const names = (await readdir(out)).sort();
  let skipped = 0;
  const found: { name: string; size: number }[] = [];
  for (const name of names) {
    const entry = await lstat(join(out, name)).catch(() => null);
    if (!entry?.isFile() || !isProductName(name)) {
      skipped += 1;
      continue;
    }
    found.push({ name, size: entry.size });
  }
  if (found.length > limits.products) {
    return { products: [], refused: "too_many", skipped };
  }
  if (found.some((file) => file.size > limits.productBytes)) {
    return { products: [], refused: "too_large", skipped };
  }
  if (found.reduce((sum, file) => sum + file.size, 0) > limits.productsBytes) {
    return { products: [], refused: "too_large_together", skipped };
  }
  const products: Collected["products"] = [];
  for (const { name, size } of found) {
    // A script may have closed its own file to its own user; it is still the file it made. The
    // look above said it is a plain file, and nothing is left running that could change that.
    await chmod(join(out, name), 0o600).catch(() => {});
    const file = await open(
      join(out, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      // As much as its size said and no more, whatever it is by now.
      const bytes = new Uint8Array(size);
      const { bytesRead } = await file.read(bytes, 0, size, 0);
      products.push({ name, bytes: bytes.subarray(0, bytesRead) });
    } finally {
      await file.close();
    }
  }
  return { products, skipped };
}

/**
 * Run one script and say how it ended.
 *
 * Throws {@link UnplaceableInputError} before anything ran, {@link RunAbandonedError} after a run
 * nobody waits for was ended — and anything else as it is, which is the daemon's cue to stop.
 */
export async function runScript(
  job: RunJob,
  options: {
    workRoot: string;
    runner: Runner;
    limits: WorkbenchLimits;
    /** End every process the run left. Called once the script's own process has ended. */
    sweep: () => Promise<void>;
    /** What the run holds in memory, read from outside it. The script's own process by default. */
    memoryOf?: (pid: number) => Promise<number | null>;
    signal?: AbortSignal;
  },
): Promise<RunOutcome> {
  const { runner, limits, signal } = options;
  if (signal?.aborted) throw new RunAbandonedError();
  const memoryOf = options.memoryOf ?? residentBytes;
  // Resolved once, now, while nothing but the daemon has touched it: every path below is the real
  // one, so that what is read after the run can be held to it (`collect`).
  const directory = await realpath(
    await mkdtemp(join(options.workRoot, "run-")),
  );
  try {
    const scriptDirectory = join(directory, "script");
    const files = join(directory, "files");
    const out = join(files, OUT);
    const home = join(directory, "home");
    const temporary = join(directory, "tmp");
    for (const made of [scriptDirectory, out, home, temporary]) {
      await mkdir(made, { recursive: true });
    }
    await runner.prepare(scriptDirectory);
    const scriptPath = join(scriptDirectory, runner.scriptName);
    await writeFile(scriptPath, job.script);
    await place(files, job.files, [OUT, ...runner.reserved]);

    const started = performance.now();
    const child = Bun.spawn(runner.command(scriptPath), {
      cwd: files,
      env: runner.environment({ home, temporary }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let ending: RunEnding = "exited";
    let abandoned = false;
    let over = false;
    const end = (why: "timed_out" | "out_of_memory" | "abandoned") => {
      if (over) return;
      if (why === "abandoned") abandoned = true;
      else if (ending === "exited") ending = why;
      child.kill("SIGKILL");
    };
    const onAbort = () => end("abandoned");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => end("timed_out"), job.timeoutMs);
    // Read from outside, because code in a tight loop never yields to a timer of its own.
    const watcher = setInterval(() => {
      void memoryOf(child.pid).then((bytes) => {
        if (bytes !== null && bytes > limits.memoryBytes) end("out_of_memory");
      });
    }, WATCH_EVERY_MS);
    const stdout = capture(child.stdout, limits.streamBytes);
    const stderr = capture(child.stderr, limits.streamBytes);
    let status: number;
    try {
      status = await child.exited;
    } finally {
      over = true;
      clearTimeout(timer);
      clearInterval(watcher);
      signal?.removeEventListener("abort", onAbort);
    }
    const ms = Math.round(performance.now() - started);

    // Before anything it wrote is read, and before its pipes are waited for.
    await options.sweep();
    await reclaim([options.workRoot, directory, files, out]);
    await Promise.race([
      Promise.all([stdout.done, stderr.done]),
      Bun.sleep(DRAIN_MS),
    ]);
    stdout.stop();
    stderr.stop();
    if (abandoned) throw new RunAbandonedError();

    const signalled = child.signalCode ?? null;
    const exitCode = signalled === null ? status : null;
    const collected: Collected =
      ending === "exited" && exitCode === 0
        ? await collect(out, limits)
        : { products: [], skipped: 0 };
    return {
      report: {
        ending,
        exitCode,
        signal: signalled,
        ms,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutBytes: stdout.total(),
        stderrBytes: stderr.total(),
        products: collected.products.map((product, index) => ({
          name: product.name,
          bytes: product.bytes.byteLength,
          part: productPart(index),
        })),
        ...(collected.refused ? { productsRefused: collected.refused } : {}),
        skipped: collected.skipped,
      },
      products: collected.products.map((product) => product.bytes),
    };
  } finally {
    await removeTree(directory);
  }
}
