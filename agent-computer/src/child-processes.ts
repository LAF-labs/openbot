/**
 * Every process this one starts stays referenced for as long as this one runs.
 *
 * A RUNTIME BUG, AND THE ONE BEHIND "8 PAGE TIMEOUTS IN ONE RUN OF FOUR" (W1-d, 2026-09-13).
 * Playwright talks to Chromium over two pipes the browser inherits as fd 3 and 4
 * (`--remote-debugging-pipe`). Bun's `node:child_process` closes a finished child's pipes when the
 * child exits, and then closes them AGAIN, by number, when the `ChildProcess` object is garbage-
 * collected — by which time the numbers belong to whichever browser was launched next. That
 * browser's DevTools pipe is gone underneath it: Chromium logs "Connection terminated while reading
 * from pipe" and exits 0, while Playwright, which never sees its end close, goes on calling the
 * browser connected. Every call without a deadline then waits for ever; `goto` waits out its 30s.
 *
 * Measured 2026-09-14, in this image (Bun 1.3.14, Playwright 1.62.1) and on macOS (Bun 1.3.11):
 *  - the W1-d shape, 5 Bots x 20 navigations then reset, in a container: a run that lost all five
 *    browsers within 1-5s of launch — 5 page timeouts at once whose requests never reached the
 *    site, and 5 calls hung past 120s — in 1 run of 4 on main, and in runs 2 and 4 of 5 with logging
 *    added. Browser processes gone (pids 350 -> 25) with no memory or IO pressure, no OOM, no lag.
 *  - with no product code at all: launch 3 browsers, close them, launch 3, `Bun.gc(true)` — 9 of 9
 *    new browsers dead; without the forced collection 9 of 9 alive; keeping the closed browsers'
 *    `ChildProcess` objects referenced, 9 of 9 alive; keeping only their stdio streams, 8 of 9 dead.
 *
 * So the object that must never be collected is the `ChildProcess`. What it costs to keep one is its
 * own object and five streams: the listeners that tie it to Playwright's browser, pages and
 * transport are taken off once the process has closed, so a closed browser keeps nothing of itself —
 * measured, 30 browsers launched and closed left the heap at 24.9 MiB from 25.0 (34 KiB each with the
 * listeners kept).
 * Upstream Bun has a regression test named "extra stdio pipes are not double-closed on GC"; when the
 * pinned Bun passes the test in `tests/closed-browser-pipes.test.ts` without this, this can go.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";

type SpawnModule = {
  spawn: (
    command: string,
    args?: readonly string[],
    options?: SpawnOptions,
  ) => ChildProcess;
};

const KEPT = Symbol.for("laf.agent-computer.kept-child-processes");

/** Nothing listens after close; an error nobody listens for would be thrown instead. */
const ignore = () => undefined;

function letGoOfListeners(child: ChildProcess): void {
  for (const stream of child.stdio) {
    if (!stream) continue;
    stream.removeAllListeners();
    stream.on("error", ignore);
  }
  child.removeAllListeners();
  child.on("error", ignore);
}

/**
 * Wrap `spawn` so every child is kept. Idempotent: a second call returns the same set.
 *
 * `child_process` is Node's CommonJS module object, which Playwright reads `spawn` from at the moment
 * it launches (`childProcess.spawn(...)` through a live getter), so wrapping it before the first
 * browser covers every browser.
 */
export function keepChildProcesses(
  module: SpawnModule = require("node:child_process") as SpawnModule,
): ReadonlySet<ChildProcess> {
  const marked = module as SpawnModule & { [KEPT]?: Set<ChildProcess> };
  const existing = marked[KEPT];
  if (existing) return existing;

  const kept = new Set<ChildProcess>();
  const spawn = module.spawn;
  module.spawn = (command, args, options) => {
    const child = spawn(command, args, options);
    kept.add(child);
    // After everything else that listens for close has heard it, which is Playwright's own cleanup.
    child.once("close", () => setTimeout(() => letGoOfListeners(child), 0));
    return child;
  };
  Object.defineProperty(module, KEPT, { value: kept });
  return kept;
}
