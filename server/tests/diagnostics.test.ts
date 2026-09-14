import { describe, expect, test } from "bun:test";
import { logLine } from "../../shared/log";
import {
  assembleDiagnostics,
  createDiagnosticsShelf,
  DIAGNOSTIC_EVENTS_MAX,
  type DiagnosticBundle,
  eventFromLine,
  type LedgerRun,
  type Ownership,
  summariseDiagnostics,
} from "../src/support/diagnostics";

/**
 * WHAT "진단 정보 같이 보내기" CAN CARRY, READ OFF THE BUNDLE ITSELF.
 *
 * The bundle is built from a log this file writes the way the server writes one — through the real
 * `logLine`, plus a line an older build could have left unscrubbed — and a run ledger whose errors
 * are free text. Four canaries are planted wherever a careless line would put them: a password, a
 * Korean message somebody typed to a Bot, an email address, and a URL whose query carries a grant
 * and a token. The bundle is then SERIALISED whole and searched, because a field the allow-list
 * forgot is invisible to every assertion that names the fields it remembered.
 *
 * And a second person's events are in the same log, as they are on a VM with staff on it: none of
 * them may come out, including the line that names one of the first person's Bots beside one of the
 * second person's runs.
 */

const PASSWORD = "Hunter2!canary";
const KOREAN = "사장님 리뷰에 답글 달아 줘 카나리아";
const EMAIL = "staff.canary@laf.test";
const TOKEN_URL =
  "https://shop.example.com/oauth/callback?code=4/0AdeuCANARY&access_token=ya29.canaryTOKEN123";
const CANARIES = [
  PASSWORD,
  "Hunter2",
  KOREAN,
  "카나리아",
  "사장님",
  EMAIL,
  "@laf.test",
  TOKEN_URL,
  "shop.example.com",
  "access_token",
  "ya29.canaryTOKEN123",
  "4/0AdeuCANARY",
];

const AT = (minute: number) => new Date(Date.UTC(2026, 8, 14, 9, minute, 0));

/** Person A's things. */
const A: Ownership = {
  bot: new Set(["bot-a"]),
  run: new Set(["run-a1", "run-a2", "run-a3"]),
  thread: new Set(["thread-a"]),
  channel: new Set(["channel-a"]),
  routine: new Set(["routine-a"]),
};

const line = (
  minute: number,
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => logLine(level, "server", event, fields, AT(minute));

const LOG: string[] = [
  // Deployment-wide: nobody's.
  line(0, "info", "boot", { version: "edge", port: 3001 }),
  line(1, "error", "agent_stream_stalled", {
    bot: "bot-a",
    silentForMs: 60_000,
    stallMs: 60_000,
    chunks: 12,
    thread: "thread-a",
    run: "run-a1",
  }),
  // An error's own message, with an address and an email in it: the event stays, the reason goes.
  line(2, "warn", "live_screen_unreachable", {
    bot: "bot-a",
    reason: new Error(`Unable to reach ${TOKEN_URL} for ${EMAIL}`),
  }),
  line(3, "error", "room_member_turn_failed", {
    channel: "channel-a",
    member: "bot-a",
    reason: new Error(`password: ${PASSWORD} was refused`),
  }),
  // Fields no line should carry, carried anyway.
  line(4, "info", "retention", {
    bot: "bot-a",
    message: KOREAN,
    text: KOREAN,
    typed: PASSWORD,
    note: EMAIL,
    url: TOKEN_URL,
    code: "laf:turn_stalled",
  }),
  // A closed reason survives, and so does a code.
  line(5, "error", "routine_run_not_recorded", {
    routine: "routine-a",
    run: "run-a1",
    reason: new Error("x"),
    code: "laf:turn_timed_out",
  }),
  // An older build's line, never scrubbed: the reader scrubs it again and the allow-list drops it.
  JSON.stringify({
    level: "error",
    at: AT(6).toISOString(),
    svc: "server",
    event: "route_failed",
    run: "run-a1",
    password: PASSWORD,
    reason: `database error (23505) ${TOKEN_URL}`,
    detail: `${KOREAN} ${EMAIL}`,
  }),
  // A code that is not only a code, and an id that is not an id.
  line(7, "warn", "tool_call_answered", {
    bot: "bot-a",
    code: `laf:turn_failed ${PASSWORD}`,
  }),
  line(8, "warn", "tool_call_answered", { bot: EMAIL }),
  // Person B's, and a line naming A's Bot beside B's run, and a room A shares with B.
  line(9, "error", "agent_stream_stalled", { bot: "bot-b", run: "run-b1" }),
  line(10, "error", "agent_stream_stalled", { bot: "bot-a", run: "run-b1" }),
  line(11, "error", "room_turn_failed", { channel: "room-shared" }),
  "not a line at all",
];

const RUNS: LedgerRun[] = [
  {
    runId: "run-a1",
    agentId: "bot-a",
    status: "error",
    origin: "chat",
    error: `Unable to connect. ${TOKEN_URL} ${EMAIL} ${PASSWORD} ${KOREAN}`,
    startedAt: AT(1),
    finishedAt: new Date(AT(1).getTime() + 1_500),
  },
  {
    runId: "run-a2",
    agentId: "bot-a",
    status: "done",
    origin: "routine",
    error: null,
    startedAt: AT(12),
    finishedAt: new Date(AT(12).getTime() + 900),
  },
  {
    runId: "run-a3",
    agentId: "bot-a",
    status: "unknown",
    origin: "chat",
    error: null,
    startedAt: AT(13),
    finishedAt: null,
  },
];

const FAILED: LedgerRun[] = [
  RUNS[0] as LedgerRun,
  RUNS[2] as LedgerRun,
  {
    ...(RUNS[0] as LedgerRun),
    runId: "run-a4",
    error: `429 rate limit ${EMAIL}`,
    finishedAt: AT(14),
  },
  {
    ...(RUNS[0] as LedgerRun),
    runId: "run-a5",
    finishedAt: AT(15),
  },
];

function bundle(lines = LOG): DiagnosticBundle {
  return assembleDiagnostics({
    lines,
    ownership: A,
    runs: RUNS,
    failedRuns: FAILED,
    version: { version: "edge", revision: "eeea985", channel: "edge" },
    health: {
      status: "degraded",
      checks: { database: "ok", agentBot: "down" },
    },
    now: AT(20),
  });
}

describe("the bundle, serialised whole", () => {
  test("holds none of the password, the Korean message, the email or the token-bearing URL", () => {
    // Every canary is really in what the bundle was built from, or the search below proves nothing.
    const source = JSON.stringify({ LOG, RUNS, FAILED });
    expect(CANARIES.filter((canary) => !source.includes(canary))).toEqual([]);

    const serialised = JSON.stringify(bundle());
    const found = CANARIES.filter((canary) => serialised.includes(canary));
    expect(found).toEqual([]);
  });

  test("holds none of another person's events", () => {
    const serialised = JSON.stringify(bundle());
    expect(serialised).not.toContain("bot-b");
    expect(serialised).not.toContain("run-b1");
    expect(serialised).not.toContain("room-shared");
    // Nor the deployment's own lines, which are nobody's.
    expect(serialised).not.toContain('"boot"');
  });

  test("holds this person's events: names, ids, codes, closed reasons, timings", () => {
    const { events } = bundle();
    expect(events.map((event) => `${event.source}:${event.event}`)).toEqual([
      "log:agent_stream_stalled",
      "run:run_failed",
      "log:live_screen_unreachable",
      "log:room_member_turn_failed",
      "log:retention",
      "log:routine_run_not_recorded",
      "log:route_failed",
      "log:tool_call_answered",
      "run:run_finished",
      "run:run_interrupted",
    ]);
    expect(events[0]).toEqual({
      at: AT(1).toISOString(),
      source: "log",
      event: "agent_stream_stalled",
      level: "error",
      svc: "server",
      bot: "bot-a",
      thread: "thread-a",
      run: "run-a1",
      silentForMs: 60_000,
      stallMs: 60_000,
      chunks: 12,
    });
    // The ledger's free-text error, as the transcript's code; its duration.
    expect(events[1]).toEqual({
      at: new Date(AT(1).getTime() + 1_500).toISOString(),
      source: "run",
      event: "run_failed",
      run: "run-a1",
      origin: "chat",
      bot: "bot-a",
      code: "laf:turn_unreachable",
      ms: 1_500,
    });
    // An error's own message is not a reason; a room's member is read as the Bot it is.
    expect(events[2]).not.toHaveProperty("reason");
    expect(events[3]).toMatchObject({ channel: "channel-a", bot: "bot-a" });
    expect(events[3]).not.toHaveProperty("reason");
    // Typed words, a note, a URL: gone. The code beside them stays.
    expect(Object.keys(events[4] ?? {}).sort()).toEqual(
      ["at", "bot", "code", "event", "level", "source", "svc"].sort(),
    );
    expect(events[4]?.code).toBe("laf:turn_stalled");
    expect(events[5]).toMatchObject({
      routine: "routine-a",
      code: "laf:turn_timed_out",
    });
    // The unscrubbed line keeps its name and its run, and nothing it carried.
    expect(Object.keys(events[6] ?? {}).sort()).toEqual(
      ["at", "event", "level", "run", "source", "svc"].sort(),
    );
    // A code with a password after it is not a code.
    expect(events[7]).not.toHaveProperty("code");
    // A run with no ending says so, with no duration it does not have.
    expect(events[9]).toMatchObject({ code: "laf:turn_interrupted" });
    expect(events[9]).not.toHaveProperty("ms");
  });

  test("counts this person's failures by the transcript's codes, most frequent first", () => {
    expect(bundle().failures).toEqual([
      {
        code: "laf:turn_unreachable",
        count: 2,
        lastAt: AT(15).toISOString(),
      },
      {
        code: "laf:turn_rate_limited",
        count: 1,
        lastAt: AT(14).toISOString(),
      },
      {
        code: "laf:turn_interrupted",
        count: 1,
        lastAt: AT(13).toISOString(),
      },
    ]);
  });

  test("carries the build and the health report as they were handed over", () => {
    const { version, health, failureWindowDays, assembledAt } = bundle();
    expect(version).toEqual({
      version: "edge",
      revision: "eeea985",
      channel: "edge",
    });
    expect(health).toEqual({
      status: "degraded",
      checks: { database: "ok", agentBot: "down" },
    });
    expect(failureWindowDays).toBe(7);
    expect(assembledAt).toBe(AT(20).toISOString());
  });

  test("keeps the newest fifty events and no more", () => {
    const many = Array.from({ length: DIAGNOSTIC_EVENTS_MAX + 20 }, (_, i) =>
      logLine("warn", "server", "tool_call_answered", { bot: "bot-a" }, AT(i)),
    );
    const { events } = bundle(many);
    expect(events).toHaveLength(DIAGNOSTIC_EVENTS_MAX);
    // The runs end at minute 13, so the tail is all lines from the last minutes.
    expect(events.at(-1)?.at).toBe(
      AT(DIAGNOSTIC_EVENTS_MAX + 19).toISOString(),
    );
  });
});

describe("one line", () => {
  test("naming nothing is nobody's, and naming something of somebody else's is not this person's", () => {
    expect(
      eventFromLine(line(1, "info", "partner_connectors", {}), A),
    ).toBeNull();
    expect(
      eventFromLine(
        line(1, "info", "x", { bot: "bot-a", thread: "thread-b" }),
        A,
      ),
    ).toBeNull();
  });
});

describe("what the operator's webhook is told", () => {
  test("how much there is — four counts — and nothing in it", () => {
    const summary = summariseDiagnostics(bundle());
    expect(summary).toEqual({
      events: 10,
      failures: 4,
      failureCodes: 3,
      checksDown: 1,
    });
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain("laf:");
    expect(serialised).not.toContain("bot-a");
  });
});

describe("the bundles a person was shown", () => {
  test("are found by the person they were shown to, and by nobody else", () => {
    const shelf = createDiagnosticsShelf();
    const id = shelf.hold("person-a", bundle());
    expect(shelf.find("person-b", id)).toBeNull();
    expect(shelf.find("person-a", id)?.assembledAt).toBe(AT(20).toISOString());
    expect(shelf.find("person-a", "an-id-nobody-was-given")).toBeNull();
  });

  test("go stale, and past the cap the oldest go first", () => {
    let clock = 0;
    const shelf = createDiagnosticsShelf({
      ttlMs: 1_000,
      max: 2,
      now: () => clock,
    });
    const first = shelf.hold("p", bundle());
    const second = shelf.hold("p", bundle());
    const third = shelf.hold("p", bundle());
    expect(shelf.find("p", first)).toBeNull();
    expect(shelf.find("p", second)).not.toBeNull();
    clock = 1_000;
    expect(shelf.find("p", third)).toBeNull();
  });
});
