import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The Bot's browser must not run as root with its sandbox off (audit A5 §1, 2026-09-10).
 *
 * Measured on the shipped image: `docker exec … id` → `uid=0(root)`, and `profiles.ts` passed
 * `--no-sandbox`. This browser opens pages a model chose while holding somebody's bank cookies; one
 * renderer bug was the whole container. The runtime proof is the container itself (uid 1001, each
 * renderer in a user, PID and network namespace of its own — measured 2026-09-13 on Ubuntu 24.04
 * aarch64). These are the halves the gate can run: the source, the image and the compose file that
 * together make it true, so that putting the flag back, dropping `USER`, or losing the seccomp
 * profile or the volume hand-over is a red run rather than a quiet return to root.
 */
const ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

type ComputerService = {
  init?: boolean;
  pids_limit?: number;
  security_opt?: string[];
  user?: string;
  post_start?: { command?: string[]; user?: string }[];
};

const computer = (
  parseYaml(read("docker-compose.yml")) as {
    services: Record<string, ComputerService>;
  }
).services["agent-computer"];

describe("the browser's sandbox", () => {
  test("no launch arg turns the sandbox off", () => {
    const profiles = read("agent-computer/src/profiles.ts");
    const start = profiles.indexOf("const LAUNCH_ARGS = [");
    const args = profiles.slice(start, profiles.indexOf("];", start));
    expect(args).not.toContain("--no-sandbox");
    // The flags that stay are here on purpose; this pins that the array was found and read.
    expect(args).toContain("--disable-dev-shm-usage");
  });

  test("and Playwright is told not to add the flag itself", () => {
    /*
     * The half the audit's suggested test would have missed. Playwright appends `--no-sandbox`
     * unless launched with `chromiumSandbox: true`; measured 2026-09-13, the rebuilt container ran
     * with the flag gone from LAUNCH_ARGS and still on the browser's command line.
     */
    const profiles = read("agent-computer/src/profiles.ts");
    expect(profiles).toMatch(
      /launchPersistentContext\(dir, \{[^}]*chromiumSandbox: true,/s,
    );
    expect(profiles).not.toContain("chromiumSandbox: false");
  });

  test("the image runs as pwuser, and owns both volume roots by it", () => {
    const dockerfile = read("agent-computer/Dockerfile");
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map(
      (match) => match[1],
    );
    // The last USER is the one the process runs as.
    expect(users.at(-1)).toBe("pwuser");
    expect(dockerfile).toContain("chown pwuser:pwuser /workspace /profiles");
  });

  test("compose does not put the process back on root", () => {
    expect(computer).toBeDefined();
    expect(computer?.user).toBeUndefined();
  });

  test("compose hands the container Playwright's seccomp profile and a pid ceiling", () => {
    expect(computer?.security_opt).toEqual([
      "seccomp=./agent-computer/seccomp_profile.json",
    ]);
    expect(computer?.pids_limit).toBe(1024);
  });

  test("an init reaps what a closed browser leaves, so the pid ceiling is not slowly filled", () => {
    // Measured 2026-09-13: with `bun` as PID 1, closing five browsers left ten zombie Chromiums.
    expect(computer?.init).toBe(true);
  });

  test("a volume the root-run image left behind is handed to pwuser, by that command alone", () => {
    // Root for this hook only; the container itself stays pwuser (the test above).
    expect(computer?.post_start).toEqual([
      {
        command: [
          "chown",
          "-R",
          "--from=root",
          "pwuser:pwuser",
          "/profiles",
          "/workspace",
        ],
        user: "root",
      },
    ]);
  });

  test("the seccomp profile is a default-deny profile that permits the user-namespace syscalls", () => {
    const profile = JSON.parse(read("agent-computer/seccomp_profile.json")) as {
      defaultAction: string;
      syscalls: { names: string[]; action: string }[];
    };
    // Default-deny, like Docker's own, so what it ADDS is the whole point.
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    const allowed = new Set(
      profile.syscalls
        .filter((rule) => rule.action === "SCMP_ACT_ALLOW")
        .flatMap((rule) => rule.names),
    );
    for (const syscall of ["clone", "unshare", "setns"]) {
      expect([syscall, allowed.has(syscall)]).toEqual([syscall, true]);
    }
  });

  test("the deploy bundle carries the profile at the path compose names", () => {
    // Docker reads `security_opt` on the host, so the file cannot live only inside the image: a VM
    // whose bundle lacked it could not start the computer at all.
    expect(read("deploy/Dockerfile")).toContain(
      "COPY agent-computer/seccomp_profile.json /deploy/agent-computer/",
    );
  });
});
