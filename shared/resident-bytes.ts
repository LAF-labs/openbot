/**
 * How much memory a process is holding, read from outside it.
 *
 * FROM OUTSIDE, BECAUSE THE PROCESS CANNOT BE ASKED. Both places that read this bound somebody
 * else's code — a parser over a stranger's file (`server/src/attachments/converter-process.ts`), a
 * script a model wrote (`shared/workbench/run.ts`) — and code in a tight loop never yields to a
 * timer of its own. Not an rlimit either: JavaScriptCore reserves tens of gigabytes of address
 * space at start, so `RLIMIT_AS` stops bun before it runs a line. The watcher reads the resident
 * set every few tens of milliseconds and the container's cgroup is the backstop.
 */
import { readFile } from "node:fs/promises";

/** How often a child's memory is read. `ps` on a laptop costs more than `/proc` does. */
export const WATCH_EVERY_MS = process.platform === "linux" ? 25 : 100;

/** The process's resident set in bytes, or null when it cannot be read (it has exited). */
export async function residentBytes(pid: number): Promise<number | null> {
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
