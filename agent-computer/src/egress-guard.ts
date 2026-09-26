/**
 * Whether the machine is holding the browser's egress firewall, asked of the network itself.
 *
 * THE FIREWALL LEFT THIS CONTAINER ON 2026-09-26. It used to be written by the entrypoint into the
 * container's own network namespace, which took root and `NET_ADMIN` (security review 2026-09-25
 * F1). Now the host writes it — the fleet tool installs it at provision and upgrade, keyed on the
 * `laf-browser` bridge this container is the only thing on — and this container holds no capability
 * that could take it down, or put it up. Which means this process can no longer know the rules are
 * there by having written them. So it asks: a machine whose host rules are missing (an old VM, a
 * reboot whose unit has not run yet, a hand deploy that skipped the step) must not quietly become a
 * browser that reaches 169.254.169.254 again.
 *
 * WHAT COUNTS AS GUARDED. The host rejects with ICMP "administratively prohibited": a refusal that
 * arrives as an ICMP destination-unreachable, inside {@link BLOCKED_WITHIN_MS}, from every target is
 * guarded; anything else is not. A connection is plainly unguarded. So is a timeout — a laptop with
 * no metadata service hangs rather than refuses (measured 2026-09-26 on Docker Desktop:
 * 169.254.169.254:80 timed out at 1.5 s). And so is a closed port's refusal, which reads like a
 * firewall and is not one: the same laptop refused its own gateway at 1 ms, because nothing listens
 * there. Only the rule's own signature proves the rule.
 *
 * WHERE THAT SIGNATURE IS READ. Linux hands the rule's answer to `connect()` as EHOSTUNREACH, and
 * Bun hands it to JavaScript as ECONNREFUSED — errno -111, from `node:net` and `Bun.connect` alike —
 * exactly what a closed port's RST becomes (measured 2026-09-26 on the lima drill, Bun 1.3.14,
 * Ubuntu 24.04, Docker 29.8.1, where busybox `nc` on the same bridge said "Host is unreachable").
 * So the error code cannot tell the two apart, and the kernel's own count can: each refusal by the
 * host rule is an ICMP destination-unreachable delivered to this network namespace, which
 * `/proc/net/snmp` counts (`InDestUnreachs`, readable with no capability), and an RST is not.
 * Measured on the same drill: rules on, every target refused in 0–8 ms with the count up by one
 * each; rules off, the metadata address (lima's NAT) and the gateway's :80 refused in 1–6 ms with
 * the count unmoved, the gateway's :22 connected, 10.255.255.1 timed out. The targets are asked one
 * at a time, so each count is that attempt's own.
 *
 * THE TARGETS, one per chain the host rules live in: the metadata endpoint (forwarded, the reason
 * this exists), an RFC 1918 address that is nobody's (forwarded, the private ranges), and this
 * network's gateway, which is the host itself (delivered locally — the host's INPUT chain, which a
 * rule in DOCKER-USER never sees). A deployment that opted into browsing its own network drops the
 * last two, exactly as the host drops those rules for it.
 *
 * FAIL CLOSED ON BROWSING, NOT ON HEALTH. An unguarded computer still answers `/health` (with
 * `egress: "unguarded"`) and still answers every call — with `laf:egress_unguarded` wherever a
 * browser would have been opened. A container that refused to start would leave the server saying
 * "unreachable", which is a different fact and not an actionable one.
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";

export type ProbeTarget = { host: string; port: number };

/**
 * What one attempt came back with.
 *
 * `blocked` is the host rule's own answer and the only one that counts. `refused` is a closed port —
 * reachable, just not listening — and `failed` is any other error, named by its `code`.
 */
export type ProbeOutcome =
  | "blocked"
  | "refused"
  | "connected"
  | "timeout"
  | "failed";

export type ProbeResult = {
  target: string;
  outcome: ProbeOutcome;
  ms: number;
  code?: string;
};

/**
 * - `guarded`: every target answered with the host rule's refusal.
 * - `unguarded`: at least one did not. Browsing is refused.
 * - `unchecked`: the first probe has not come back yet. Browsing waits for it.
 * - `off`: `AGENT_COMPUTER_EGRESS_FIREWALL=off`, the laptop's way past this. Logged at boot.
 */
export type EgressState = "guarded" | "unguarded" | "unchecked" | "off";

/** The cloud metadata endpoint, on AWS, OCI and GCP alike — port 80, never the resolver's 53. */
export const METADATA_TARGET: ProbeTarget = {
  host: "169.254.169.254",
  port: 80,
};

/** An RFC 1918 address no deployment uses, standing in for the private ranges. */
export const PRIVATE_TARGET: ProbeTarget = { host: "10.255.255.1", port: 80 };

/** Longer than any real refusal, short enough that a laptop's refusal costs one breath. */
export const PROBE_TIMEOUT_MS = 1500;

/**
 * How quickly the refusal has to come. The host answers from the same kernel in well under a
 * millisecond; an EHOSTUNREACH that took seconds is ARP giving up on an address, not a rule.
 */
export const BLOCKED_WITHIN_MS = 1000;

/**
 * How many ICMP destination-unreachable messages this network namespace has taken in, from the
 * text of `/proc/net/snmp` (`Icmp: … InDestUnreachs …`, a header line and a value line). Null when
 * the text does not say.
 */
export function destUnreachablesIn(snmp: string): number | null {
  const lines = snmp.split("\n");
  const header = lines.findIndex((line) => line.startsWith("Icmp: InMsgs"));
  if (header < 0) return null;
  const names = lines[header]?.trim().split(/\s+/) ?? [];
  const values = lines[header + 1]?.trim().split(/\s+/) ?? [];
  const at = names.indexOf("InDestUnreachs");
  const value = at < 0 ? Number.NaN : Number(values[at]);
  return Number.isSafeInteger(value) ? value : null;
}

const readDestUnreachables = (): number | null => {
  try {
    return destUnreachablesIn(readFileSync("/proc/net/snmp", "utf8"));
  } catch {
    return null;
  }
};

/** How long a guarded verdict is taken on trust before a browser is opened on it. */
export const GUARDED_FRESH_MS = 90_000;

/** How long an unguarded one is, before the next call asks the network again. */
export const UNGUARDED_FRESH_MS = 5_000;

/** How often the network is asked while nothing else asks. */
export const PROBE_EVERY_MS = 60_000;

export const EGRESS_UNGUARDED = "laf:egress_unguarded";

/** Thrown where a browser would have been opened, and answered as {@link EGRESS_UNGUARDED}. */
export class EgressUnguardedError extends Error {
  constructor() {
    super(EGRESS_UNGUARDED);
    this.name = "EgressUnguardedError";
  }
}

/**
 * One attempt, bounded, and whether an ICMP destination-unreachable arrived while it ran. Never run
 * two at once: the count is the namespace's, so it is only this attempt's while nothing else asks.
 */
export function probeTarget(
  target: ProbeTarget,
  timeoutMs = PROBE_TIMEOUT_MS,
  unreachables: () => number | null = readDestUnreachables,
): Promise<ProbeResult> {
  const started = performance.now();
  const label = `${target.host}:${target.port}`;
  const before = unreachables();
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    let settled = false;
    const settle = (outcome: ProbeOutcome, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({
        target: label,
        outcome,
        ms: Math.round(performance.now() - started),
        ...(code ? { code } : {}),
      });
    };
    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    socket.once("connect", () => settle("connected"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      const elapsed = performance.now() - started;
      const after = unreachables();
      const icmp = before === null || after === null ? null : after > before;
      settle(outcomeOfError(error.code, elapsed, icmp), error.code);
    });
  });
}

/**
 * The error a `connect()` failed with, as one of the outcomes.
 *
 * `icmp` is whether a destination-unreachable arrived during the attempt, or null where the count
 * could not be read. With it, a fast refusal under either name is the rule's; without it, only an
 * EHOSTUNREACH is — a runtime that names the errno faithfully — and an ECONNREFUSED stays a closed
 * port, so an unreadable count fails closed.
 */
export function outcomeOfError(
  code: string | undefined,
  elapsedMs: number,
  icmp: boolean | null = null,
): ProbeOutcome {
  const refusal = code === "EHOSTUNREACH" || code === "ECONNREFUSED";
  if (refusal && elapsedMs <= BLOCKED_WITHIN_MS) {
    if (icmp === true) return "blocked";
    if (icmp === null && code === "EHOSTUNREACH") return "blocked";
  }
  if (code === "ECONNREFUSED") return "refused";
  return "failed";
}

/**
 * The default gateway from `/proc/net/route`: the host, as this network sees it.
 *
 * The kernel writes addresses there as little-endian hex, `0100A8C0` for 192.168.0.1.
 */
export function defaultGateway(routeTable: string): string | null {
  for (const line of routeTable.split("\n").slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (
      destination !== "00000000" ||
      !gateway ||
      !/^[0-9A-F]{8}$/i.test(gateway)
    )
      continue;
    const address = [6, 4, 2, 0]
      .map((at) => Number.parseInt(gateway.slice(at, at + 2), 16))
      .join(".");
    return address === "0.0.0.0" ? null : address;
  }
  return null;
}

/** The targets this deployment's rules must refuse. See the file's header. */
export function targetsFor(input: {
  allowPrivateHosts: boolean;
  gateway: string | null;
}): ProbeTarget[] {
  if (input.allowPrivateHosts) return [METADATA_TARGET];
  return [
    METADATA_TARGET,
    PRIVATE_TARGET,
    ...(input.gateway ? [{ host: input.gateway, port: 80 }] : []),
  ];
}

/** Guarded only when every target answered with the rule's own refusal. */
export function verdictOf(
  results: readonly ProbeResult[],
): "guarded" | "unguarded" {
  return results.length > 0 &&
    results.every((result) => result.outcome === "blocked")
    ? "guarded"
    : "unguarded";
}

const readGateway = (): string | null => {
  try {
    return defaultGateway(readFileSync("/proc/net/route", "utf8"));
  } catch {
    return null;
  }
};

type Log = {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
};

export type EgressGuardOptions = {
  /** False is `AGENT_COMPUTER_EGRESS_FIREWALL=off`. */
  enforce: boolean;
  allowPrivateHosts: boolean;
  log: Log;
  /** Told when a guarded machine stops being one, so the open browser is closed under it. */
  onUnguarded?: () => Promise<void> | void;
  /** Injectable, so a test does not need a firewall. */
  probe?: (targets: ProbeTarget[]) => Promise<ProbeResult[]>;
  gateway?: () => string | null;
  now?: () => number;
};

export function createEgressGuard(options: EgressGuardOptions) {
  const now = options.now ?? (() => Date.now());
  // One target at a time: each attempt reads the namespace's ICMP count as its own (see the header).
  const probe =
    options.probe ??
    (async (targets: ProbeTarget[]) => {
      const results: ProbeResult[] = [];
      for (const target of targets) results.push(await probeTarget(target));
      return results;
    });
  const gatewayOf = options.gateway ?? readGateway;

  let state: EgressState = options.enforce ? "unchecked" : "off";
  let checkedAt = 0;
  let last: ProbeResult[] = [];
  let inFlight: Promise<EgressState> | null = null;

  const ask = async (): Promise<EgressState> => {
    const results = await probe(
      targetsFor({
        allowPrivateHosts: options.allowPrivateHosts,
        gateway: gatewayOf(),
      }),
    );
    last = results;
    checkedAt = now();
    const verdict = verdictOf(results);
    if (!options.enforce) return state;
    const was = state;
    state = verdict;
    if (verdict === "unguarded" && was !== "unguarded") {
      options.log.error("egress_unguarded", {
        results,
        note: "this machine's host rules are missing, so the browser will not be opened (docs/laf/deploying.md, the host firewall)",
      });
      if (was === "guarded") await options.onUnguarded?.();
    } else if (verdict === "guarded" && was !== "guarded") {
      options.log.info("egress_guarded", { results });
    }
    return state;
  };

  /** Ask the network now, sharing an answer already on its way. */
  const check = (): Promise<EgressState> => {
    inFlight ??= ask().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    /** What the last probe said, for `/health` and the boot line. */
    state: (): EgressState => state,

    /** The last probe's answers, target by target. */
    results: (): readonly ProbeResult[] => last,

    check,

    /**
     * Before a browser is opened or handed out: throws {@link EgressUnguardedError} unless the host
     * is holding the rules. A fresh guarded verdict costs nothing; anything else asks again, so the
     * minutes after a reboot, before the host's unit has run, heal on the first call after it has.
     */
    async ensureGuarded(): Promise<void> {
      if (!options.enforce) return;
      const age = now() - checkedAt;
      if (state === "guarded" && age < GUARDED_FRESH_MS) return;
      const current =
        state === "unguarded" && age < UNGUARDED_FRESH_MS
          ? state
          : await check();
      if (current !== "guarded") throw new EgressUnguardedError();
    },

    /** Asks at once and then every {@link PROBE_EVERY_MS}; returns the stop. */
    start(everyMs = PROBE_EVERY_MS): () => void {
      void check();
      if (!options.enforce) return () => undefined;
      const timer = setInterval(() => void check(), everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

export type EgressGuard = ReturnType<typeof createEgressGuard>;
