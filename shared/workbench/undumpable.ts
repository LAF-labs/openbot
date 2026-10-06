/**
 * The daemon closing its own memory to the scripts it runs.
 *
 * A script runs as the daemon's own user, and a process may read and write the memory of another
 * of its user's processes (`ptrace`, `/proc/<pid>/mem`) unless something says otherwise. Two
 * things can: the host (Yama's `ptrace_scope`, on by default on Ubuntu, absent from some kernels),
 * and the process itself, by declaring that it is not to be dumped — `prctl(PR_SET_DUMPABLE, 0)`,
 * after which attaching takes a capability, and nothing in this container holds one. The daemon
 * does not count on the host: it asks for the second, here.
 *
 * Bun has no call for `prctl`, so this is the one use of `bun:ffi` in the repository. Whether it
 * worked is never taken from what this function returns: `readSandboxFacts` (`./sweep.ts`) reads
 * the result back off `/proc`, and a daemon whose memory is neither closed this way nor kept by
 * the host refuses to start. So a runtime where `bun:ffi` is not there — it is marked experimental
 * — fails as "not isolated", loudly, and not as a wall that is only on paper.
 *
 * Imported lazily and only on Linux: nothing that loads this file on a laptop opens a library.
 */

/** `PR_SET_DUMPABLE` in `<linux/prctl.h>`. */
const PR_SET_DUMPABLE = 4;

/** Ask the kernel to keep every other unprivileged process out of this one. True when it said yes. */
export async function makeUndumpable(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const libc = dlopen("libc.so.6", {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    try {
      return libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) === 0;
    } finally {
      libc.close();
    }
  } catch {
    return false;
  }
}
