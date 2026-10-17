import { describe, expect, test } from "bun:test";
import {
  CORE_SHARE_HEADER,
  STEP_DEADLINE_CAP_MS,
} from "../../shared/computer-deadlines";
import type { Computer } from "../src/computer";
import { health } from "../src/computer-routes";
import {
  type CoreShare,
  type CoreShareSampler,
  createCoreShareSampler,
  withCoreShare,
  shareBetween,
  stepDeadline,
  ticksOf,
} from "../src/core-share";

/**
 * THE STEP DEADLINES FOLLOW HOW MUCH OF A CORE THE HYPERVISOR GIVES THE MACHINE (core-share.ts).
 * Driven with a fake `/proc/stat` and a clock of the test's own: a sequence of readings five seconds
 * apart, each column growing by what that kind of machine was measured doing.
 */

/** One `/proc/stat`, in the kernel's layout: the aggregate line, then a core's, then the rest. */
function procStat(user: number, system: number, idle: number, steal: number) {
  return [
    `cpu  ${user} 0 ${system} ${idle} 0 0 0 ${steal} 0 0`,
    `cpu0 ${user} 0 ${system} ${idle} 0 0 0 ${steal} 0 0`,
    "intr 0",
    "ctxt 0",
  ].join("\n");
}

/** The number a step is stretched by, as a call carries it. */
const on = (share: CoreShare | null) => share?.coreShare ?? null;

type Step = { user: number; system: number; idle: number; steal: number };

/** A sampler fed `readings` steps of `step` each, five seconds apart, as `start` would. */
function fed(...phases: { step: Step; readings: number }[]) {
  let at = 0;
  const totals = { user: 1_000, system: 500, idle: 90_000, steal: 0 };
  const sampler = createCoreShareSampler({
    read: () => procStat(totals.user, totals.system, totals.idle, totals.steal),
    now: () => at,
  });
  sampler.sample();
  for (const { step, readings } of phases) {
    for (let index = 0; index < readings; index += 1) {
      at += 5_000;
      totals.user += step.user;
      totals.system += step.system;
      totals.idle += step.idle;
      totals.steal += step.steal;
      sampler.sample();
    }
  }
  return sampler;
}

// One vCPU at 100 ticks a second, a page loading: busy, never held back.
const A1_BUSY: Step = { user: 300, system: 100, idle: 100, steal: 0 };
// Two vCPUs pinned at the baseline, as measured on an E4: 40 % of the wall clock stolen.
const E4_PINNED: Step = { user: 450, system: 150, idle: 0, steal: 400 };
// Far worse than anything measured: 85 % stolen.
const STARVED: Step = { user: 100, system: 50, idle: 0, steal: 850 };
// The same E4 bursting: a little steal, mostly its own.
const E4_BURSTING: Step = { user: 450, system: 150, idle: 380, steal: 20 };

describe("reading /proc/stat", () => {
  test("the aggregate line's busy, steal and wall clock, not a core's", () => {
    const text = [
      "cpu  100 5 50 1000 20 3 2 40 7 0",
      "cpu0 1 1 1 1 1 1 1 1 0 0",
    ].join("\n");
    // Guest time (7) is already inside user, so it is not added again.
    expect(ticksOf(text)).toEqual({
      busy: 160,
      steal: 40,
      total: 1220,
    });
  });

  test("a file with no aggregate line, or one without a steal column, is not read", () => {
    expect(ticksOf("cpu0 1 2 3 4 5 6 7 8\n")).toBeNull();
    expect(ticksOf("cpu  1 2 3 4 5 6 7\n")).toBeNull();
    expect(ticksOf("cpu  1 2 3 4 5 6 7 8\n")).toEqual({
      busy: 1 + 2 + 3 + 6 + 7,
      steal: 8,
      total: 36,
    });
  });
});

describe("the share over the window", () => {
  test("an A1, which is never held back, has a whole core and every deadline its own", () => {
    const share = fed({ step: A1_BUSY, readings: 7 }).current();
    expect(share).toEqual({ coreShare: 1, stealPct: 0, pinned: false });
    expect(stepDeadline(15_000, on(share))).toBe(15_000);
    expect(stepDeadline(30_000, on(share))).toBe(30_000);
    expect(stepDeadline(10_000, on(share))).toBe(10_000);
    expect(stepDeadline(5_000, on(share))).toBe(5_000);
  });

  test("a pinned E4 gets 0.6 of what it asks for, and every step is given 1/0.6 as long", () => {
    const share = fed({ step: E4_PINNED, readings: 7 }).current();
    expect(share).toEqual({ coreShare: 0.6, stealPct: 40, pinned: true });
    // The snapshot's and the read's 15 s, the navigation's 30 s, an action's 10 s.
    expect(stepDeadline(15_000, on(share))).toBe(25_000);
    expect(stepDeadline(30_000, on(share))).toBe(50_000);
    expect(stepDeadline(10_000, on(share))).toBe(16_667);
  });

  test("a starved machine is stretched four times at most, and no step past the cap", () => {
    const share = fed({ step: STARVED, readings: 7 }).current();
    expect(share).toEqual({ coreShare: 0.15, stealPct: 85, pinned: true });
    expect(stepDeadline(10_000, on(share))).toBe(40_000);
    expect(stepDeadline(15_000, on(share))).toBe(STEP_DEADLINE_CAP_MS);
    expect(stepDeadline(30_000, on(share))).toBe(STEP_DEADLINE_CAP_MS);
    // A deadline the deployment already set past the cap is never shortened by it.
    expect(stepDeadline(90_000, on(share))).toBe(90_000);
  });

  test("only the last half minute counts: a machine that starts bursting is unstretched within it", () => {
    const sampler = fed(
      { step: E4_PINNED, readings: 12 },
      { step: E4_BURSTING, readings: 6 },
    );
    // Thirty seconds of bursting and the pinned minute before it has left the window.
    expect(sampler.current()).toEqual({
      coreShare: 0.97,
      stealPct: 2,
      pinned: false,
    });
    expect(stepDeadline(15_000, on(sampler.current()))).toBe(15_464);
    // Fifteen seconds into the burst, half the window is still the pinned minute's.
    const earlier = fed(
      { step: E4_PINNED, readings: 12 },
      { step: E4_BURSTING, readings: 3 },
    ).current();
    expect(earlier).toEqual({ coreShare: 0.74, stealPct: 21, pinned: true });
  });

  test("an idle machine is not judged on the few ticks it worked", () => {
    const idle: Step = { user: 2, system: 1, idle: 994, steal: 3 };
    const share = fed({ step: idle, readings: 7 }).current();
    expect(share).toEqual({ coreShare: 1, stealPct: 0.3, pinned: false });
    expect(stepDeadline(15_000, on(share))).toBe(15_000);
  });

  test("counters that went backwards are no measurement", () => {
    const later = { busy: 500, steal: 400, total: 1_000 };
    const earlier = { busy: 900, steal: 0, total: 2_000 };
    expect(shareBetween(earlier, later)).toEqual({
      coreShare: 1,
      stealPct: 0,
      pinned: false,
    });
    // And the same pair the right way round is one.
    expect(shareBetween({ busy: 0, steal: 0, total: 0 }, later)).toEqual({
      coreShare: 0.56,
      stealPct: 40,
      pinned: true,
    });
  });

  test("where /proc/stat cannot be read the share is null and nothing is stretched", () => {
    const sampler = createCoreShareSampler({ read: () => null, now: () => 0 });
    expect(sampler.current()).toBeNull();
    sampler.sample();
    expect(sampler.current()).toBeNull();
    expect(stepDeadline(15_000, on(sampler.current()))).toBe(15_000);
    // One reading is no delta yet: a whole core, not a null.
    expect(fed().current()).toEqual({
      coreShare: 1,
      stealPct: 0,
      pinned: false,
    });
  });
});

describe("/health", () => {
  // `health` reads only these two; the rest of a computer is not built for a status line.
  const computer = {
    profiles: { summary: () => [] },
    egress: { state: () => "guarded" },
  } as unknown as Computer;

  test("says how much of a core the machine is getting, in numbers", async () => {
    const body = await health(
      null,
      computer,
      fed({ step: E4_PINNED, readings: 7 }),
    ).json();
    expect(body).toEqual({
      status: "ok",
      browser: false,
      egress: "guarded",
      cpu: { coreShare: 0.6, stealPct: 40, pinned: true },
    });
  });

  test("and null, not a measured-looking 1, where it could not read the machine", async () => {
    const unreadable = createCoreShareSampler({ read: () => null });
    unreadable.sample();
    const body = await health(null, computer, unreadable).json();
    expect(body.cpu).toBeNull();
    expect(body.status).toBe("ok");
  });
});

describe("a call's share, in and out", () => {
  // Four times as long as asked for, at a quarter of a core.
  const QUARTER: Step = { user: 200, system: 50, idle: 0, steal: 750 };

  /** The deadline a 15 s step gets inside a call, read after the call has awaited something. */
  async function lookIn(sampler: CoreShareSampler, serverWaitsBy?: string) {
    let looked = 0;
    const handle = withCoreShare(async (_request: Request) => {
      await Bun.sleep(1);
      looked = stepDeadline(15_000);
      return Response.json({ ok: true });
    }, sampler);
    const response = await handle(
      new Request("http://computer/snapshot", {
        headers: serverWaitsBy ? { [CORE_SHARE_HEADER]: serverWaitsBy } : {},
      }),
    );
    return { looked, said: response.headers.get(CORE_SHARE_HEADER) };
  }

  test("a step stretches as far as the server said it waits, and the answer says what was measured", async () => {
    const pinned = fed({ step: E4_PINNED, readings: 7 });
    expect(await lookIn(pinned, "0.6")).toEqual({
      looked: 25_000,
      said: "0.6",
    });
    // Outside a call nothing is stretched, whatever the machine is doing.
    expect(stepDeadline(15_000)).toBe(15_000);
  });

  test("never further than the server waits: a server that said nothing is waited for as always", async () => {
    const pinned = fed({ step: E4_PINNED, readings: 7 });
    expect(await lookIn(pinned)).toEqual({ looked: 15_000, said: "0.6" });
    // The machine slowed to a quarter after the server last heard 0.6: stretched by 0.6, not 0.25.
    const quarter = fed({ step: QUARTER, readings: 7 });
    expect(await lookIn(quarter, "0.6")).toEqual({
      looked: 25_000,
      said: "0.25",
    });
    // And a stale 0.6 from the server on a machine that is not held back stretches nothing.
    const a1 = fed({ step: A1_BUSY, readings: 7 });
    expect(await lookIn(a1, "0.6")).toEqual({ looked: 15_000, said: "1" });
  });

  test("a machine that cannot be read stretches nothing and says nothing on its answers", async () => {
    const unreadable = createCoreShareSampler({ read: () => null });
    unreadable.sample();
    expect(await lookIn(unreadable, "0.6")).toEqual({
      looked: 15_000,
      said: null,
    });
  });
});
