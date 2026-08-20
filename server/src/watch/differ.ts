/**
 * The pure half of the watcher: what a signal list is, and what counts as news.
 *
 * No I/O and no clock in here, so every rule about noise lives where a test can
 * pin it. The poller decides *when* to look; this file decides *whether anything
 * happened*.
 */

export const SIGNAL_STATUSES = ["ok", "warn", "fail"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export type WatchSignal = {
  key: string;
  status: SignalStatus;
  value?: number | string;
  since?: string;
  detail?: string;
};

/** A transition worth recording. `prevStatus` null = appeared; `nextStatus` null = disappeared. */
export type SignalChange = {
  key: string;
  prevStatus: SignalStatus | null;
  nextStatus: SignalStatus | null;
  detail?: string;
};

/**
 * Caps, so a misbehaving source cannot decide how much we store or read.
 * Sixty-four signals is generous for "the things that must not silently stop";
 * a source past it is telemetry, not a watch list, and gets truncated visibly
 * at the poller layer.
 */
export const MAX_SIGNALS = 64;
export const MAX_TEXT = 500;

function isStatus(value: unknown): value is SignalStatus {
  return (SIGNAL_STATUSES as readonly string[]).includes(value as string);
}

/**
 * Whatever a source answered, reduced to the contract — invalid entries dropped,
 * text clamped, keys deduplicated (first wins), order fixed by key so equality
 * is comparable across polls.
 */
export function normalizeSignals(raw: unknown): WatchSignal[] {
  const list = Array.isArray((raw as { signals?: unknown[] })?.signals)
    ? ((raw as { signals: unknown[] }).signals as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  const seen = new Set<string>();
  const out: WatchSignal[] = [];
  for (const entry of list) {
    if (out.length >= MAX_SIGNALS) {
      break;
    }
    const candidate = entry as Record<string, unknown>;
    const key = typeof candidate?.key === "string" ? candidate.key.trim() : "";
    if (!key || key.length > MAX_TEXT || seen.has(key)) {
      continue;
    }
    if (!isStatus(candidate.status)) {
      continue;
    }
    seen.add(key);
    const signal: WatchSignal = { key, status: candidate.status };
    if (
      typeof candidate.value === "number" ||
      typeof candidate.value === "string"
    ) {
      signal.value =
        typeof candidate.value === "string"
          ? candidate.value.slice(0, MAX_TEXT)
          : candidate.value;
    }
    if (typeof candidate.since === "string") {
      signal.since = candidate.since.slice(0, MAX_TEXT);
    }
    if (typeof candidate.detail === "string") {
      signal.detail = candidate.detail.slice(0, MAX_TEXT);
    }
    out.push(signal);
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * What changed between two polls.
 *
 * Only three things are news: a signal appeared, disappeared, or changed status.
 * A value moving inside the same status is deliberately not a change — a queue
 * going 47→52 while `warn` is a chart, not an alarm, and a watcher that wakes a
 * bot on every wobble is a watcher somebody turns off.
 */
export function diffSignals(
  prev: WatchSignal[],
  next: WatchSignal[],
): SignalChange[] {
  const changes: SignalChange[] = [];
  const prevByKey = new Map(prev.map((signal) => [signal.key, signal]));
  const nextByKey = new Map(next.map((signal) => [signal.key, signal]));
  for (const signal of next) {
    const before = prevByKey.get(signal.key);
    if (!before) {
      changes.push({
        key: signal.key,
        prevStatus: null,
        nextStatus: signal.status,
        ...(signal.detail ? { detail: signal.detail } : {}),
      });
    } else if (before.status !== signal.status) {
      changes.push({
        key: signal.key,
        prevStatus: before.status,
        nextStatus: signal.status,
        ...(signal.detail ? { detail: signal.detail } : {}),
      });
    }
  }
  for (const signal of prev) {
    if (!nextByKey.has(signal.key)) {
      changes.push({
        key: signal.key,
        prevStatus: signal.status,
        nextStatus: null,
      });
    }
  }
  return changes;
}

/** One line per change, short enough for a chat message and a lock screen. */
export function describeChanges(changes: SignalChange[]): string {
  return changes
    .map((change) => {
      const arrow = `${change.prevStatus ?? "(new)"} → ${change.nextStatus ?? "(gone)"}`;
      return change.detail
        ? `- ${change.key}: ${arrow} — ${change.detail}`
        : `- ${change.key}: ${arrow}`;
    })
    .join("\n");
}
