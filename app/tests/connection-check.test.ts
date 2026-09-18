import { afterEach, describe, expect, test } from "bun:test";
import { readConnectionCheck } from "@shared/support/connection-check";
import {
  adviceFor,
  type CheckIO,
  CONNECTION_CHECKS,
  type ConnectionCheckFacts,
  type ConnectionCheckResult,
  clockVerdict,
  connectionCheckText,
  forgetConnectionCheck,
  type HttpAnswer,
  lastConnectionCheck,
  type ProbeSocket,
  probeBotOf,
  rememberConnectionCheck,
  reportVerdicts,
  resultDetail,
  runConnectionCheck,
  secureVerdict,
  serverVerdict,
  sessionVerdict,
  socketVerdict,
} from "../src/lib/support/connection-check";

/**
 * 연결 점검, as logic: what each answer means, and what the whole run does with a server, a session
 * and a network that are each up or down.
 *
 * Every request and socket is a fake handed in through `CheckIO`, so each failure a person can meet
 * — a dead server, a café's sign-in page, a company network that lets requests through and holds
 * live sockets back, a clock set by hand — is a few lines here rather than an afternoon.
 */

afterEach(() => {
  forgetConnectionCheck();
});

const NOW = Date.parse("2026-09-18T10:00:00.000Z");
/** The `Date` header a server whose clock agrees with `NOW` sends. */
const SERVER_DATE = new Date(NOW).toUTCString();

function json(body: unknown, status = 200, date: string | null = SERVER_DATE) {
  const headers = new Headers({ "content-type": "application/json" });
  if (date) headers.set("date", date);
  return new Response(JSON.stringify(body), { status, headers });
}

function text(body: string, status: number) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html", date: SERVER_DATE },
  });
}

const HEALTHY = {
  status: "ok",
  checks: { database: "ok", agentBot: "ok", computer: "ok" },
};
const ME = {
  user: { id: "user-1", email: "owner@shop.example", role: "user" },
  deployment: {},
};
const BOTS = {
  agents: [
    { id: "agent_other", mine: false },
    { id: "agent_mine", mine: true },
  ],
};
const BUILD = { version: "v0.5.1", revision: "abc1234" };

/** A socket that does what its script says, when it is opened. */
class FakeSocket implements ProbeSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  closed = false;

  close() {
    this.closed = true;
  }
}

type Script = (socket: FakeSocket) => void;

const later = (step: () => void) => setTimeout(step, 1);

const SOCKETS = {
  /** What a probe door does: open, one frame, a close. */
  answers: ((socket) =>
    later(() => {
      socket.onopen?.({});
      socket.onmessage?.({ data: '{"kind":"probe"}' });
      socket.onclose?.({ code: 1000 });
    })) as Script,
  /** A handshake that never got through. Browsers say 1006 and nothing else. */
  refused: ((socket) =>
    later(() => {
      socket.onerror?.({});
      socket.onclose?.({ code: 1006 });
    })) as Script,
  /** Upgraded, and then nothing. */
  silent: ((socket) => later(() => socket.onopen?.({}))) as Script,
  /** Not even an upgrade. */
  hangs: (() => {}) as Script,
  cutWith:
    (code: number): Script =>
    (socket) =>
      later(() => {
        socket.onopen?.({});
        socket.onclose?.({ code });
      }),
};

type FakeWorld = {
  answers?: Record<string, () => Response | Promise<Response>>;
  sockets?: Record<string, Script>;
  offline?: boolean;
  wallClock?: number;
  location?: CheckIO["location"];
  throwOnSocket?: Error;
};

/** What the run asked for, in order. */
type Seen = { requests: string[]; sockets: string[]; made: FakeSocket[] };

function world(setup: FakeWorld = {}): { io: CheckIO; seen: Seen } {
  const seen: Seen = { requests: [], sockets: [], made: [] };
  const answers: Record<string, () => Response | Promise<Response>> = {
    "/api/health": () => json(HEALTHY),
    "/api/me": () => json(ME),
    "/api/agents": () => json(BOTS),
    "/api/version": () => json(BUILD),
    ...setup.answers,
  };
  const io: CheckIO = {
    request: (path, signal) => {
      seen.requests.push(path);
      const answer = answers[path];
      if (!answer) return Promise.resolve(json({ code: "laf:nope" }, 404));
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        Promise.resolve().then(answer).then(resolve, reject);
      });
    },
    openSocket: (path) => {
      seen.sockets.push(path);
      if (setup.throwOnSocket) throw setup.throwOnSocket;
      const socket = new FakeSocket();
      seen.made.push(socket);
      const script =
        Object.entries(setup.sockets ?? {}).find(([prefix]) =>
          path.startsWith(prefix),
        )?.[1] ?? SOCKETS.answers;
      script(socket);
      return socket;
    },
    elapsed: () => performance.now(),
    wallClock: () => setup.wallClock ?? NOW,
    isOffline: () => setup.offline === true,
    location: setup.location ?? {
      protocol: "https:",
      hostname: "shop.agent.laf-co.com",
    },
    surface: "shell",
  };
  return { io, seen };
}

const FAST = { requestMs: 40, openMs: 40, firstMessageMs: 40 };

async function run(setup: FakeWorld = {}) {
  const { io, seen } = world(setup);
  const heard: ConnectionCheckResult[] = [];
  const facts = await runConnectionCheck(io, {
    bounds: FAST,
    onResult: (result) => heard.push(result),
  });
  if (!facts) throw new Error("the run answered nothing");
  const by = Object.fromEntries(facts.checks.map((check) => [check.id, check]));
  return { facts, heard, seen, by };
}

const answered = (
  status: number,
  body: unknown,
  date: string | null = SERVER_DATE,
): HttpAnswer => ({ kind: "answered", ms: 12, status, body, date });

describe("the server's answer", () => {
  test("a report, healthy or degraded, is the server answering", () => {
    expect(serverVerdict(answered(200, HEALTHY)).result).toEqual({
      id: "server",
      state: "pass",
      reason: "answered",
      ms: 12,
      http: 200,
    });
    const degraded = serverVerdict(
      answered(503, { status: "degraded", checks: { agentBot: "down" } }),
    );
    expect(degraded.result.state).toBe("pass");
    expect(degraded.report).not.toBeNull();
  });

  test("no answer at all is offline when the device says so, and unanswered otherwise", () => {
    const threw = (offline: boolean): HttpAnswer => ({
      kind: "threw",
      ms: 3,
      error: "TypeError",
      offline,
    });
    expect(serverVerdict(threw(true)).result).toMatchObject({
      state: "fail",
      reason: "offline",
      error: "TypeError",
    });
    expect(serverVerdict(threw(false)).result).toMatchObject({
      state: "fail",
      reason: "no_answer",
    });
    expect(
      serverVerdict({ kind: "timed_out", ms: 10_000 }).result,
    ).toMatchObject({ state: "fail", reason: "timed_out", ms: 10_000 });
  });

  test("what answered instead of the server is told apart by what it said", () => {
    const reason = (status: number, body: unknown) =>
      serverVerdict(answered(status, body)).result.reason;
    // The front door with no API behind it, in both of its shapes (`app/Caddyfile`).
    expect(
      reason(503, { status: "down", checks: { api: "unreachable" } }),
    ).toBe("gateway");
    expect(reason(503, { code: "laf:api_unreachable" })).toBe("gateway");
    // A proxy with nothing to say.
    expect(reason(502, undefined)).toBe("gateway");
    expect(reason(504, undefined)).toBe("gateway");
    // Vite's answer for a stopped server (measured: a bare 500, text/plain, no body) is a door
    // speaking for an API it cannot reach. The API's own 500 says so in its own words.
    expect(reason(500, undefined)).toBe("gateway");
    expect(reason(500, { code: "laf:internal" })).toBe("server_error");
    expect(reason(503, { code: "laf:auth_not_configured" })).toBe(
      "server_error",
    );
    // A café's sign-in page answers 200 with HTML.
    expect(reason(200, undefined)).toBe("not_ours");
    expect(reason(404, undefined)).toBe("unexpected");
  });
});

describe("the report's rows", () => {
  test("say what the report says, and a computer it does not name is not there", () => {
    expect(
      reportVerdicts({
        status: "degraded",
        checks: { database: "ok", agentBot: "down" },
      }),
    ).toEqual([
      { id: "database", state: "pass", reason: "ok" },
      { id: "botService", state: "fail", reason: "down" },
      { id: "computer", state: "skip", reason: "not_configured" },
    ]);
  });

  test("are skipped when there is no report to read", () => {
    expect(reportVerdicts(null).map((row) => row.reason)).toEqual([
      "no_server",
      "no_server",
      "no_server",
    ]);
    expect(
      reportVerdicts({ status: "ok", checks: { computer: "ok" } })[0],
    ).toEqual({ id: "database", state: "skip", reason: "not_reported" });
  });
});

describe("the session", () => {
  test("is signed in when the door answers with a person", () => {
    expect(sessionVerdict(answered(200, ME))).toMatchObject({
      state: "pass",
      reason: "signed_in",
    });
  });

  test("says which way it is not", () => {
    expect(sessionVerdict(answered(401, {})).reason).toBe("signed_out");
    expect(
      sessionVerdict(answered(401, { code: "laf:session_revoked" })).reason,
    ).toBe("revoked");
    expect(sessionVerdict(answered(403, {})).reason).toBe("forbidden");
    expect(sessionVerdict(answered(200, undefined)).reason).toBe("not_ours");
    expect(
      sessionVerdict({
        kind: "threw",
        ms: 1,
        error: "TypeError",
        offline: false,
      }).reason,
    ).toBe("no_answer");
  });
});

describe("the page's own address", () => {
  test("https passes, the development server passes and says so, plain http fails", () => {
    expect(
      secureVerdict({ protocol: "https:", hostname: "shop.agent.laf-co.com" }),
    ).toEqual({ id: "secure", state: "pass", reason: "https" });
    for (const hostname of ["localhost", "127.0.0.1", "app.localhost"]) {
      expect(secureVerdict({ protocol: "http:", hostname }).reason).toBe(
        "local",
      );
    }
    expect(
      secureVerdict({ protocol: "http:", hostname: "shop.agent.laf-co.com" }),
    ).toEqual({ id: "secure", state: "fail", reason: "insecure" });
  });
});

describe("a probe socket's end", () => {
  test("maps to pass, fail and why", () => {
    const verdict = (answer: Parameters<typeof socketVerdict>[1]) =>
      socketVerdict("conversationSocket", answer);
    expect(verdict({ kind: "answered", ms: 30 })).toEqual({
      id: "conversationSocket",
      state: "pass",
      reason: "answered",
      ms: 30,
    });
    expect(verdict({ kind: "not_opened", ms: 5, close: 1006 })).toEqual({
      id: "conversationSocket",
      state: "fail",
      reason: "not_opened",
      ms: 5,
      close: 1006,
    });
    expect(verdict({ kind: "timed_out", ms: 8000, opened: false }).reason).toBe(
      "timed_out",
    );
    expect(verdict({ kind: "timed_out", ms: 5000, opened: true }).reason).toBe(
      "silent",
    );
    expect(verdict({ kind: "closed_early", ms: 9, close: 4401 }).reason).toBe(
      "session_ended",
    );
    expect(verdict({ kind: "closed_early", ms: 9, close: 1011 })).toMatchObject(
      { reason: "closed_early", close: 1011 },
    );
    expect(verdict({ kind: "unsupported", error: "SecurityError" })).toEqual({
      id: "conversationSocket",
      state: "fail",
      reason: "unsupported",
      error: "SecurityError",
    });
  });
});

describe("the clock", () => {
  test("agrees within a minute, and says by how much either way past it", () => {
    expect(clockVerdict(answered(200, BUILD), NOW + 1_500)).toEqual({
      id: "clock",
      state: "pass",
      reason: "in_sync",
      skewMs: 1_000,
    });
    const ahead = clockVerdict(answered(200, BUILD), NOW + 5 * 60_000);
    expect(ahead).toMatchObject({ state: "fail", reason: "skewed" });
    expect(ahead.skewMs).toBe(5 * 60_000 - 500);
    expect(
      clockVerdict(answered(200, BUILD), NOW - 3 * 60 * 60_000).skewMs,
    ).toBeLessThan(0);
  });

  test("compares only with this product's server, and only when it said the time", () => {
    // A proxy's page carries a `Date` too; it is not the clock routines run on.
    expect(clockVerdict(answered(200, undefined), NOW).reason).toBe(
      "no_server",
    );
    expect(clockVerdict(answered(503, BUILD), NOW).reason).toBe("no_server");
    expect(clockVerdict(answered(200, BUILD, null), NOW).reason).toBe(
      "no_date",
    );
    expect(clockVerdict(answered(200, BUILD, "not a date"), NOW).reason).toBe(
      "no_date",
    );
  });
});

describe("the Bot a screen probe names", () => {
  test("is the person's own first, any Bot otherwise, and none is a reason", () => {
    expect(probeBotOf(answered(200, BOTS))).toEqual({ botId: "agent_mine" });
    expect(
      probeBotOf(answered(200, { agents: [{ id: "agent_package" }] })),
    ).toEqual({ botId: "agent_package" });
    expect(probeBotOf(answered(200, { agents: [] }))).toEqual({
      reason: "no_bot",
    });
    expect(probeBotOf(answered(500, undefined))).toEqual({
      reason: "bots_unreadable",
    });
  });
});

describe("a whole run", () => {
  test("with everything up, every check passes, in order, each said as it is known", async () => {
    const { facts, heard, seen } = await run();

    expect(facts.checks.map((check) => check.id)).toEqual([
      ...CONNECTION_CHECKS,
    ]);
    expect(facts.checks.every((check) => check.state === "pass")).toBe(true);
    expect(heard).toEqual(facts.checks);
    expect(facts.surface).toBe("shell");
    expect(facts.at).toBe(new Date(NOW).toISOString());
    // The check's own sockets, never the app's: both doors are asked as probes.
    expect(seen.sockets).toEqual([
      "/api/channels/events?probe=1",
      "/api/computers/agent_mine/stream?probe=1",
    ]);
    expect(seen.made.every((socket) => socket.closed)).toBe(true);
  });

  test("a server that does not answer skips everything behind it, and asks nothing more", async () => {
    const { by, seen } = await run({
      offline: true,
      answers: {
        "/api/health": () => Promise.reject(new TypeError("Load failed")),
      },
    });

    expect(by.server).toMatchObject({ state: "fail", reason: "offline" });
    for (const id of [
      "database",
      "botService",
      "computer",
      "session",
      "conversationSocket",
      "liveScreenSocket",
      "clock",
    ]) {
      expect(by[id]).toEqual({
        id: id as ConnectionCheckResult["id"],
        state: "skip",
        reason: "no_server",
      });
    }
    // The page's own address needs nobody's answer.
    expect(by.secure?.state).toBe("pass");
    expect(seen.requests).toEqual(["/api/health"]);
    expect(seen.sockets).toEqual([]);
  });

  test("a sign-in page answering in the server's place is not the server, and nothing is asked behind it", async () => {
    const { by, seen } = await run({
      answers: {
        "/api/health": () => text("<html>Wi-Fi 로그인</html>", 200),
      },
    });

    expect(by.server).toMatchObject({
      state: "fail",
      reason: "not_ours",
      http: 200,
    });
    expect(adviceFor(by.server as ConnectionCheckResult)).toContain(
      "café or hotel",
    );
    expect(by.clock?.reason).toBe("no_server");
    expect(seen.requests).toEqual(["/api/health"]);
  });

  test("a stopped Bot service fails its own row and nothing else", async () => {
    const { by } = await run({
      answers: {
        "/api/health": () =>
          json(
            {
              status: "degraded",
              checks: { database: "ok", agentBot: "down", computer: "ok" },
            },
            503,
          ),
      },
    });

    expect(by.server?.state).toBe("pass");
    expect(by.botService).toEqual({
      id: "botService",
      state: "fail",
      reason: "down",
    });
    expect(
      Object.values(by).filter((check) => check.state !== "pass"),
    ).toHaveLength(1);
  });

  test("requests that get through while live sockets do not are said as exactly that", async () => {
    const { by } = await run({
      sockets: {
        "/api/channels/events": SOCKETS.refused,
        "/api/computers/": SOCKETS.refused,
      },
    });

    expect(by.server?.state).toBe("pass");
    expect(by.session?.state).toBe("pass");
    expect(by.conversationSocket).toMatchObject({
      state: "fail",
      reason: "not_opened",
      close: 1006,
    });
    const sentence = adviceFor(
      by.conversationSocket as ConnectionCheckResult,
      Object.values(by),
    );
    expect(sentence).toContain("Ordinary requests reach the server");
    expect(sentence).toContain("another network");
    // The screen's socket failed the same way: the same fact, said once and pointed back to.
    expect(
      adviceFor(
        by.liveScreenSocket as ConnectionCheckResult,
        Object.values(by),
      ),
    ).toBe(
      "The Bot's screen uses the same kind of live connection, so the same applies.",
    );
  });

  test("a socket that opens and says nothing, or never opens, is bounded and says which", async () => {
    const { by } = await run({
      sockets: {
        "/api/channels/events": SOCKETS.silent,
        "/api/computers/": SOCKETS.hangs,
      },
    });

    expect(by.conversationSocket?.reason).toBe("silent");
    expect(by.liveScreenSocket?.reason).toBe("timed_out");
  });

  test("a screen socket failing where the conversation's got through is not blamed on the network", async () => {
    const { by } = await run({
      sockets: { "/api/computers/": SOCKETS.cutWith(1011) },
    });

    const screen = by.liveScreenSocket as ConnectionCheckResult;
    expect(screen).toMatchObject({ reason: "closed_early", close: 1011 });
    expect(adviceFor(screen, Object.values(by))).toContain("check again");
    expect(
      adviceFor({ ...screen, reason: "not_opened" }, Object.values(by)),
    ).toContain("though conversations can");
  });

  test("signed out: the sockets are not asked, and the clock still is", async () => {
    const { by, seen } = await run({
      answers: { "/api/me": () => json({ code: "laf:unauthenticated" }, 401) },
    });

    expect(by.session).toMatchObject({ state: "fail", reason: "signed_out" });
    expect(by.conversationSocket?.reason).toBe("no_session");
    expect(by.liveScreenSocket?.reason).toBe("no_session");
    expect(by.clock?.state).toBe("pass");
    expect(seen.sockets).toEqual([]);
  });

  test("no computer, and no Bot, are reasons to skip the screen rather than failures", async () => {
    const withoutComputer = await run({
      answers: {
        "/api/health": () =>
          json({ status: "ok", checks: { database: "ok", agentBot: "ok" } }),
      },
    });
    expect(withoutComputer.by.computer?.reason).toBe("not_configured");
    expect(withoutComputer.by.liveScreenSocket?.reason).toBe("not_configured");
    expect(withoutComputer.seen.requests).not.toContain("/api/agents");

    const withoutBots = await run({
      answers: { "/api/agents": () => json({ agents: [] }) },
    });
    expect(withoutBots.by.liveScreenSocket).toEqual({
      id: "liveScreenSocket",
      state: "skip",
      reason: "no_bot",
    });
  });

  test("a request that never answers is bounded", async () => {
    const { by } = await run({
      answers: { "/api/me": () => new Promise<Response>(() => {}) },
    });

    expect(by.session).toMatchObject({ state: "fail", reason: "timed_out" });
  });

  test("a clock five minutes fast fails, and says so in minutes", async () => {
    const { by } = await run({ wallClock: NOW + 5 * 60_000 });

    const clock = by.clock as ConnectionCheckResult;
    expect(clock).toMatchObject({ state: "fail", reason: "skewed" });
    expect(adviceFor(clock)).toBe(
      "This device's clock is 5 min ahead of the server's, so routine times and countdowns will look wrong; turn on setting the time automatically in the device's settings.",
    );
  });

  test("what the world hands back past a bound is kept inside the vocabulary, so the result survives the reading", async () => {
    // A laptop closed mid-check wakes to a duration of hours; a clock nobody set is years off; an
    // engine may leave a close code at 0. Each would make the server refuse the whole result.
    const { io } = world({
      wallClock: NOW + 3 * 365 * 24 * 60 * 60 * 1000,
      sockets: {
        "/api/channels/events": (socket) =>
          later(() => socket.onclose?.({ code: 0 })),
      },
    });
    let clock = 0;
    const facts = await runConnectionCheck(
      {
        ...io,
        // Every reading of the clock an hour after the last.
        elapsed: () => {
          clock += 60 * 60 * 1000;
          return clock;
        },
      },
      { bounds: FAST },
    );
    if (!facts) throw new Error("the run answered nothing");
    const by = Object.fromEntries(
      facts.checks.map((check) => [check.id, check]),
    );

    expect(by.server?.ms).toBe(600_000);
    expect(by.conversationSocket).toEqual({
      id: "conversationSocket",
      state: "fail",
      reason: "not_opened",
      ms: 600_000,
    });
    expect(by.clock).toEqual({
      id: "clock",
      state: "fail",
      reason: "skewed",
      skewMs: 366 * 24 * 60 * 60 * 1000,
    });
    expect(readConnectionCheck(facts)).toEqual(facts);
    expect(connectionCheckText(facts)).not.toBe("connection-check unreadable");
  });

  test("stopped partway, it says nothing more and answers nothing", async () => {
    const controller = new AbortController();
    const { io } = world({
      answers: {
        "/api/me": () => {
          controller.abort();
          return json(ME);
        },
      },
    });
    const heard: string[] = [];
    const facts = await runConnectionCheck(io, {
      bounds: FAST,
      signal: controller.signal,
      onResult: (result) => heard.push(result.id),
    });

    expect(facts).toBeNull();
    expect(heard).toEqual(["server", "database", "botService", "computer"]);
  });
});

describe("the words", () => {
  test("every failure and every skip has a sentence, and a pass has none", async () => {
    const fail: ConnectionCheckResult = {
      id: "server",
      state: "fail",
      reason: "gateway",
    };
    expect(adviceFor(fail)).toContain("usually clears on its own");
    expect(
      adviceFor({ id: "session", state: "skip", reason: "no_server" }),
    ).toBe("The server did not answer, so this was not checked.");
    expect(
      adviceFor({ id: "server", state: "pass", reason: "answered" }),
    ).toBeNull();
  });

  test("a passing row shows its timing, or the fact it checked", () => {
    expect(
      resultDetail({ id: "server", state: "pass", reason: "answered", ms: 84 }),
    ).toBe("84 ms");
    expect(resultDetail({ id: "secure", state: "pass", reason: "local" })).toBe(
      "Local development address",
    );
    expect(resultDetail({ id: "secure", state: "pass", reason: "https" })).toBe(
      "https",
    );
    expect(
      resultDetail({
        id: "clock",
        state: "pass",
        reason: "in_sync",
        skewMs: 300,
      }),
    ).toBe("Under a second apart");
    expect(
      resultDetail({
        id: "clock",
        state: "pass",
        reason: "in_sync",
        skewMs: -4_200,
      }),
    ).toBe("4 s apart");
  });
});

describe("the last result", () => {
  test("is kept for the tab, and forgotten on request", async () => {
    const { facts } = await run();
    expect(lastConnectionCheck()).toBeNull();
    rememberConnectionCheck(facts);
    expect(lastConnectionCheck()).toBe(facts);
    forgetConnectionCheck();
    expect(lastConnectionCheck()).toBeNull();
  });
});

/**
 * THE COPIED TEXT HOLDS CLOSED FACTS ONLY.
 *
 * Built from a run in which everything that could carry words did: a fetch that failed with a
 * password and a Korean sentence in its message, a session answer with the person's email and a
 * token in it, a health report with extra keys, a socket closed with a reason. The copy text and the
 * result serialised whole are searched for every one of them.
 */
describe("what 복사 copies", () => {
  const PASSWORD = "hunter2-비밀번호";
  const SENTENCE = "비밀번호가 틀렸습니다 다시 입력하세요";
  const TOKEN = "Bearer sk-live-0123456789";

  const SECRETS = [
    PASSWORD,
    "hunter2",
    SENTENCE,
    "비밀번호",
    TOKEN,
    "sk-live",
    "owner@shop.example",
    "password",
  ];

  const expectClosed = (facts: ConnectionCheckFacts) => {
    const copied = connectionCheckText(facts);
    const serialised = JSON.stringify(facts);
    for (const secret of SECRETS) {
      expect({ secret, inCopy: copied.includes(secret) }).toEqual({
        secret,
        inCopy: false,
      });
      expect({ secret, inResult: serialised.includes(secret) }).toEqual({
        secret,
        inResult: false,
      });
    }
    // And no Hangul at all: the copied text is codes, never the surface's sentences.
    expect(copied).not.toMatch(/[가-힣]/);
    return copied;
  };

  test("carries no message, sentence, token, email or close reason, whatever the answers held", async () => {
    const { facts } = await run({
      answers: {
        "/api/health": () =>
          json({
            status: "degraded",
            checks: {
              database: "ok",
              agentBot: `down ${PASSWORD}`,
              computer: "ok",
            },
            note: SENTENCE,
          }),
        // Signed in, with the person's email in the answer, as the real door has it.
        "/api/me": () => json({ ...ME, token: TOKEN }),
        "/api/agents": () =>
          json({ agents: [{ id: "agent_mine", mine: true, name: SENTENCE }] }),
        "/api/version": () =>
          Promise.reject(new TypeError(`password=${PASSWORD} ${SENTENCE}`)),
      },
      sockets: {
        "/api/channels/events": (socket) =>
          later(() =>
            socket.onclose?.({
              code: 1006,
              reason: `${SENTENCE} ${TOKEN}`,
            } as { code: number }),
          ),
        "/api/computers/": (socket) =>
          later(() => {
            socket.onopen?.({});
            socket.onclose?.({
              code: 4001,
              reason: PASSWORD,
            } as { code: number });
          }),
      },
    });
    const copied = expectClosed(facts);

    // What it does carry is what happened.
    expect(copied).toContain("botService fail down");
    expect(copied).toContain("conversationSocket fail not_opened");
    expect(copied).toContain("close=4001");
    expect(copied).toContain("clock skip no_server");
  });

  test("a refused session carries no more of its answer than the refusal's code", async () => {
    const { facts } = await run({
      answers: {
        "/api/me": () =>
          json(
            {
              code: "laf:session_revoked",
              user: { email: "owner@shop.example" },
              token: TOKEN,
              message: SENTENCE,
            },
            401,
          ),
      },
    });
    const copied = expectClosed(facts);

    expect(copied).toContain("session fail revoked");
    expect(copied).toContain("conversationSocket skip no_session");
  });

  test("is one line per check, with timings, statuses and error classes", async () => {
    const { facts } = await run({
      answers: {
        "/api/version": () => Promise.reject(new TypeError("Load failed")),
      },
      sockets: { "/api/computers/": SOCKETS.refused },
    });
    const lines = connectionCheckText(facts).split("\n");

    expect(lines[0]).toBe(
      "connection-check 2026-09-18T10:00:00.000Z surface=shell",
    );
    expect(lines).toHaveLength(1 + CONNECTION_CHECKS.length);
    expect(lines.find((line) => line.startsWith("server "))).toMatch(
      /^server pass answered \d+ms http=200$/,
    );
    expect(lines.find((line) => line.startsWith("liveScreenSocket "))).toMatch(
      /^liveScreenSocket fail not_opened \d+ms close=1006$/,
    );
    // A clock request that threw is not a clock worth comparing: skipped, with no message.
    expect(lines.find((line) => line.startsWith("clock "))).toBe(
      "clock skip no_server",
    );
  });

  test("an object carrying a field the vocabulary does not have is written as unreadable", () => {
    const smuggled = {
      at: "2026-09-18T10:00:00.000Z",
      surface: "shell",
      checks: [{ id: "server", state: "fail", reason: SENTENCE }],
    };
    const text = connectionCheckText(smuggled as never);
    expect(text).toBe("connection-check unreadable");
  });
});
