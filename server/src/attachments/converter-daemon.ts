/**
 * The converter's daemon: the sidecar the API server hands every uploaded file to, over a unix socket.
 *
 * It parses nothing itself. Each file goes to a fresh child (`converter-process.ts`) and the daemon
 * relays the child's answer, checked, to the server. Two children at a time and a short queue behind
 * them: one person uploads a handful of files at once, and anything past that is load this machine
 * should refuse rather than queue until the chip spinning in front of them gives up.
 *
 * HTTP over a unix socket, with Bun's own server and fetch (`unix:` on both), so the protocol is one
 * everybody can read and nothing here is a framing of its own. The socket lives on a volume shared
 * with the server and nothing else; the service has no network at all.
 *
 * `--require-isolation` makes the daemon check, before it listens, that it is where compose was
 * meant to put it: not root, no network interface but loopback, no capability left to gain, no new
 * privileges, a read-only root. A deployment where one of those quietly stopped being true — a
 * compose file edited by hand, a runtime that ignores a key — refuses to start and says which,
 * rather than reading hostile files with the protection only on paper.
 */
import { readFileSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { ATTACHMENT_MAX_BYTES } from "../../../shared/attachments";
import { createLogger, type Logger, reportCrashes } from "../../../shared/log";
import { FILE_NAME_HEADER } from "./conversion";
import {
  CONVERSION_LIMITS,
  type ConversionLimits,
  type ConversionOutcome,
  convertInFreshProcess,
} from "./converter-process";

/** Files read at once, and files waiting behind them. */
const RUNNING = 2;
const WAITING = 8;

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
    try {
      const root = readFileSync("/proc/self/mounts", "utf8")
        .split("\n")
        .map((line) => line.split(" "))
        .filter((fields) => fields[1] === "/")
        .at(-1);
      return root ? (root[3] ?? "").split(",").includes("ro") : null;
    } catch {
      return null;
    }
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

/** A counting gate: `RUNNING` through, `WAITING` behind, the rest refused. */
function createGate(running: number, waiting: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    async enter(): Promise<boolean> {
      if (active < running) {
        active += 1;
        return true;
      }
      if (queue.length >= waiting) return false;
      await new Promise<void>((resolve) => queue.push(resolve));
      return true;
    },
    leave() {
      const next = queue.shift();
      if (next) next();
      else active -= 1;
    },
  };
}

export type ConverterDaemon = { stop(): Promise<void> };

/** A refusal as every route here answers one: a code, twice, and no sentence. */
const refusal = (code: string, status: number) =>
  Response.json({ error: code, code }, { status });

/** Listen on `socketPath` and read what arrives. Returned so a test can stop it. */
export function startConverterDaemon(options: {
  socketPath: string;
  jobCommand: readonly string[];
  limits?: ConversionLimits;
  log?: Logger;
}): ConverterDaemon {
  const log = options.log ?? createLogger("converter");
  const gate = createGate(RUNNING, WAITING);
  // A socket left by a daemon that was killed refuses the bind; nothing else lives at this path.
  rmSync(options.socketPath, { force: true });

  const server = Bun.serve({
    unix: options.socketPath,
    // The largest file accepted, and room for nothing else: the body is the file.
    maxRequestBodySize: ATTACHMENT_MAX_BYTES,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json({
          status: "ok",
          running: gate.active,
          queued: gate.queued,
        });
      }
      if (url.pathname !== "/convert" || request.method !== "POST") {
        return refusal("laf:converter_route_unknown", 404);
      }
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > ATTACHMENT_MAX_BYTES) {
        return refusal("laf:attachment_too_large", 413);
      }
      const name = (() => {
        try {
          return decodeURIComponent(
            request.headers.get(FILE_NAME_HEADER) ?? "",
          );
        } catch {
          return "";
        }
      })();
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
        return refusal("laf:attachment_too_large", 413);
      }
      if (!(await gate.enter())) {
        log.warn("converter_busy", { running: gate.active });
        return refusal("laf:converter_busy", 503);
      }
      const started = performance.now();
      let outcome: ConversionOutcome;
      try {
        outcome = await convertInFreshProcess(
          { name, bytes },
          {
            command: options.jobCommand,
            ...(options.limits ? { limits: options.limits } : {}),
          },
        );
      } finally {
        gate.leave();
      }
      // Facts only: never the name, never a word of what the file said.
      log.info("converter_job", {
        bytes: bytes.byteLength,
        ms: Math.round(performance.now() - started),
        ...(outcome.ok
          ? { outcome: outcome.conversion.outcome }
          : { failure: outcome.failure }),
      });
      return Response.json(outcome);
    },
    error() {
      return refusal("laf:converter_failed", 500);
    },
  });

  return {
    async stop() {
      await server.stop(true);
      rmSync(options.socketPath, { force: true });
    },
  };
}

/** The service's life: check where it is, then listen until it is stopped. */
export async function runConverterDaemon(options: {
  socketPath: string | undefined;
  requireIsolation: boolean;
  jobCommand: readonly string[];
}): Promise<void> {
  const log = createLogger("converter");
  reportCrashes(log);
  if (!options.socketPath) {
    log.error("converter_refused", { reason: "no_socket" });
    process.exit(1);
  }
  if (options.requireIsolation) {
    const facts = readIsolationFacts();
    const problems = isolationProblems(facts);
    if (problems.length > 0) {
      // Restarting into the same place changes nothing, but the loop is what `docker compose ps`
      // shows, and the server refuses every file meanwhile rather than reading them unprotected.
      log.error("converter_not_isolated", { problems, uid: facts.uid });
      process.exit(1);
    }
  }
  startConverterDaemon({
    socketPath: options.socketPath,
    jobCommand: options.jobCommand,
    limits: CONVERSION_LIMITS,
    log,
  });
  log.info("converter_listening", {
    isolated: options.requireIsolation,
    timeoutMs: CONVERSION_LIMITS.timeoutMs,
    memoryBytes: CONVERSION_LIMITS.memoryBytes,
  });
}
