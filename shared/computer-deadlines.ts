/**
 * How long a browser step, and the server's call around it, may take on a machine getting
 * `coreShare` of a core — the one rule both halves read, so they cannot disagree.
 *
 * The computer measures the share (`agent-computer/src/core-share.ts`) and stretches its step
 * deadlines by it; the server's client (`server/src/computer/client.ts`) gives up on a call after
 * its own deadline. Were the two stretched by different rules, the server would cut a step the
 * computer was still allowed to finish — `laf:computer_timed_out` for a page that was only slow,
 * which is the failure the stretch exists to remove.
 *
 * THE SHARE TRAVELS BOTH WAYS IN ONE HEADER, {@link CORE_SHARE_HEADER}. Every answer from the
 * computer carries the share it measured; the server keeps the last one and sends it back on its
 * next call as the share it is waiting by. The computer then stretches by the larger share of the
 * two — the smaller stretch — so it never takes longer than the server is waiting for, even when the
 * machine slowed down after the server last heard. On a header nobody sent, nothing is stretched.
 */

/** Both directions: the computer's measured share on an answer, the share the server waits by on a call. */
export const CORE_SHARE_HEADER = "x-laf-core-share";

/**
 * The most a step deadline is stretched by, and the longest any stretched step may wait.
 *
 * Four is what a pinned machine needs at the steal measured (1 / 0.6 is under two) with room for
 * worse; the cap keeps a thirty-second navigation from becoming two minutes. A deadline already set
 * longer than the cap is left as it was, never shortened.
 */
export const MAX_STRETCH = 4;
export const STEP_DEADLINE_CAP_MS = 60_000;

/**
 * The most stretched steps one call runs one after another: `/navigate` is a navigation and then a
 * read of what opened. Every other route is one step, or an action's wait and a read.
 */
const STEPS_PER_CALL = 2;

/**
 * What a stretched call is given beyond its stretched steps: the work around them that no step
 * deadline bounds — resolving the address, handing out the tab, the answer's tab list — which a
 * throttled machine does slowly too. Not added at a share of 1, where the deadline is what it was.
 */
export const CALL_MARGIN_MS = 15_000;

/** A share as a header says it: a number above 0 and at most 1, or nothing. */
export function shareFromHeader(
  value: string | null | undefined,
): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const share = Number(value);
  return Number.isFinite(share) && share > 0 && share <= 1 ? share : null;
}

/** How much longer a step may take on a machine getting this share: 1 to {@link MAX_STRETCH}. */
export function stretchOf(share: number | null): number {
  if (share === null || share >= 1) return 1;
  if (share <= 0) return MAX_STRETCH;
  return Math.min(1 / share, MAX_STRETCH);
}

/**
 * A step's deadline at this share: `baseMs` stretched by {@link stretchOf}, never past
 * {@link STEP_DEADLINE_CAP_MS}, and never shorter than `baseMs`.
 */
export function stepDeadline(baseMs: number, share: number | null): number {
  const stretch = stretchOf(share);
  if (stretch === 1) return baseMs;
  return Math.max(
    baseMs,
    Math.min(Math.round(baseMs * stretch), STEP_DEADLINE_CAP_MS),
  );
}

/**
 * The server's deadline for one call at this share.
 *
 * `baseMs` exactly at a share of 1 — 45 s, which is the computer's own `/navigate` unstretched, a
 * 30 s navigation and a 15 s read. Stretched, it is `baseMs` stretched the same way and held to the
 * most {@link STEPS_PER_CALL} capped steps can take, plus {@link CALL_MARGIN_MS}: so it is always
 * past the longest stretched call the computer may run at that share, and never more than 135 s.
 */
export function callDeadline(baseMs: number, share: number | null): number {
  const stretch = stretchOf(share);
  if (stretch === 1) return baseMs;
  return Math.max(
    baseMs,
    Math.min(
      Math.round(baseMs * stretch),
      STEPS_PER_CALL * STEP_DEADLINE_CAP_MS,
    ) + CALL_MARGIN_MS,
  );
}
