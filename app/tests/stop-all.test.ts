import { afterEach, describe, expect, test } from "bun:test";
import {
  busyHeldChats,
  holdChat,
  stopHeldChats,
} from "../src/lib/copilot/held-chats";
import { ko } from "../src/lib/i18n-ko";
import {
  outcomeWithHeld,
  parseRunning,
  parseStopAll,
  pressStopAll,
  RUN_STOPPED,
  runningWithHeld,
  type StopAllResult,
  totalOf,
  WORK_KINDS,
  WORK_LINES,
  workBreakdown,
} from "../src/lib/work/stop-all";

/**
 * `모두 멈추기`, as the window that pressed it adds up what happened.
 *
 * The server stops what the server can reach — every run on the wire, and every conversation whose
 * next step is waiting on a browser. This window stops the conversation it holds itself, which also
 * covers the second and a half before a turn's first run exists. The same conversation can be in
 * both, and the person must read it once: counted twice, "대화 2개" for one conversation is exactly
 * the kind of number that makes a stop button untrustworthy.
 */

const none = { chat: 0, room: 0, routine: 0, handoff: 0 };

describe("what is running, as the dialog counts it", () => {
  test("a conversation both the server and this window know about is one", () => {
    expect(
      runningWithHeld(
        { running: { ...none, chat: 1, routine: 1 }, chats: ["thread-1"] },
        ["thread-1"],
      ),
    ).toEqual({ ...none, chat: 1, routine: 1 });
  });

  test("one only this window knows about — its first run not begun yet — is counted too", () => {
    expect(runningWithHeld({ running: none, chats: [] }, ["thread-2"])).toEqual(
      { ...none, chat: 1 },
    );
  });

  test("totals every kind", () => {
    expect(totalOf({ chat: 1, room: 2, routine: 3, handoff: 4 })).toBe(10);
    expect(totalOf(none)).toBe(0);
  });
});

describe("what one press came to", () => {
  test("a conversation the server stopped and this window stopped as well is one stopped", () => {
    expect(
      outcomeWithHeld(
        {
          stopped: { ...none, chat: 1 },
          notStopped: none,
          chats: { stopped: ["thread-1"], notStopped: [] },
        },
        { stopped: ["thread-1"], notStopped: [] },
      ),
    ).toEqual({ stopped: { ...none, chat: 1 }, notStopped: none });
  });

  test("one the server could not stop and this window did is stopped, not stuck", () => {
    expect(
      outcomeWithHeld(
        {
          stopped: { ...none, routine: 1 },
          notStopped: { ...none, chat: 1 },
          chats: { stopped: [], notStopped: ["thread-1"] },
        },
        { stopped: ["thread-1"], notStopped: [] },
      ),
    ).toEqual({
      stopped: { ...none, chat: 1, routine: 1 },
      notStopped: none,
    });
  });

  test("one the server could not stop and this window does not hold stays not stopped", () => {
    expect(
      outcomeWithHeld(
        {
          stopped: none,
          notStopped: { ...none, chat: 1 },
          chats: { stopped: [], notStopped: ["thread-9"] },
        },
        { stopped: [], notStopped: [] },
      ),
    ).toEqual({ stopped: none, notStopped: { ...none, chat: 1 } });
  });

  test("one only this window held, whose Stop failed, is not stopped — and not missing either", () => {
    expect(
      outcomeWithHeld(
        {
          stopped: none,
          notStopped: none,
          chats: { stopped: [], notStopped: [] },
        },
        { stopped: [], notStopped: ["thread-3"] },
      ),
    ).toEqual({ stopped: none, notStopped: { ...none, chat: 1 } });
  });

  test("with no answer from the server, what this window stopped is still said", () => {
    expect(
      outcomeWithHeld(null, { stopped: ["thread-1"], notStopped: [] }),
    ).toEqual({ stopped: { ...none, chat: 1 }, notStopped: none });
  });
});

describe("one press", () => {
  const server = (): StopAllResult => ({
    stopped: { ...none, chat: 1, routine: 1 },
    notStopped: none,
    chats: { stopped: ["thread-1"], notStopped: [] },
  });

  test("stops this window's conversation before the server is asked", async () => {
    /*
     * MEASURED the other way round: the server's stop closed the stream while this window still
     * awaited the reply, and the conversation drew "답을 받지 못했습니다." under a stopped turn.
     */
    const order: string[] = [];
    await pressStopAll({
      stopHere: () => {
        order.push("here");
        return { stopped: ["thread-1"], notStopped: [] };
      },
      stopServer: async () => {
        order.push("server");
        return server();
      },
    });
    expect(order).toEqual(["here", "server"]);
  });

  test("adds up both sides, one conversation once", async () => {
    expect(
      await pressStopAll({
        stopHere: () => ({ stopped: ["thread-1"], notStopped: [] }),
        stopServer: async () => server(),
      }),
    ).toEqual({
      reached: true,
      outcome: { stopped: { ...none, chat: 1, routine: 1 }, notStopped: none },
    });
  });

  test("a server that does not answer is said, and this window's stop still counts", async () => {
    expect(
      await pressStopAll({
        stopHere: () => ({ stopped: ["thread-1"], notStopped: [] }),
        stopServer: async () => {
          throw new Error("/api/me/stop-all answered 502");
        },
      }),
    ).toEqual({
      reached: false,
      outcome: { stopped: { ...none, chat: 1 }, notStopped: none },
    });
  });
});

describe("the words", () => {
  test("list only what there was, in the order the kinds are drawn", () => {
    expect(workBreakdown({ chat: 2, room: 0, routine: 1, handoff: 0 })).toEqual(
      [WORK_LINES.chat, WORK_LINES.routine],
    );
    expect(WORK_KINDS).toEqual(["chat", "room", "routine", "handoff"]);
  });

  test("every kind has Korean that keeps its count", () => {
    for (const line of Object.values(WORK_LINES)) {
      expect([line, ko[line]?.includes("{count}")]).toEqual([line, true]);
    }
  });
});

describe("the fact a stopped routine is recorded under", () => {
  test("is the one the server writes", async () => {
    // Read off the server's source, like the coworker walk: importing the loop would pull in the
    // computer gateway and everything under it for one string.
    const loop = await Bun.file(
      new URL("../../server/src/runner/unattended.ts", import.meta.url),
    ).text();
    expect(loop).toContain(`export const RUN_STOPPED = "${RUN_STOPPED}";`);
    expect(ko["It was stopped with Stop everything."]).toBeString();
  });
});

describe("what the server answered, read defensively", () => {
  test("a count that is not a count reads as none, and never as the whole answer failing", () => {
    expect(
      parseRunning({
        running: { chat: 1, room: "2", routine: -1 },
        chats: ["thread-1", 5],
      }),
    ).toEqual({ running: { ...none, chat: 1 }, chats: ["thread-1"] });
    expect(parseStopAll({})).toEqual({
      stopped: none,
      notStopped: none,
      chats: { stopped: [], notStopped: [] },
    });
  });
});

describe("the conversations this window holds", () => {
  const releases: Array<() => void> = [];
  afterEach(() => {
    for (const release of releases.splice(0)) release();
  });

  test("are stopped when they have a turn in flight, and left alone when they do not", () => {
    const stopped: string[] = [];
    releases.push(
      holdChat({
        threadId: "busy",
        busy: () => true,
        stop: () => stopped.push("busy"),
      }),
      holdChat({
        threadId: "idle",
        busy: () => false,
        stop: () => stopped.push("idle"),
      }),
    );
    expect(busyHeldChats()).toEqual(["busy"]);
    expect(stopHeldChats()).toEqual({ stopped: ["busy"], notStopped: [] });
    expect(stopped).toEqual(["busy"]);
  });

  test("a conversation that unmounted is no longer held", () => {
    const release = holdChat({
      threadId: "gone",
      busy: () => true,
      stop: () => {},
    });
    release();
    expect(busyHeldChats()).toEqual([]);
  });

  test("one conversation whose Stop throws does not keep the others running", () => {
    const stopped: string[] = [];
    releases.push(
      holdChat({
        threadId: "broken",
        busy: () => true,
        stop: () => {
          throw new Error("the agent is gone");
        },
      }),
      holdChat({
        threadId: "fine",
        busy: () => true,
        stop: () => stopped.push("fine"),
      }),
    );
    expect(stopHeldChats()).toEqual({
      stopped: ["fine"],
      notStopped: ["broken"],
    });
    expect(stopped).toEqual(["fine"]);
  });
});
