/**
 * WHERE A PROCESS IS RUNNING, AS THE PROCESS ITSELF CAN READ IT — and the judgement of whether that
 * is where compose was meant to put it.
 *
 * Two services of a deployment exist to do something the API server must not do beside the
 * database and every sealed token: the `converter` parses files a stranger made, and the
 * `workbench` runs a script a model wrote. Both are given the same walls by `docker-compose.yml` —
 * not root, no network, no capability, no new privileges, a read-only root — and neither takes
 * them on trust: each reads these facts before it listens and refuses to start where one of them
 * quietly stopped being true (a compose file edited by hand, a runtime that ignores a key).
 *
 * Here, in `shared/`, since 2026-10-06, out of `server/src/attachments/converter-daemon.ts`, when
 * the workbench came to need the same reading: one judgement of "isolated as compose means it",
 * not a second copy to drift from the first. Nothing here is the server's; it is Bun and `/proc`.
 */
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

/** What the checks read, gathered once so the judgement below is a pure function a test can drive. */
export type IsolationFacts = {
  uid: number | null;
  /** Interfaces with an address that is not loopback. */
  externalInterfaces: string[];
  /** The capability bounding set, as the hex `/proc/self/status` prints. Null off Linux. */
  capabilityBounding: string | null;
  noNewPrivileges: boolean | null;
  rootReadOnly: boolean | null;
};

/** One line of `/proc/self/mounts`: where, what kind of filesystem, and how it was mounted. */
type Mount = { at: string; filesystem: string; options: string[] };

/** What is mounted in this process's view, in the order it was mounted. Empty off Linux. */
function mountsOf(): Mount[] {
  try {
    return readFileSync("/proc/self/mounts", "utf8")
      .split("\n")
      .map((line) => line.split(" "))
      .filter((fields) => fields.length >= 4)
      .map((fields) => ({
        at: fields[1] ?? "",
        filesystem: fields[2] ?? "",
        options: (fields[3] ?? "").split(","),
      }));
  } catch {
    return [];
  }
}

/**
 * The kind of filesystem mounted AT a path — `tmpfs`, `overlay`, `ext4` — or null when nothing is
 * mounted exactly there, or this is not Linux. The last mount at a path is the one in force.
 */
export function filesystemAt(path: string): string | null {
  return (
    mountsOf()
      .filter((mount) => mount.at === path)
      .at(-1)?.filesystem ?? null
  );
}

export function readIsolationFacts(): IsolationFacts {
  const status = (() => {
    try {
      return readFileSync("/proc/self/status", "utf8");
    } catch {
      return null;
    }
  })();
  const field = (name: string) =>
    status?.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1] ?? null;
  const rootReadOnly = (() => {
    const root = mountsOf()
      .filter((mount) => mount.at === "/")
      .at(-1);
    return root ? root.options.includes("ro") : null;
  })();
  const noNewPrivileges = field("NoNewPrivs");
  return {
    uid: process.getuid?.() ?? null,
    externalInterfaces: Object.entries(networkInterfaces())
      .filter(([, addresses]) =>
        (addresses ?? []).some((address) => !address.internal),
      )
      .map(([name]) => name),
    capabilityBounding: field("CapBnd"),
    noNewPrivileges: noNewPrivileges === null ? null : noNewPrivileges === "1",
    rootReadOnly,
  };
}

/** What is not as compose says it should be. Empty is isolated. */
export function isolationProblems(facts: IsolationFacts): string[] {
  const problems: string[] = [];
  if (facts.uid === null || facts.uid === 0) problems.push("runs_as_root");
  if (facts.externalInterfaces.length > 0) problems.push("has_network");
  if (
    facts.capabilityBounding === null ||
    !/^0+$/.test(facts.capabilityBounding)
  ) {
    problems.push("holds_capabilities");
  }
  if (facts.noNewPrivileges !== true) problems.push("may_gain_privileges");
  if (facts.rootReadOnly !== true) problems.push("root_writable");
  return problems;
}
