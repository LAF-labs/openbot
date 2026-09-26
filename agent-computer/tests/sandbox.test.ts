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
  cap_add?: string[];
  cap_drop?: string[];
  user?: string;
  networks?: string[] | Record<string, unknown>;
  post_start?: { command?: string[]; user?: string; privileged?: boolean }[];
};

const compose = parseYaml(read("docker-compose.yml")) as {
  services: Record<string, ComputerService>;
  networks?: Record<
    string,
    { driver?: string; driver_opts?: Record<string, string> } | null
  >;
};
const computer = compose.services["agent-computer"];

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

  test("the image runs as pwuser from its first instruction, and owns both volume roots by it", () => {
    const dockerfile = read("agent-computer/Dockerfile");
    /*
     * No root entrypoint any more: the egress firewall that needed one is the host's since
     * 2026-09-26 (egress-guard.ts). The image's last USER is pwuser, and nothing installs iptables.
     */
    expect(dockerfile).toMatch(/^USER pwuser$/m);
    expect(dockerfile).not.toMatch(/^USER\s+root/m);
    expect(dockerfile).not.toContain("ENTRYPOINT");
    expect(dockerfile).not.toMatch(/iptables=/);
    expect(dockerfile).toContain("chown pwuser:pwuser /workspace /profiles");
    expect(() => read("agent-computer/egress-firewall.sh")).toThrow();
  });

  test("the container holds no capability, and sits alone on the bridge the host firewalls", () => {
    /*
     * Security package item 6 (2026-09-26): no NET_ADMIN — the rules are the host's, keyed on the
     * `laf-browser` bridge (laf-control core/host-firewall.ts) — and no default capability either.
     */
    expect(computer?.cap_add).toBeUndefined();
    expect(computer?.cap_drop).toEqual(["ALL"]);
    expect(computer?.networks).toEqual(["browser"]);
    expect(compose.networks?.browser?.driver_opts).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: compose's own interpolation, read as written.
      "com.docker.network.bridge.name": "${COMPUTER_BRIDGE:-laf-browser}",
    });
    // The server is the one other thing on that bridge, because it is the one thing that calls :4100.
    const server = compose.services.server as ComputerService;
    expect(Object.keys((server.networks ?? {}) as object).sort()).toEqual([
      "browser",
      "default",
    ]);
  });

  test("before a browser opens, the computer asks the network whether the host is refusing", () => {
    const guard = read("agent-computer/src/egress-guard.ts");
    expect(guard).toContain('host: "169.254.169.254"');
    expect(guard).toContain('EGRESS_UNGUARDED = "laf:egress_unguarded"');
    expect(read("agent-computer/src/index.ts")).toContain(
      "beforeBrowser: () => egress.ensureGuarded()",
    );
  });

  test("compose does not put the process back on root", () => {
    expect(computer).toBeDefined();
    expect(computer?.user).toBeUndefined();
  });

  test("compose hands the container Playwright's seccomp profile, no new privileges and a pid ceiling", () => {
    expect(computer?.security_opt).toEqual([
      "seccomp=./agent-computer/seccomp_profile.json",
      "no-new-privileges:true",
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
        // The container holds no capability, so root in this one exec needs it given back.
        privileged: true,
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

  test("chroot is allowed without a capability to gate it on, because the container holds none", () => {
    /*
     * Chromium's zygote chroots into /proc/self/fdinfo inside the user namespace it just made. A rule
     * gated on CAP_SYS_CHROOT is compiled in only when the CONTAINER holds that capability, and with
     * `cap_drop: [ALL]` it holds none — measured on the lima drill (2026-09-26, Docker 29.8.1): the
     * sandbox died with `Check failed: sys_chroot("/proc/self/fdinfo/") == 0` and every browser
     * failed to start, while the same image with Docker's default capabilities read naver.com. The
     * entrypoint this replaced dropped them inside the process, after the filter was built.
     */
    const profile = JSON.parse(read("agent-computer/seccomp_profile.json")) as {
      syscalls: {
        names: string[];
        action: string;
        includes?: { caps?: string[] };
      }[];
    };
    const chroot = profile.syscalls.filter(
      (rule) =>
        rule.names.includes("chroot") && rule.action === "SCMP_ACT_ALLOW",
    );
    expect(chroot.some((rule) => !rule.includes?.caps?.length)).toBe(true);
  });

  test("the deploy bundle carries the profile at the path compose names", () => {
    // Docker reads `security_opt` on the host, so the file cannot live only inside the image: a VM
    // whose bundle lacked it could not start the computer at all.
    expect(read("deploy/Dockerfile")).toContain(
      "COPY agent-computer/seccomp_profile.json /deploy/agent-computer/",
    );
  });
});
