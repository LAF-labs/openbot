import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { AuditEventInput } from "../src/audit";
import { loadConfig } from "../src/config";
import { createWorkInFlight, type Work } from "../src/runner/in-flight";
import { createStopAll } from "../src/runner/stop-all";
import { testEnvironment } from "./support/environment";

/**
 * `모두 멈추기`: everything a person has going on, on their own Bots, stopped by one press.
 *
 * What is pinned here is the door, not the stopping — each run path's own stop is tested where it
 * lives (`chat-stop`, `room-stop`, `routine-stop`, `coworker-stop`). The door has four promises:
 * it reaches only the person's own work on Bots the ownership rule lets them drive; it answers what
 * it stopped, by kind; it says out loud what it found and could not stop, rather than counting it as
 * stopped; and the press is on the trail whether or not anything was running.
 */

const OWNER = "owner";

const signedIn = {
  handler: () => new Response(null, { status: 204 }),
  api: {
    getSession: async () => ({
      user: { id: OWNER, email: "owner@laf.test", name: "사장님" },
    }),
  },
};

/** Whose each Bot is. `shared-bot` is nobody's, which the rule lets everybody drive. */
const OWNERS: Record<string, string | null> = {
  "bot-1": OWNER,
  "bot-2": OWNER,
  "shared-bot": null,
  "someone-elses-bot": "someone-else",
};

const roles = {
  rolesForUser: async () => ["user" as const],
  botOwner: async (botId: string) => OWNERS[botId],
};

function surface(stopAll: ReturnType<typeof createStopAll> | undefined) {
  const args: Parameters<typeof createApp> = [
    loadConfig(testEnvironment()),
    signedIn,
    roles,
  ];
  args[46] = stopAll;
  return createApp(...args);
}

/** A piece of work that stops when asked, and says whether it was asked. */
function going(
  overrides: Partial<Work> & Pick<Work, "kind">,
  answer: () => Promise<boolean> = async () => true,
) {
  let stopped = false;
  const work: Work = {
    userId: OWNER,
    agentId: "bot-1",
    threadId: null,
    stop: async () => {
      stopped = true;
      return answer();
    },
    ...overrides,
  };
  return { work, stopped: () => stopped };
}

function harness() {
  const work = createWorkInFlight();
  const rows: AuditEventInput[] = [];
  const stopAll = createStopAll({
    work,
    auditStore: { insert: async (row) => void rows.push(row) },
  });
  return { work, rows, app: surface(stopAll) };
}

const counts = (partial: Partial<Record<string, number>> = {}) => ({
  chat: 0,
  room: 0,
  routine: 0,
  handoff: 0,
  ...partial,
});

describe("what is running, before anything is stopped", () => {
  test("counts the person's own work by kind, with the conversations by thread", async () => {
    const { work, app } = harness();
    work.track(going({ kind: "chat", threadId: "thread-1" }).work);
    work.track(going({ kind: "routine" }).work);
    work.track(going({ kind: "room", agentId: null, threadId: "room-1" }).work);
    work.track(going({ kind: "handoff", agentId: "bot-2" }).work);

    const response = await app.request("http://laf.local/api/me/running");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      running: counts({ chat: 1, room: 1, routine: 1, handoff: 1 }),
      chats: ["thread-1"],
    });
  });

  test("leaves out somebody else's work, and work on a Bot the person may not drive", async () => {
    const { work, app } = harness();
    work.track(going({ kind: "routine", userId: "someone-else" }).work);
    work.track(going({ kind: "chat", agentId: "someone-elses-bot" }).work);
    // A Bot nobody made is everybody's to drive, so work on it for this person is theirs to stop.
    work.track(going({ kind: "routine", agentId: "shared-bot" }).work);

    const response = await app.request("http://laf.local/api/me/running");
    expect(await response.json()).toEqual({
      running: counts({ routine: 1 }),
      chats: [],
    });
  });

  test("one conversation is one, however many listings it has", async () => {
    const { work, app } = harness();
    work.track(going({ kind: "chat", threadId: "thread-1" }).work);
    work.track(going({ kind: "chat", threadId: "thread-1" }).work);
    const response = await app.request("http://laf.local/api/me/running");
    expect(await response.json()).toEqual({
      running: counts({ chat: 1 }),
      chats: ["thread-1"],
    });
  });
});

describe("stopping everything", () => {
  test("stops the person's own work, answers by kind, and touches nobody else's", async () => {
    const { work, rows, app } = harness();
    const chat = going({ kind: "chat", threadId: "thread-1" });
    const routine = going({ kind: "routine", agentId: "bot-2" });
    const theirs = going({ kind: "routine", userId: "someone-else" });
    const notMine = going({ kind: "chat", agentId: "someone-elses-bot" });
    for (const one of [chat, routine, theirs, notMine]) work.track(one.work);

    const response = await app.request("http://laf.local/api/me/stop-all", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stopped: counts({ chat: 1, routine: 1 }),
      notStopped: counts(),
      chats: { stopped: ["thread-1"], notStopped: [] },
    });
    expect([chat.stopped(), routine.stopped()]).toEqual([true, true]);
    expect([theirs.stopped(), notMine.stopped()]).toEqual([false, false]);

    // On the trail, as the person's own act, with what it reached — Bot ids and counts, no words.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "work.stopped_all",
      targetType: "user",
      targetId: OWNER,
      actorUserId: OWNER,
      payload: {
        actor: OWNER,
        stopped: counts({ chat: 1, routine: 1 }),
        bots: ["bot-1", "bot-2"],
      },
    });
  });

  test("says what it found and could not stop, rather than counting it as stopped", async () => {
    const { work, rows, app } = harness();
    const stuck = going(
      { kind: "chat", threadId: "thread-9" },
      async () => false,
    );
    work.track(stuck.work);

    const response = await app.request("http://laf.local/api/me/stop-all", {
      method: "POST",
    });
    expect(await response.json()).toEqual({
      stopped: counts(),
      notStopped: counts({ chat: 1 }),
      chats: { stopped: [], notStopped: ["thread-9"] },
    });
    expect(rows[0]?.payload).toMatchObject({ notStopped: counts({ chat: 1 }) });
  });

  test("work that ended on its own while it was being reached is neither stopped nor stuck", async () => {
    const { work, app } = harness();
    let done = () => {};
    const finishing = going({ kind: "routine" }, async () => {
      // It finished between being listed and being stopped: its listing is gone.
      done();
      return false;
    });
    done = work.track(finishing.work);

    const response = await app.request("http://laf.local/api/me/stop-all", {
      method: "POST",
    });
    expect(await response.json()).toEqual({
      stopped: counts(),
      notStopped: counts(),
      chats: { stopped: [], notStopped: [] },
    });
  });

  test("a stop that throws is a stop that did not happen", async () => {
    const { work, app } = harness();
    work.track(
      going({ kind: "room", agentId: null }, async () => {
        throw new Error("the database is down");
      }).work,
    );
    const response = await app.request("http://laf.local/api/me/stop-all", {
      method: "POST",
    });
    expect(await response.json()).toMatchObject({
      notStopped: counts({ room: 1 }),
    });
  });

  test("the press is on the trail even when nothing was running", async () => {
    // "She pressed it and nothing was running" is a fact worth having, as the computer's stop says.
    const { rows, app } = harness();
    const response = await app.request("http://laf.local/api/me/stop-all", {
      method: "POST",
    });
    expect(await response.json()).toEqual({
      stopped: counts(),
      notStopped: counts(),
      chats: { stopped: [], notStopped: [] },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ stopped: counts(), bots: [] });
    expect(rows[0]?.payload).not.toHaveProperty("notStopped");
  });

  test("a trail that cannot be written does not undo the stop", async () => {
    const work = createWorkInFlight();
    const chat = going({ kind: "chat", threadId: "thread-1" });
    work.track(chat.work);
    const app = surface(
      createStopAll({
        work,
        auditStore: {
          insert: async () => {
            throw new Error("the trail is down");
          },
        },
      }),
    );
    const response = await app.request("http://laf.local/api/me/stop-all", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(chat.stopped()).toBe(true);
  });
});

describe("the door itself", () => {
  test("is not there on a deployment that wired nothing to stop", async () => {
    const app = surface(undefined);
    expect((await app.request("http://laf.local/api/me/running")).status).toBe(
      404,
    );
    expect(
      (
        await app.request("http://laf.local/api/me/stop-all", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  });

  test("asks who is there before anything else", async () => {
    const work = createWorkInFlight();
    const args: Parameters<typeof createApp> = [
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: async () => null },
      },
      roles,
    ];
    args[46] = createStopAll({ work });
    const app = createApp(...args);
    const chat = going({ kind: "chat" });
    work.track(chat.work);

    const response = await app.request("http://laf.local/api/me/stop-all", {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(chat.stopped()).toBe(false);
  });
});
