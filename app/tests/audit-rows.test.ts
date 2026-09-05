import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "../src/lib/audit/queries";
import { dayKeyOf, groupByDay, signatureOf } from "../src/lib/audit/rows";

/**
 * The trail's first screenful, and the one mistake collapsing it could make.
 *
 * Nine restarts over a deploy put eighteen identical boot rows at the top of a 365-day trail, so
 * whatever anybody opened the page for was below the fold. Folding them is easy; folding them
 * WITHOUT ever folding a refusal into the allows around it is the part worth a test, because that
 * failure would not look like a bug — it would look like a quiet afternoon.
 */

let sequence = 0;

function event(
  at: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): AuditEvent {
  sequence += 1;
  return {
    id: `row-${sequence}`,
    actorUserId: null,
    eventType,
    targetType: "computer",
    targetId: "default",
    payload,
    createdAt: at,
  };
}

/** Local noon, so a test cannot depend on the machine's offset to stay inside one day. */
function noonOn(day: string, minute = 0): string {
  return new Date(
    `${day}T12:${String(minute).padStart(2, "0")}:00`,
  ).toISOString();
}

describe("the day a row belongs to", () => {
  test("is the reader's day, not the server's", () => {
    // The server writes UTC. Read in Seoul, an ISO string sliced at the T would file every row
    // before 09:00 KST under the previous date — on the one screen that exists for dates.
    const morning = new Date("2026-09-06T09:30:00");
    expect(dayKeyOf(morning.toISOString())).toBe("2026-09-06");
  });

  test("survives a value that is not a date rather than throwing", () => {
    expect(dayKeyOf("not a date")).toBe("not a date");
  });
});

describe("collapsing the trail", () => {
  test("nine identical boots become one row that says nine", () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      event(noonOn("2026-09-06", index), "computer.policy_loaded", {
        bot: "bot-1",
      }),
    );
    const days = groupByDay(rows);
    expect(days).toHaveLength(1);
    expect(days[0]?.runs).toHaveLength(1);
    expect(days[0]?.runs[0]?.count).toBe(9);
  });

  test("a collapsed row keeps both ends of the run", () => {
    const rows = [
      event(noonOn("2026-09-06", 30), "computer.policy_loaded"),
      event(noonOn("2026-09-06", 10), "computer.policy_loaded"),
    ];
    const [run] = groupByDay(rows)[0]?.runs ?? [];
    // Newest first, so the row is drawn from the newest and says when the oldest was.
    expect(run?.event.createdAt).toBe(noonOn("2026-09-06", 30));
    expect(run?.firstAt).toBe(noonOn("2026-09-06", 10));
  });

  test("a refusal is never folded into the allows around it", () => {
    const allowed = (at: number) =>
      event(noonOn("2026-09-06", at), "computer.action_allowed", {
        action: "computer_click",
        bot: "bot-1",
        decision: { allowed: true, rule: "true" },
      });
    const rows = [
      allowed(3),
      event(noonOn("2026-09-06", 2), "computer.action_refused", {
        action: "computer_click",
        bot: "bot-1",
        decision: { allowed: false, rule: 'contains(element.name, "결제")' },
      }),
      allowed(1),
    ];
    const runs = groupByDay(rows)[0]?.runs ?? [];
    expect(runs.map((run) => run.event.eventType)).toEqual([
      "computer.action_allowed",
      "computer.action_refused",
      "computer.action_allowed",
    ]);
    expect(runs.every((run) => run.count === 1)).toBe(true);
  });

  test("two Bots doing the same thing stay two rows", () => {
    const rows = ["bot-1", "bot-2"].map((bot, index) =>
      event(noonOn("2026-09-06", index), "computer.action_allowed", {
        action: "computer_click",
        bot,
      }),
    );
    expect(groupByDay(rows)[0]?.runs).toHaveLength(2);
  });

  test("two repeat rows saying different numbers stay two rows", () => {
    // The whole content of a repeat row is its count. Folding 5 and 25 into one row would delete the
    // only thing either of them says.
    const rows = [25, 5].map((count, index) =>
      event(noonOn("2026-09-06", index), "computer.action_repeated", {
        action: "computer_click",
        bot: "bot-1",
        fingerprint: "click e12",
        count,
      }),
    );
    expect(groupByDay(rows)[0]?.runs.map((run) => run.count)).toEqual([1, 1]);
  });

  test("a run never crosses midnight", () => {
    const rows = [
      event(noonOn("2026-09-06"), "computer.policy_loaded"),
      event(noonOn("2026-09-05"), "computer.policy_loaded"),
    ];
    const days = groupByDay(rows);
    expect(days.map((day) => day.key)).toEqual(["2026-09-06", "2026-09-05"]);
    expect(days.every((day) => day.runs.length === 1)).toBe(true);
  });

  test("an empty trail is an empty list, not a day with nothing in it", () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe("what counts as the same row", () => {
  test("two rows differing only in a field the table draws are different", () => {
    const base = { action: "computer_click", bot: "bot-1" };
    const changes: Record<string, unknown>[] = [
      { ...base, page: "https://example.com/a" },
      { ...base, element: { role: "button", name: "결제" } },
      { ...base, file: "notes/a.md" },
      { ...base, reason: "a rule refused it" },
      { ...base, failure: "the element was gone" },
      { ...base, decision: { allowed: true, rule: "true" } },
      { ...base, decision: { allowed: true, rule: "true", approvedBy: "kim" } },
      { ...base, silentForMs: 60_000, chunks: 0 },
    ];
    const signatures = new Set(
      changes.map((payload) =>
        signatureOf(
          event(noonOn("2026-09-06"), "computer.action_allowed", payload),
        ),
      ),
    );
    // Every one of them differs from the plain row and from each other.
    signatures.add(
      signatureOf(event(noonOn("2026-09-06"), "computer.action_allowed", base)),
    );
    expect(signatures.size).toBe(changes.length + 1);
  });

  test("the same row at a different time is the same row", () => {
    // Time is the one field a run is allowed to differ in; it is what the count stands for.
    const payload = { action: "computer_click", bot: "bot-1" };
    expect(
      signatureOf(
        event(noonOn("2026-09-06", 1), "computer.action_allowed", payload),
      ),
    ).toBe(
      signatureOf(
        event(noonOn("2026-09-06", 9), "computer.action_allowed", payload),
      ),
    );
  });
});
