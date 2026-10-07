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
      { ...base, opaqueFrames: 2 },
      {
        ...base,
        signedInSince: "2026-09-01T00:00:00.000Z",
        lastSeenAt: "2026-09-13T00:00:00.000Z",
      },
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

  /*
   * A SCRIPT'S RUN. The table draws which script by its digest, the files it was handed, how it
   * ended and what it made — so two runs that differ in any of those are two rows, and a Bot
   * running one script five times with five different endings is not "one row, five times".
   */
  test("two runs of a script are one row only when the script, its files, its ending and what it made are the same", () => {
    const ran = {
      action: "mcp__workbench__run_script",
      bot: "bot-1",
      script: { sha256: "a".repeat(64), bytes: 120 },
      ending: "exited",
      exit: 0,
      signal: null,
      ms: 400,
      stdoutBytes: 16,
      stderrBytes: 0,
      products: [{ name: "out.csv", bytes: 9 }],
      skipped: 0,
    };
    const changes: Record<string, unknown>[] = [
      { ...ran, script: { sha256: "b".repeat(64), bytes: 120 } },
      { ...ran, ending: "timed_out", exit: null },
      { ...ran, ending: "out_of_memory", exit: null },
      { ...ran, exit: 1 },
      { ...ran, ms: 401 },
      { ...ran, stdoutBytes: 17 },
      { ...ran, stderrBytes: 1 },
      { ...ran, products: [{ name: "other.csv", bytes: 9 }] },
      { ...ran, products: [{ name: "out.csv", bytes: 10 }] },
      { ...ran, products: [], productsRefused: "too_many" },
      // Withheld for another reason: two endings that differ only in WHY nothing came back.
      { ...ran, products: [], productsRefused: "too_large" },
      // None of its files tried, for one reason that settles all of them.
      { ...ran, unfiled: "laf:made_not_a_folder" },
    ];
    const signature = (payload: Record<string, unknown>) =>
      signatureOf(
        event(noonOn("2026-10-07"), "computer.script_finished", payload),
      );
    const signatures = new Set([ran, ...changes].map(signature));
    expect(signatures.size).toBe(changes.length + 1);
    expect(signature({ ...ran })).toBe(signature(ran));

    // And the decision's row, which names the files: the same script over other files is another.
    const decided = (files: string[]) =>
      signatureOf(
        event(noonOn("2026-10-07"), "computer.action_allowed", {
          action: "mcp__workbench__run_script",
          bot: "bot-1",
          script: ran.script,
          files,
          decision: { allowed: true, rule: "true" },
        }),
      );
    expect(decided(["uploads/a.csv"])).not.toBe(decided(["uploads/b.csv"]));
    expect(decided(["uploads/a.csv"])).toBe(decided(["uploads/a.csv"]));

    // And a file read for a run names the run: one file read for two scripts is two rows, and
    // neither is the row of a Bot reading that file for itself.
    const read = (forScript?: string) =>
      signatureOf(
        event(noonOn("2026-10-07"), "computer.action_allowed", {
          action: "computer_read_file",
          bot: "bot-1",
          file: "uploads/a.csv",
          ...(forScript ? { forScript } : {}),
          decision: { allowed: true, rule: "true" },
        }),
      );
    expect(
      new Set([read(), read("a".repeat(64)), read("b".repeat(64))]).size,
    ).toBe(3);
    expect(read("a".repeat(64))).toBe(read("a".repeat(64)));

    // And the row that names the files nobody got to: which files, and why, are what it is.
    const left = (because: string, names: string[]) =>
      signatureOf(
        event(noonOn("2026-10-07"), "computer.script_files_left", {
          action: "mcp__workbench__run_script",
          bot: "bot-1",
          script: ran.script,
          because,
          left: names.map((name) => ({ name, bytes: 1 })),
        }),
      );
    expect(
      new Set([
        left("laf:stopped", ["a.csv"]),
        left("laf:awaiting_approval", ["a.csv"]),
        left("laf:stopped", ["b.csv"]),
        left("laf:stopped", ["a.csv", "b.csv"]),
      ]).size,
    ).toBe(4);
    expect(left("laf:stopped", ["a.csv"])).toBe(left("laf:stopped", ["a.csv"]));
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
