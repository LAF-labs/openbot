/**
 * The parts of the workbench's rehearsal that can be held to something without a container: the
 * compose file it writes, and how it reads what the containers printed.
 *
 * The rehearsal itself — the real service, on Linux, and scripts that try each wall — runs from
 * `scripts/upgrade-e2e.ts` and nowhere else (`scripts/workbench-probe.ts`). Importing that file
 * here starts none of it: its inner half runs only when the file is the program.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ACT_CHECKS,
  ACT_RESULT,
  ACT_ROWS,
  ACT_SCRIPTS,
  ACT_SENTINELS,
  listeningLineFrom,
  megabytesHeld,
  PROBE_CHECKS,
  PROBE_COMPOSE_FILE,
  PROBE_SCRIPTS,
  signalsIn,
  PROBE_RESULT,
  probeOverride,
  probeResultFrom,
} from "../scripts/workbench-probe";

test("the rehearsal's compose file adds two containers on the workbench's socket and touches no service of the deployment", () => {
  const override = parseYaml(
    probeOverride({
      serverImage: "ghcr.io/laf-labs/openbot-server:e2e-abc",
      probePath: "/home/runner/work/openbot/scripts/workbench-probe.ts",
      actProbePath: "/home/runner/work/openbot/scripts/workbench-act-probe.ts",
    }),
  ) as { services: Record<string, Record<string, unknown>>; volumes?: unknown };
  // Two services, and neither one the deployment has: nothing that was rehearsed is recreated.
  expect(Object.keys(override.services)).toEqual([
    "workbench-probe",
    "workbench-act-probe",
  ]);
  const deployment = parseYaml(
    readFileSync(join(import.meta.dir, "..", "docker-compose.yml"), "utf8"),
  ) as { services: Record<string, unknown>; volumes: Record<string, unknown> };
  expect(Object.keys(deployment.services)).not.toContain("workbench-probe");
  expect(Object.keys(deployment.services)).not.toContain("workbench-act-probe");
  // The act's container is the walls' in everything but what it runs: the same image, the same
  // key, the same volume, and no network — it reaches the socket and nothing else.
  expect(override.services["workbench-act-probe"]).toEqual({
    ...override.services["workbench-probe"],
    volumes: [
      "workbench-socket:/run/laf-workbench",
      // Both files: the act's probe reads the lines it prints and the scripts it sends off this one.
      "/home/runner/work/openbot/scripts/workbench-probe.ts:/app/scripts/workbench-probe.ts:ro",
      "/home/runner/work/openbot/scripts/workbench-act-probe.ts:/app/scripts/workbench-act-probe.ts:ro",
    ],
    command: [
      "bun",
      "--no-env-file",
      "/app/scripts/workbench-act-probe.ts",
      "/run/laf-workbench/workbench.sock",
    ],
  });
  const probe = override.services["workbench-probe"];
  expect(probe).toEqual({
    // The server's image, as root, as the server is: what will hold the client for real.
    image: "ghcr.io/laf-labs/openbot-server:e2e-abc",
    profiles: ["workbench"],
    pull_policy: "missing",
    network_mode: "none",
    restart: "no",
    // The deployment's key, read by compose from the environment the rehearsal runs it with — and
    // refused, not defaulted, should the rehearsal forget to set one.
    environment: {
      WORKBENCH_KEY: "${WORKBENCH_KEY:?the rehearsal sets it}",
    },
    volumes: [
      // The service's own volume, by the name the deployment gives it, where the server will find it.
      "workbench-socket:/run/laf-workbench",
      "/home/runner/work/openbot/scripts/workbench-probe.ts:/app/scripts/workbench-probe.ts:ro",
    ],
    command: [
      "bun",
      "--no-env-file",
      "/app/scripts/workbench-probe.ts",
      "/run/laf-workbench/workbench.sock",
    ],
  });
  // It declares no volume of its own: the one it mounts is the deployment's, tmpfs options and all.
  expect(override.volumes).toBeUndefined();
  expect(deployment.volumes).toHaveProperty("workbench-socket");
  expect(PROBE_COMPOSE_FILE).toBe("upgrade-e2e.workbench.yml");
});

test("the probe's result is its last line of that kind, whatever else the container printed", () => {
  const checks = [
    { name: "a script has no network", ok: true, detail: "{}" },
    { name: "a segment", ok: null, detail: "no ipcmk" },
    { name: "the sweep", ok: false, detail: "alive: [1, 9, 12]" },
  ];
  const printed = [
    '{"level":"warn","svc":"workbench-probe","event":"workbench_refused","status":503}',
    `${PROBE_RESULT}[]`,
    "",
    PROBE_RESULT + JSON.stringify(checks),
    "",
  ].join("\n");
  expect(probeResultFrom(printed)).toEqual(checks);
  // Nothing of the kind, or not what it should be: no result, which the rehearsal reports as one.
  expect(probeResultFrom("bun: command not found\n")).toBeNull();
  expect(probeResultFrom(`${PROBE_RESULT}{"checks":1}`)).toBeNull();
  expect(probeResultFrom(`${PROBE_RESULT}[{"name":"cut off`)).toBeNull();
  // A check that is not one is dropped, not believed.
  expect(
    probeResultFrom(
      PROBE_RESULT +
        JSON.stringify([
          { name: "kept", ok: true, detail: "d" },
          { name: "no detail", ok: true },
          { name: "ok is a word", ok: "yes", detail: "d" },
          "a string",
          null,
        ]),
    ),
  ).toEqual([{ name: "kept", ok: true, detail: "d" }]);
});

test("the daemon's own line says how its memory is kept, read through compose's prefix", () => {
  const logs = [
    'workbench-1  | {"level":"error","svc":"workbench","event":"workbench_not_isolated","problems":["memory_readable"]}',
    'workbench-1  | {"level":"info","at":"2026-10-06T10:51:41.2Z","svc":"workbench","event":"workbench_listening","undumpable":false,"ptraceScope":1,"timeoutMs":20000}',
    'workbench-1  | {"level":"info","svc":"workbench","event":"workbench_run","ending":"exited"}',
    'workbench-1  | {"level":"info","at":"2026-10-06T10:52:02.0Z","svc":"workbench","event":"workbench_listening","undumpable":true,"ptraceScope":null,"timeoutMs":20000}',
    'workbench-1  | {"level":"info","svc":"workbench","event":"workbench_listening","undumpable":tr',
  ].join("\n");
  // The newest whole one: a container that restarted says it again.
  expect(listeningLineFrom(logs)).toEqual({
    undumpable: true,
    ptraceScope: null,
  });
  expect(listeningLineFrom(logs.split("\n").slice(0, 2).join("\n"))).toEqual({
    undumpable: false,
    ptraceScope: 1,
  });
  // Not listening yet — or refusing to.
  expect(listeningLineFrom(logs.split("\n")[0] ?? "")).toBeNull();
  expect(listeningLineFrom("")).toBeNull();
});

test("what docker stats printed is read as megabytes, and a container that is not running as nothing held", () => {
  expect(megabytesHeld("17.36MiB / 768MiB")).toBeCloseTo(17.36);
  expect(megabytesHeld("  20.65MiB / 768MiB\n")).toBeCloseTo(20.65);
  expect(megabytesHeld("512KiB / 768MiB")).toBeCloseTo(0.5);
  expect(megabytesHeld("1.2GiB / 2GiB")).toBeCloseTo(1228.8);
  // A container between two lives prints this: not "under the ceiling" — not there.
  expect(megabytesHeld("0B / 0B")).toBeNull();
  expect(megabytesHeld("")).toBeNull();
  expect(megabytesHeld("-- / --")).toBeNull();
  expect(megabytesHeld("Error response from daemon")).toBeNull();
});

test("the rehearsal tries the workbench once, after everything it holds the upgrade to", () => {
  const driver = readFileSync(
    join(import.meta.dir, "..", "scripts/upgrade-e2e.ts"),
    "utf8",
  );
  expect(driver.match(/\brehearseWorkbench\(/g)).toHaveLength(1);
  // After the last check of the upgrade itself, so nothing the upgrade is judged by comes after a
  // service was started by hand.
  expect(driver.indexOf("rehearseWorkbench(")).toBeGreaterThan(
    driver.indexOf('"a chat turn streams through the front door"'),
  );
});

test("every script the probe sends at least parses: a typo there costs a run on Linux to find", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  expect(Object.keys(PROBE_SCRIPTS).length).toBeGreaterThanOrEqual(10);
  for (const [name, script] of Object.entries(PROBE_SCRIPTS)) {
    expect(() => transpiler.transformSync(script), name).not.toThrow();
    // The size a script may be: it rides as the argument of a tool call.
    expect(new TextEncoder().encode(script).length, name).toBeLessThan(
      16 * 1024,
    );
  }
  // None of them is ever run here: several would end, fill or signal whatever machine they ran on.
});

test("a signal mask reads as the names of the signals in it", () => {
  // Bit n-1 is signal n: 0x4002 is SIGINT (2) and SIGTERM (15).
  expect(signalsIn("0000000000004002")).toEqual(["SIGINT", "SIGTERM"]);
  expect(signalsIn("0000000000000000")).toEqual([]);
  expect(signalsIn("0000000000010000")).toEqual(["SIGCHLD"]);
  expect(signalsIn(null)).toEqual([]);
  expect(signalsIn("not a mask")).toEqual([]);
});

/*
 * THE ACT'S PROBE (`scripts/workbench-act-probe.ts`). It is not imported here: it imports the
 * gateway, and with it the server's own log. What can be held without a container is the half this
 * file shares with it — the scripts, the strings looked for, the lines read back — and that the
 * rehearsal drives it once and counts what it said.
 */
test("the act's probe is driven once, after the walls, and one that stopped early is not a pass", () => {
  const outer = readFileSync(
    join(import.meta.dir, "..", "scripts/workbench-probe.ts"),
    "utf8",
  );
  const inner = readFileSync(
    join(import.meta.dir, "..", "scripts/workbench-act-probe.ts"),
    "utf8",
  );
  expect(outer.match(/"workbench-act-probe",\n\s+\]\);/g)).toHaveLength(1);
  expect(outer.indexOf('"workbench-act-probe",\n    ]);')).toBeGreaterThan(
    outer.indexOf("the probe said all of what it tries"),
  );
  expect(outer).toContain("(act?.length ?? 0) === ACT_CHECKS");
  // Its floor is the number of things it reports on the way to its end, counted off its source.
  expect(inner.match(/^ {2}check\($/gm)).toHaveLength(ACT_CHECKS);
  expect(ACT_CHECKS).toBe(10);
  // Its first run is by the client alone, to learn where it is; it stops there if not the sandbox.
  expect(inner).toContain("if (!inSandbox) return;");
  expect(inner.indexOf("if (!inSandbox) return;")).toBeLessThan(
    inner.indexOf("gateway.runScript("),
  );
  // Read back by the first word of its own lines, and only the last of them.
  expect(
    probeResultFrom(
      `${PROBE_RESULT}[{"name":"walls","ok":true,"detail":""}]\n${ACT_ROWS}{"rows":[]}\n${ACT_RESULT}[{"name":"act","ok":true,"detail":"d"}]\n`,
      ACT_RESULT,
    ),
  ).toEqual([{ name: "act", ok: true, detail: "d" }]);
});

test("the act's scripts parse, and what one prints and writes is not also a line of it", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const [name, script] of Object.entries(ACT_SCRIPTS)) {
    expect(() => transpiler.transformSync(script), name).not.toThrow();
    expect(new TextEncoder().encode(script).length, name).toBeLessThan(
      16 * 1024,
    );
  }
  // The script's own sentinel is a line of it; the two it prints and writes are joined when it
  // runs, so finding either in a row would mean the row held output or a file — not the script.
  expect(ACT_SCRIPTS.total).toContain(ACT_SENTINELS.script);
  expect(ACT_SCRIPTS.total).not.toContain(ACT_SENTINELS.stdout);
  expect(ACT_SCRIPTS.total).not.toContain(ACT_SENTINELS.product);
  expect(ACT_SCRIPTS.total).not.toContain(ACT_SENTINELS.input);
  expect(new Set(Object.values(ACT_SENTINELS)).size).toBe(4);
});

test("the probe's floor is the number of things it tries, so one that stopped early is not a pass", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "scripts/workbench-probe.ts"),
    "utf8",
  );
  expect(PROBE_CHECKS).toBe(32);
  expect(source).toContain("(results?.length ?? 0) === PROBE_CHECKS");
  // A build that should have the service and does not is a failed check, not a finding.
  expect(source).toContain("if (tools.expected) {");
});
