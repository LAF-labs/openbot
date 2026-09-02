import { Hono } from "hono";

/**
 * `/health`, which used to be `context.json({ status: "ok" })` and nothing else.
 *
 * A constant is not a health check. It answered "ok" with the database refusing connections, with
 * `agent-bot` gone, and with the Bot's computer not running — and two things read it and believed
 * it: docker compose's healthcheck for the API container, and the fleet monitor that says whether
 * somebody's VM is alive. A deployment could be dead in every way that matters to the person using
 * it while every dial on it read green.
 *
 * So it asks. Three dependencies, each with a short bound, and 503 when one of them is down so that
 * a poller which only reads the status code still learns the truth.
 *
 * FACTS, NOT PROSE. The body carries names and states. It is read by machines and, when a person
 * reads it, they are an operator looking at a terminal — the sentence explaining what a degraded
 * computer means to somebody's morning belongs on the surface, in Korean, not here.
 */

/** Resolves true when the dependency answered, false when it did not. Throwing counts as false. */
export type HealthProbe = () => Promise<boolean>;

export type HealthProbes = {
  database?: HealthProbe;
  agentBot?: HealthProbe;
  computer?: HealthProbe;
};

export type HealthRouteOptions = {
  /**
   * How long one probe may take before it counts as down.
   *
   * Short on purpose. This endpoint answers the question "is this deployment serving", and a probe
   * that takes ten seconds has answered no whatever it eventually returns.
   */
  timeoutMs?: number;
  /**
   * How long one answer is reused.
   *
   * Compose polls every ten seconds for the API container alone, and the fleet monitor polls from
   * outside. Without this, every poll opens a database round trip and two HTTP requests, and a
   * deployment under load spends its health budget on being asked about its health.
   */
  cacheMs?: number;
  /** Injected by the tests so cache expiry is a fact rather than a wait. */
  now?: () => number;
};

export type HealthReport = {
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "down">;
};

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_MS = 5_000;

/**
 * One probe, bounded.
 *
 * `Promise.race` rather than an abort: the probes are somebody else's promises (a driver's query, a
 * client that owns its own timeout) and this cannot cancel them. What it can do is stop waiting,
 * which is what the caller asked for. A probe that rejects after the race has been decided is
 * still handled by the race, so a slow failure cannot become an unhandled rejection.
 */
async function settle(probe: HealthProbe, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answered = await Promise.race([
      probe(),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return answered ? "ok" : "down";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The route, mounted by `createApp` at `/health`.
 *
 * A probe that is absent is not reported and cannot degrade the deployment: a VM with no computer
 * configured is not a broken VM, and drawing a check for a thing this deployment does not have is
 * the same lie in the other direction.
 */
export function createHealthRoute(
  probes: HealthProbes = {},
  options: HealthRouteOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = options.now ?? Date.now;

  let cached: { at: number; report: HealthReport } | undefined;
  /*
   * Held so that ten pollers arriving together produce one round of probes rather than ten. The
   * cache alone does not do this: it is only written once the probes have finished, and everything
   * that arrives while they are running would otherwise start its own round.
   */
  let inFlight: Promise<HealthReport> | undefined;

  async function probe(): Promise<HealthReport> {
    const named = Object.entries(probes).filter(
      (entry): entry is [string, HealthProbe] => typeof entry[1] === "function",
    );
    const results = await Promise.all(
      named.map(
        async ([name, run]) => [name, await settle(run, timeoutMs)] as const,
      ),
    );
    const checks = Object.fromEntries(results) as HealthReport["checks"];
    return {
      status: results.every(([, state]) => state === "ok") ? "ok" : "degraded",
      checks,
    };
  }

  async function report(): Promise<HealthReport> {
    const fresh = cached && now() - cached.at < cacheMs;
    if (cached && fresh) return cached.report;
    if (inFlight) return inFlight;

    inFlight = probe()
      .then((result) => {
        cached = { at: now(), report: result };
        return result;
      })
      .finally(() => {
        inFlight = undefined;
      });

    return inFlight;
  }

  return new Hono().get("/", async (context) => {
    const current = await report();
    // 503 rather than a 200 carrying bad news: compose's healthcheck and the fleet monitor both
    // read the status code, and one of them reads nothing else.
    return context.json(current, current.status === "ok" ? 200 : 503);
  });
}
