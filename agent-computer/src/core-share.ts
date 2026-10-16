/**
 * How much of a core this machine is actually getting, and how long a browser step may therefore take.
 *
 * ON A BURSTABLE VM A SLOW PAGE IS A THROTTLED CPU, NOT A BROKEN SITE. A burstable shape is given a
 * baseline share of a core and banks what it does not use; once the bank is spent it runs at the
 * baseline, and a heavy Korean page that opens in a few seconds while bursting takes 8–20 s there
 * (measured 2026-10-16 on an E4 at its 12.5 % baseline: 다음 19.5 s, 네이버 뉴스 13.8 s). The step
 * deadlines were set on machines that are never throttled — 15 s for a look or a read — so a pinned VM
 * turned those pages into failures, the Bot tried again, and the retry spent the CPU the page needed.
 *
 * The hypervisor says when it is holding the guest back: it is the `steal` column of `/proc/stat`,
 * time this guest had work and was not run. Measured the same day: 38–42 % steal while pinned at the
 * baseline, about 0–7 % while bursting, and none on an A1, which is not burstable. So the share is
 * what the guest ran out of what it wanted to run — busy / (busy + steal) — over the last half minute,
 * and every step deadline is stretched by its inverse, a little and never without bound
 * ({@link stepDeadline}). A machine that is not throttled has a share of 1 and nothing changes.
 *
 * Sampled on a timer rather than when a step starts: one read of `/proc/stat` is a delta of nothing,
 * and the steps that matter are the ones that arrive after the machine has been busy a while.
 */
import { readFileSync } from "node:fs";

/** What the machine ran and was refused, in the kernel's ticks since boot (every core summed). */
export type CpuTicks = {
  /** Time spent running anything: user, nice, system, irq and softirq. Guest time is inside user. */
  busy: number;
  /** Time the hypervisor held this guest back while it had work to do. */
  steal: number;
  /** Every column up to steal, idle and iowait included: the wall clock, in ticks. */
  total: number;
};

/** What `/health` says about the CPU. Numbers and a flag only; the surface owns any words. */
export type CoreShare = {
  /** busy / (busy + steal) over the window, two decimals. 1 where nothing was held back. */
  coreShare: number;
  /** steal as a percentage of the window's wall clock, one decimal. */
  stealPct: number;
  /** Whether the hypervisor is holding the machine at its baseline ({@link PINNED_STEAL_PCT}). */
  pinned: boolean;
};

/** A machine that is not being held back, which is what every non-burstable VM always is. */
export const UNTHROTTLED: CoreShare = {
  coreShare: 1,
  stealPct: 0,
  pinned: false,
};

/**
 * Steal above this is a machine running at its baseline. Measured 2026-10-16: 38–42 % pinned, 0–7 %
 * bursting; the line sits well clear of both.
 */
export const PINNED_STEAL_PCT = 20;

/**
 * Below this much work in the window, the share is not judged. An idle machine has neither busy nor
 * steal, and the ratio of two near-zero counts is noise — an idle burstable VM is also banking, so
 * the step that wakes it runs on burst.
 */
const MIN_WORK_FRACTION = 0.02;

/** How often `/proc/stat` is read. One read is a few microseconds. */
export const SAMPLE_EVERY_MS = 5_000;

/** The half minute the share is taken over: long enough to smooth one page, short enough to follow a bank running out. */
export const SHARE_WINDOW_MS = 30_000;

/**
 * The most a step deadline is stretched by, and the longest any stretched step may wait.
 *
 * Four is what a pinned machine needs at the steal measured (1 / 0.6 is under two) with room for
 * worse; the cap keeps a thirty-second navigation from becoming two minutes. A deadline already set
 * longer than the cap by its environment is left as it was, never shortened.
 *
 * THE SERVER STILL ENDS A CALL AT 45 s (`server/src/computer/client.ts`). A step stretched past that
 * is cut there as `laf:computer_timed_out` before this process answers; `/navigate`, a navigation
 * and then a read, already reaches it unstretched (30 + 15). Until the server stretches its own
 * deadline by the same share — `/health` carries it — the stretch helps the steps that land under it.
 */
export const MAX_STRETCH = 4;
export const STEP_DEADLINE_CAP_MS = 60_000;

/** The aggregate `cpu` line of `/proc/stat`, or null where it cannot be read. */
export function ticksOf(procStat: string): CpuTicks | null {
  const line = procStat.split("\n").find((row) => row.startsWith("cpu "));
  if (!line) return null;
  const columns = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal — steal arrived in Linux 2.6.11; without it
  // there is nothing to judge, and the machine is read as not throttled.
  if (columns.length < 8 || columns.some((n) => !Number.isFinite(n))) {
    return null;
  }
  // Checked above: eight finite columns, so none of these defaults is ever taken.
  const [
    user = 0,
    nice = 0,
    system = 0,
    idle = 0,
    iowait = 0,
    irq = 0,
    softirq = 0,
    steal = 0,
  ] = columns;
  const busy = user + nice + system + irq + softirq;
  return { busy, steal, total: busy + idle + iowait + steal };
}

/** The share between two readings of the counters. */
export function shareBetween(from: CpuTicks, to: CpuTicks): CoreShare {
  const busy = to.busy - from.busy;
  const steal = to.steal - from.steal;
  const total = to.total - from.total;
  // A counter that went backwards is a different boot or a broken read, not a measurement.
  if (total <= 0 || busy < 0 || steal < 0) return UNTHROTTLED;
  const stealPct = Math.round((steal / total) * 1000) / 10;
  const worked = busy + steal;
  const coreShare =
    worked < total * MIN_WORK_FRACTION
      ? 1
      : Math.round((busy / worked) * 100) / 100;
  return { coreShare, stealPct, pinned: stealPct >= PINNED_STEAL_PCT };
}

/** How much longer a step may take on a machine getting this share: 1 to {@link MAX_STRETCH}. */
export function stretchOf(share: CoreShare | null): number {
  if (!share || share.coreShare >= 1) return 1;
  if (share.coreShare <= 0) return MAX_STRETCH;
  return Math.min(Math.max(1 / share.coreShare, 1), MAX_STRETCH);
}

function readProcStat(): string | null {
  try {
    return readFileSync("/proc/stat", "utf8");
  } catch {
    // Not Linux — a laptop running this process from source. Nothing is throttled that we can see.
    return null;
  }
}

export type CoreShareSampler = ReturnType<typeof createCoreShareSampler>;

export function createCoreShareSampler(
  options: {
    read?: () => string | null;
    now?: () => number;
    windowMs?: number;
  } = {},
) {
  const read = options.read ?? readProcStat;
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? SHARE_WINDOW_MS;
  /** Oldest first. The first is the last reading at or before the window's start: the baseline. */
  const samples: { at: number; ticks: CpuTicks }[] = [];
  let readable: boolean | null = null;

  const sample = (): void => {
    const text = read();
    const ticks = text === null ? null : ticksOf(text);
    readable = ticks !== null;
    if (!ticks) return;
    const at = now();
    samples.push({ at, ticks });
    while (samples.length > 2 && (samples[1]?.at ?? at) <= at - windowMs) {
      samples.shift();
    }
  };

  return {
    sample,

    /**
     * The share over the window, {@link UNTHROTTLED} until there are two readings, and null where
     * `/proc/stat` cannot be read at all — said as null rather than as a 1 the machine did not
     * measure.
     */
    current(): CoreShare | null {
      if (readable === false) return null;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (!first || !last || first === last) {
        return readable === null ? null : UNTHROTTLED;
      }
      return shareBetween(first.ticks, last.ticks);
    },

    /** Reads now and every `everyMs`; returns the stop. Unref'd, so it never keeps the process up. */
    start(everyMs = SAMPLE_EVERY_MS): () => void {
      sample();
      const timer = setInterval(sample, everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/**
 * This process's machine. Started in `index.ts`; a module value rather than a field of `Computer`
 * because the deadlines it stretches are read deep inside a look and a read, which are handed a page
 * and not the computer — and because it is a fact about the machine, which every browser shares.
 * Until it is started it has no reading, and every deadline is its own.
 */
export const machineCoreShare = createCoreShareSampler();

/**
 * A step's deadline on this machine now: `baseMs` stretched by {@link stretchOf}, never past
 * {@link STEP_DEADLINE_CAP_MS}, and never shorter than `baseMs`.
 */
export function stepDeadline(
  baseMs: number,
  share: CoreShare | null = machineCoreShare.current(),
): number {
  const stretch = stretchOf(share);
  if (stretch === 1) return baseMs;
  return Math.max(
    baseMs,
    Math.min(Math.round(baseMs * stretch), STEP_DEADLINE_CAP_MS),
  );
}
