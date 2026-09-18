import { describe, expect, test } from "bun:test";
import { logLine } from "../../shared/log";
import {
  assembleDiagnostics,
  type DiagnosticBundle,
  eventFromLine,
  type Ownership,
} from "../src/support/diagnostics";
import { SCREEN_FAILED } from "../src/support/screen-errors";

/**
 * A SCREEN THAT FAILED, CARRIED BY "진단 정보 같이 보내기": THE FACTS, AND NOTHING ELSE.
 *
 * `diagnostics.ts` keeps what is on an allow-list and drops the rest, and the screen-failure line
 * widened that list by exactly the facts a report is made of. So the log here holds the line the
 * route writes, and beside it the lines a careless build could have left — the same event carrying
 * the error's message, its stack, the address with its query, what was typed — and the bundle is
 * serialised whole and searched for every one of them. A field the allow-list forgot is invisible to
 * every assertion that names the fields it remembered; the search is what sees it.
 *
 * And the line names a person rather than a Bot, so it is held to the person: another person's
 * screen is not in this person's bundle, a screen line that also names a Bot is not one the route
 * wrote, and no OTHER line becomes this person's by naming them.
 */

const PASSWORD = "hunter2-canary";
const KOREAN = "사장님 리뷰에 답글 달아 줘 카나리아";
const EMAIL = "owner.canary@laf.test";
const ADDRESS =
  "https://laf.example/channel/0f9c2d4e-7a1b?settings=true&pw=hunter2-canary";

const CANARIES = [
  PASSWORD,
  "hunter2",
  KOREAN,
  "사장님",
  "카나리아",
  EMAIL,
  ADDRESS,
  "laf.example",
  "0f9c2d4e-7a1b",
  "Invalid URL",
  "chat-transcript",
];

const PERSON = "user-owner";
const OTHER = "user-staff";

const AT = (minute: number) => new Date(Date.UTC(2026, 8, 18, 9, minute, 0));

const OWNER: Ownership = {
  user: new Set([PERSON]),
  bot: new Set(["bot-owner"]),
  run: new Set(),
  thread: new Set(),
  channel: new Set(),
  routine: new Set(),
};

/** What the route writes: the person and the report, nothing besides. */
const REPORT = {
  section: "transcript",
  route: "/channel/$channelId",
  kind: "TypeError",
  fingerprint: "a41c09e2b7f3",
  build: "v0.5.1",
  revision: "eeea9853c2d1",
  surface: "shell",
} as const;

const screenLine = (minute: number, fields: Record<string, unknown>) =>
  logLine("warn", "server", SCREEN_FAILED, fields, AT(minute));

const LOG: string[] = [
  // The line the route writes.
  screenLine(1, { user: PERSON, ...REPORT }),
  // The same event with everything a careless build could have put beside the facts.
  screenLine(2, {
    user: PERSON,
    ...REPORT,
    message: `Invalid URL: '${ADDRESS}' ${KOREAN}`,
    stack: `TypeError: ${PASSWORD}\n    at x (http://localhost:3610/src/components/channels/chat-transcript.tsx:88:3)`,
    url: ADDRESS,
    input: PASSWORD,
    email: EMAIL,
    props: { draft: KOREAN },
  }),
  // A line never scrubbed on the way in, as an older build could have left it.
  JSON.stringify({
    level: "warn",
    at: AT(3).toISOString(),
    svc: "server",
    event: SCREEN_FAILED,
    user: PERSON,
    ...REPORT,
    password: PASSWORD,
    detail: `${KOREAN} ${EMAIL}`,
    // Whole, as the logger's scrubber would never have let it through on the way in.
    href: ADDRESS,
  }),
  // Facts that no longer fit: each dropped alone, the rest standing.
  screenLine(4, {
    user: PERSON,
    ...REPORT,
    route: ADDRESS,
    kind: `TypeError: ${PASSWORD}`,
    build: PASSWORD,
  }),
  // Another person's screen.
  screenLine(5, { user: OTHER, ...REPORT, section: "sidebar" }),
  // A screen line that names a Bot is not one the route wrote.
  screenLine(6, { user: PERSON, bot: "bot-owner", ...REPORT }),
  // Naming nobody at all.
  screenLine(7, { ...REPORT }),
  // Another line that names the person: it does not become theirs by doing so.
  logLine(
    "info",
    "server",
    "live_screens_closed",
    {
      user: PERSON,
      screens: 2,
    },
    AT(8),
  ),
];

function bundle(lines = LOG, ownership = OWNER): DiagnosticBundle {
  return assembleDiagnostics({
    lines,
    ownership,
    runs: [],
    failedRuns: [],
    version: { version: "v0.5.1" },
    health: { status: "ok", checks: { database: "ok" } },
    now: AT(20),
  });
}

describe("a screen that failed, in the diagnostic details", () => {
  test("holds none of the message, the stack, the address, what was typed or the email", () => {
    const source = LOG.join("\n");
    expect(CANARIES.filter((canary) => !source.includes(canary))).toEqual([]);

    const serialised = JSON.stringify(bundle());
    expect(CANARIES.filter((canary) => serialised.includes(canary))).toEqual(
      [],
    );
  });

  test("keeps the facts, and only the facts, of this person's screens", () => {
    const { events } = bundle();
    expect(events.map((event) => event.at)).toEqual([
      AT(1).toISOString(),
      AT(2).toISOString(),
      AT(3).toISOString(),
      AT(4).toISOString(),
    ]);
    const facts = {
      source: "log" as const,
      event: SCREEN_FAILED,
      level: "warn",
      svc: "server",
      ...REPORT,
    };
    expect(events[0]).toEqual({ at: AT(1).toISOString(), ...facts });
    expect(events[1]).toEqual({ at: AT(2).toISOString(), ...facts });
    expect(events[2]).toEqual({ at: AT(3).toISOString(), ...facts });
    // The route, the kind and the build that do not fit are gone; everything else of the line stays.
    expect(events[3]).toEqual({
      at: AT(4).toISOString(),
      source: "log",
      event: SCREEN_FAILED,
      level: "warn",
      svc: "server",
      section: "transcript",
      fingerprint: "a41c09e2b7f3",
      revision: "eeea9853c2d1",
      surface: "shell",
    });
    // The person is how the line was found, not a fact it carries.
    expect(events.every((event) => !("user" in event))).toBe(true);
  });

  test("is nobody's when the reader was not told who is asking", () => {
    const { user: _asking, ...withoutPerson } = OWNER;
    expect(
      eventFromLine(LOG[0] as string, withoutPerson as Ownership),
    ).toBeNull();
    expect(bundle(LOG, withoutPerson as Ownership).events).toEqual([]);
  });
});
