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
import {
  chmodSync,
  constants,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
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

/**
 * Whether a file that could not be placed is the REQUEST's doing: two files under one path, a file
 * where a folder has to be, a name too long — or no room left for it, in bytes or in names. Those
 * are answered as a request that is not one this service takes, and nothing was run. Anything else
 * (a disk that fails, a directory this user may not write) is the service's own trouble, and is
 * thrown as it is.
 *
 * "No room" was not here until 2026-10-06, and a request that ran the work root out of names made
 * the daemon quit.
 */
export const isRequestsFault = (code: string): boolean =>
  [
    "EEXIST",
    "ENOTDIR",
    "EISDIR",
    "ENAMETOOLONG",
    "ENOSPC",
    "EDQUOT",
    "EMLINK",
  ].includes(code);

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
      if (isRequestsFault(errnoOf(error))) throw new UnplaceableInputError();
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

/*
 * A NAME IS ITS BYTES. Everything below that goes through a directory a script could write lists
 * it as bytes and removes by bytes, because a name need not be text: on Linux it is any bytes but
 * `/` and NUL. Listed the ordinary way, a byte that is no character's comes back as the mark for
 * "not a character", and the path built from that names nothing — so `rm` with `force` removed
 * nothing and said nothing. Measured on the service 2026-10-07 (the second independent read's
 * finding): a script left `6e ff` in the work root, in shared memory and beside the socket, and a
 * closed folder `64 fe`; the next run found all four, and the daemon had answered as though it had
 * cleaned. They would have piled up, a handful of names from a full socket directory.
 *
 * So the removal is also HELD TO WHAT IT IS FOR: `emptyDirectory` looks again when it is done, and
 * a name still there is thrown as the failure it is — the daemon's cue to stop (`./daemon.ts`).
 */

/** A path whose last part may not be text. */
type BytePath = string | Buffer;

const SEPARATOR = Buffer.from("/");

const under = (directory: BytePath, name: Buffer): Buffer =>
  Buffer.concat([Buffer.from(directory), SEPARATOR, name]);

/** What a script left in a directory would not go: `left` names are still there. */
export class LeftBehindError extends Error {
  readonly code = "ELEFTBEHIND";
  constructor(readonly left: number) {
    super("a directory could not be emptied");
    this.name = "LeftBehindError";
  }
}

const kept = (keep: readonly string[], name: Buffer) =>
  keep.some((one) => Buffer.from(one).equals(name));

/** A directory's names, as the bytes they are. The runtime hands back plain byte arrays. */
const namesIn = async (directory: BytePath): Promise<Buffer[]> =>
  (await readdir(directory, { encoding: "buffer" })).map((name) =>
    Buffer.from(name),
  );

const namesInSync = (directory: BytePath): Buffer[] =>
  readdirSync(directory, { encoding: "buffer" }).map((name) =>
    Buffer.from(name),
  );

/**
 * How long a folder's path may get, inside a tree being opened up, before the folder is moved to
 * the top of that tree. Well under the shortest limit a path has anywhere this runs (1,024 bytes
 * on a laptop, 4,096 on Linux), with room left for one more name of 255.
 */
const MOVE_UP_PAST_BYTES = 600;

/** Whether a path is a folder itself — not a link to one, and not something that cannot be asked. */
const isFolder = (path: BytePath): boolean => {
  try {
    return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
};

/**
 * Give a tree back to its owner: a script may have closed any folder in it to its own user.
 *
 * AT ANY DEPTH. Removing a tree walks down it however deep it goes; opening up what a script
 * closed went by PATH, and a path has a longest. Sixteen folders of 255 bytes are past it, and a
 * script can build that without ever naming it — two halves, one moved under the other. Closed at
 * the bottom, such a tree could be neither opened nor removed: on a laptop the cleanup threw
 * EACCES (and ENAMETOOLONG from its synchronous twin) and left it; on the service it was built
 * beside the socket, where it outlives the container, and no daemon could start again (the third
 * read, 2026-10-07; the rehearsal's first run of it).
 *
 * So no path here is ever long. A folder whose path has grown past a bound is MOVED to the top of
 * the tree under a name of this function's own, and the walk goes on from there: the tree is on
 * its way to being removed, and what shape it is in meanwhile is nobody's concern. Every folder is
 * then reached by a path of a few hundred bytes, opened, and left where the removal that follows
 * can name it too.
 *
 * Synchronous for both callers — a daemon starting or leaving cannot wait, and after a run
 * nothing else is happening. Never through a link: only what is itself a folder is opened.
 */
function unlock(top: BytePath): void {
  const root = Buffer.from(top);
  let moved = 0;
  const waiting: Buffer[] = [root];
  for (let folder = waiting.pop(); folder; folder = waiting.pop()) {
    try {
      chmodSync(folder, 0o700);
    } catch {
      // Not this user's to open; the removal after this says so.
    }
    let names: Buffer[];
    try {
      names = namesInSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      let path = under(folder, name);
      if (!isFolder(path)) continue;
      if (path.byteLength > MOVE_UP_PAST_BYTES) {
        try {
          // A folder moved to another parent has to be its user's to write.
          chmodSync(path, 0o700);
          let to: Buffer;
          do {
            to = under(root, Buffer.from(`.moved-up-${moved}`));
            moved += 1;
          } while (lstatSync(to, { throwIfNoEntry: false }));
          renameSync(path, to);
          path = to;
        } catch {
          // Left where it is, to be walked as far as its path allows; the removal says the rest.
        }
      }
      waiting.push(path);
    }
  }
}

/** Remove a path and everything under it. Throws when it could not. */
export async function removeTree(path: BytePath): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch {
    // A link is removed as a link: only what is still a folder is opened up.
    if (isFolder(path)) unlock(path);
  }
  await rm(path, { recursive: true, force: true });
}

/** {@link removeTree}, synchronously. Whatever is at the path — a file, a socket, a link, a tree. */
export function removeTreeSync(path: BytePath): void {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch {
    if (isFolder(path)) unlock(path);
  }
  rmSync(path, { recursive: true, force: true });
}

/**
 * {@link emptyDirectory}, synchronously, and taking the directory back first: a script may have
 * closed it. Throws when something is still there afterwards.
 */
export function emptyDirectorySync(
  directory: string,
  keep: readonly string[] = [],
): void {
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Not there, or not this user's: the listing below says which.
  }
  let names: Buffer[];
  try {
    names = namesInSync(directory);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!kept(keep, name)) removeTreeSync(under(directory, name));
  }
  const left = namesInSync(directory).filter((name) => !kept(keep, name));
  if (left.length > 0) throw new LeftBehindError(left.length);
}

/**
 * Remove everything in a directory but the names given. A directory that is not there is empty.
 * Throws when something is still there afterwards.
 */
export async function emptyDirectory(
  directory: string,
  keep: readonly string[] = [],
): Promise<void> {
  let names: Buffer[];
  try {
    names = await namesIn(directory);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!kept(keep, name)) await removeTree(under(directory, name));
  }
  const left = (await namesIn(directory)).filter((name) => !kept(keep, name));
  if (left.length > 0) throw new LeftBehindError(left.length);
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
  /*
   * LISTENED FOR FROM HERE, not from when the script starts. An abort is an event, and one that
   * fires with nobody listening is not heard later: until 2026-10-06 the listener was added after
   * the files had been placed, so a caller that gave up while they were — the largest request is
   * twenty megabytes onto a tmpfs — had its run go on to its timeout (measured: a three-second
   * run, abandoned before it started, ran its three seconds and reported `timed_out`).
   */
  let abandoned = false;
  let endRun: (() => void) | null = null;
  const onAbort = () => {
    abandoned = true;
    endRun?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
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
    // Given up on before anything was started: nothing to end, nothing to sweep.
    if (abandoned) throw new RunAbandonedError();

    const started = performance.now();
    const child = Bun.spawn(runner.command(scriptPath), {
      cwd: files,
      env: runner.environment({ home, temporary }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let ending: RunEnding = "exited";
    let over = false;
    const end = (why: "timed_out" | "out_of_memory") => {
      if (over) return;
      if (ending === "exited") ending = why;
      child.kill("SIGKILL");
    };
    endRun = () => {
      if (!over) child.kill("SIGKILL");
    };
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
    /*
     * A BOUND ENDED IT ONLY WHERE THE KILL DID. `end` notes which bound was met and sends
     * SIGKILL; a script that had already left by itself in that same instant was not ended by
     * it — it has a status of its own and no signal — and saying "stopped at its time" of it
     * would be a report that contradicts itself: a run killed at a bound, with exit 0. The
     * server's client passes no such answer on (`server/src/workbench/client.ts`, `runFrom`),
     * so an honest run would have been lost to a race. What ended it is what the child says.
     */
    const endedBy: RunEnding =
      ending !== "exited" && signalled === "SIGKILL" ? ending : "exited";
    const collected: Collected =
      endedBy === "exited" && exitCode === 0
        ? await collect(out, limits)
        : { products: [], skipped: 0 };
    return {
      report: {
        ending: endedBy,
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
    signal?.removeEventListener("abort", onAbort);
    await removeTree(directory);
  }
}
