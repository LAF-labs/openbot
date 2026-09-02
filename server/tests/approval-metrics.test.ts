import { describe, expect, test } from "bun:test";
import {
  isNight,
  MAX_METRIC_DAYS,
  metricDays,
  summariseApprovals,
} from "../src/notifications/approval-metrics";

/**
 * The arithmetic behind "야간 승인 해소 시간", with no database in it.
 *
 * Everything that can be wrong in this number is arithmetic: a percentile off by one, a night that
 * is an hour wide, an empty month reported as zero seconds. None of it needs a Postgres to be wrong
 * in front of, and all of it would be invisible in a green gate.
 */

/** 2026-09-03, 09:00 in Seoul — daytime, whichever way the VM's own clock is set. */
const MORNING = "2026-09-03T00:00:00.000Z";
/** The same day, 02:00 in Seoul. Night, and the case the whole KPI is about. */
const NIGHT = "2026-09-02T17:00:00.000Z";

const after = (at: string, seconds: number) =>
  new Date(new Date(at).getTime() + seconds * 1000).toISOString();

describe("what the approvals metric counts", () => {
  test("median and p90 over the answers, in seconds", () => {
    const metrics = summariseApprovals(
      [10, 20, 30, 40, 100].map((seconds) => ({
        requestedAt: MORNING,
        decidedAt: after(MORNING, seconds),
      })),
      { days: 30, timeZone: "Asia/Seoul" },
    );

    expect(metrics.count).toBe(5);
    expect(metrics.medianSeconds).toBe(30);
    // Nearest-rank: the slowest of five is the 90th percentile, not an interpolation between two.
    expect(metrics.p90Seconds).toBe(100);
    expect(metrics.unanswered).toBe(0);
  });

  test("a question nobody answered is counted, and is not a duration", () => {
    const metrics = summariseApprovals(
      [
        { requestedAt: MORNING, decidedAt: after(MORNING, 60) },
        { requestedAt: MORNING, decidedAt: null },
        { requestedAt: MORNING, decidedAt: null },
      ],
      { days: 30, timeZone: "Asia/Seoul" },
    );

    expect(metrics.count).toBe(3);
    expect(metrics.unanswered).toBe(2);
    // An unanswered question must never be averaged in as a fast one, and must never be dropped
    // from the count: "we were quick" and "nobody was asked" are the two ways to look good here.
    expect(metrics.medianSeconds).toBe(60);
  });

  test("an empty month is null, never zero", () => {
    const metrics = summariseApprovals([], {
      days: 30,
      timeZone: "Asia/Seoul",
    });

    expect(metrics.count).toBe(0);
    expect(metrics.medianSeconds).toBeNull();
    expect(metrics.p90Seconds).toBeNull();
    expect(metrics.nightMedianSeconds).toBeNull();
  });

  test("night is decided by when the question was ASKED, in the deployment's clock", () => {
    const metrics = summariseApprovals(
      [
        // Asked at two in the morning, answered at nine. Seven hours of night, which is the whole
        // thing this number exists to expose.
        { requestedAt: NIGHT, decidedAt: after(NIGHT, 7 * 3600) },
        { requestedAt: MORNING, decidedAt: after(MORNING, 30) },
      ],
      { days: 30, timeZone: "Asia/Seoul" },
    );

    expect(metrics.nightMedianSeconds).toBe(7 * 3600);
    // Nearest-rank here too, so every number this endpoint reports is a duration somebody actually
    // waited rather than an average of two of them. With an even count that is the lower of the
    // middle pair — the same convention as p90, which is the point.
    expect(metrics.medianSeconds).toBe(30);
  });

  test("the clock is the deployment's, not the machine's", () => {
    // 17:00 UTC is 02:00 in Seoul and 18:00 in Berlin: the same instant is night in one and not in
    // the other, which is why an offset baked in here would be wrong for everybody but one city.
    expect(isNight(new Date(NIGHT), "Asia/Seoul")).toBe(true);
    expect(isNight(new Date(NIGHT), "Europe/Berlin")).toBe(false);
    // Both ends of the window, and midnight — which `hour12: false` renders as 24 and would put
    // outside a window it is squarely inside.
    expect(isNight(new Date("2026-09-02T13:00:00.000Z"), "Asia/Seoul")).toBe(
      true,
    );
    expect(isNight(new Date("2026-09-02T15:00:00.000Z"), "Asia/Seoul")).toBe(
      true,
    );
    expect(isNight(new Date("2026-09-02T22:00:00.000Z"), "Asia/Seoul")).toBe(
      false,
    );
    // A zone nobody can resolve falls back to Seoul rather than throwing mid-request.
    expect(isNight(new Date(NIGHT), "Mars/Olympus")).toBe(true);
  });

  test("the window a caller may ask for", () => {
    expect(metricDays(undefined)).toBe(30);
    expect(metricDays("7")).toBe(7);
    expect(metricDays("0")).toBe(30);
    expect(metricDays("-5")).toBe(30);
    expect(metricDays("banana")).toBe(30);
    // A year, because that is how long the trail it reads is kept.
    expect(metricDays("100000")).toBe(MAX_METRIC_DAYS);
  });
});
