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
  listeningLineFrom,
  megabytesHeld,
  PROBE_COMPOSE_FILE,
  PROBE_RESULT,
  probeOverride,
  probeResultFrom,
} from "../scripts/workbench-probe";

test("the rehearsal's compose file adds one container on the workbench's socket and touches no service of the deployment", () => {
  const override = parseYaml(
    probeOverride({
      serverImage: "ghcr.io/laf-labs/openbot-server:e2e-abc",
      probePath: "/home/runner/work/openbot/scripts/workbench-probe.ts",
    }),
  ) as { services: Record<string, Record<string, unknown>>; volumes?: unknown };
  // One service, and not one the deployment has: nothing that was rehearsed is recreated by it.
  expect(Object.keys(override.services)).toEqual(["workbench-probe"]);
  const deployment = parseYaml(
    readFileSync(join(import.meta.dir, "..", "docker-compose.yml"), "utf8"),
  ) as { services: Record<string, unknown>; volumes: Record<string, unknown> };
  expect(Object.keys(deployment.services)).not.toContain("workbench-probe");
  const probe = override.services["workbench-probe"];
  expect(probe).toEqual({
    // The server's image, as root, as the server is: what will hold the client for real.
    image: "ghcr.io/laf-labs/openbot-server:e2e-abc",
    profiles: ["workbench"],
    pull_policy: "missing",
    network_mode: "none",
    restart: "no",
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
