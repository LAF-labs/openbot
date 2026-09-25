import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { FRAME_MAX_BASE64, isKeepableFrame } from "../src/channels/frames";
import type { AgentChannel, ChannelStore } from "../src/channels/routes";
import { createChannelRoutes } from "../src/channels/routes";

/**
 * THE LAST PICTURE OF A BROWSING TASK, AT THE DOOR.
 *
 * The surface makes the picture and the server keeps it, so what the door checks is everything that
 * stands between a small JPEG and a column somebody could fill with anything: that it is a JPEG,
 * that it is small, that the conversation is the asker's, and that a miss is said as a miss.
 */

const actor = { id: "user-1", email: "member@laf.test", role: "user" } as const;

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

/** The start of a real JPEG (`FF D8 FF E0`), as base64 writes it, padded to a plausible length. */
const JPEG = `/9j/4AAQSkZJRgABAQ${"A".repeat(400)}`;

function channel(id: string): AgentChannel {
  return {
    id,
    name: "Bot",
    agentIds: ["agent-1"],
    threadId: `thread-of-${id}`,
    active: true,
  };
}

function routes(overrides: Partial<ChannelStore> = {}) {
  const kept = new Map<string, string>();
  const store: ChannelStore = {
    create: async () => channel("c"),
    get: async (_actor, id) => (id === "mine" ? channel(id) : null),
    list: async () => [],
    setLastRead: async (_actor, _id, at) => ({ previous: null, at }),
    recordActivity: async () => {},
    frameFor: async (threadId, toolCallId) =>
      kept.get(`${threadId}/${toolCallId}`) ?? null,
    framedCalls: async (threadId) =>
      [...kept.keys()]
        .filter((key) => key.startsWith(`${threadId}/`))
        .map((key) => key.slice(threadId.length + 1)),
    keepFrame: async (threadId, toolCallId, frame) => {
      if (toolCallId === "not-yet" || toolCallId === "never") return false;
      kept.set(`${threadId}/${toolCallId}`, frame);
      return true;
    },
    holdsCall: async (_threadId, toolCallId) => toolCallId === "not-yet",
    ...overrides,
  };
  return { app: createChannelRoutes(store, requireUser), kept };
}

const put = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("what counts as a picture", () => {
  test("a base64 JPEG under the cap is kept, and nothing else is", () => {
    expect(isKeepableFrame(JPEG)).toBe(true);
    // A PNG is what the screenshot route returns: sent as it came, it is ten times the size.
    expect(isKeepableFrame(`iVBORw0KGgo${"A".repeat(40)}`)).toBe(false);
    expect(isKeepableFrame(`/9j/${"A".repeat(FRAME_MAX_BASE64)}`)).toBe(false);
    expect(isKeepableFrame("/9j/<script>")).toBe(false);
    expect(isKeepableFrame(`data:image/jpeg;base64,${JPEG}`)).toBe(false);
    expect(isKeepableFrame(42)).toBe(false);
    expect(isKeepableFrame(undefined)).toBe(false);
  });
});

describe("keeping and reading it", () => {
  test("a kept picture comes back as the image itself, privately cached", async () => {
    const { app, kept } = routes();
    const saved = await app.request("/mine/frames/call-9", put({ jpeg: JPEG }));
    expect(saved.status).toBe(204);
    // On the thread behind the channel, never on a thread named by the asker.
    expect([...kept.keys()]).toEqual(["thread-of-mine/call-9"]);

    const read = await app.request("/mine/frames/call-9");
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/jpeg");
    expect(read.headers.get("cache-control")).toContain("private");
    const bytes = new Uint8Array(await read.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  });

  test("a picture that is not one is refused before anything is looked up", async () => {
    let looked = false;
    const { app } = routes({
      get: async () => {
        looked = true;
        return channel("mine");
      },
    });
    const refused = await app.request(
      "/mine/frames/call-9",
      put({ jpeg: "iVBORw0KGgoAAAANSUhEUg" }),
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "laf:frame_invalid" });
    expect(looked).toBe(false);
  });

  test("somebody else's conversation is not found, whichever way it is asked", async () => {
    const { app, kept } = routes();
    const saved = await app.request(
      "/theirs/frames/call-9",
      put({ jpeg: JPEG }),
    );
    expect(saved.status).toBe(404);
    expect(await saved.json()).toMatchObject({ code: "laf:channel_not_found" });
    expect(kept.size).toBe(0);
    expect((await app.request("/theirs/frames/call-9")).status).toBe(404);
  });

  /*
   * EARLY IS NOT AN ERROR (0.5.4 final QA): a step stopped while its window was making it has its
   * result only in that window until the next turn, and each 404 the surface retried on was a line
   * in the console. A call the thread does not hold is still a miss.
   */
  test("a call whose result is not in the thread yet is early, and one it does not hold is a miss", async () => {
    const { app, kept } = routes();
    const early = await app.request(
      "/mine/frames/not-yet",
      put({ jpeg: JPEG }),
    );
    expect(early.status).toBe(202);
    expect(await early.json()).toEqual({ waiting: true });
    expect(kept.size).toBe(0);
    const never = await app.request("/mine/frames/never", put({ jpeg: JPEG }));
    expect(never.status).toBe(404);
    expect(await never.json()).toMatchObject({ code: "laf:frame_not_found" });
    // A store that cannot tell says a miss, as before.
    const bare = routes({ holdsCall: undefined });
    expect(
      (await bare.app.request("/mine/frames/not-yet", put({ jpeg: JPEG })))
        .status,
    ).toBe(404);
  });

  /*
   * THE OTHER WINDOWS HEAR OF IT (0.5.4 final QA): only the window that ran the task keeps the
   * picture, and every other one drew the card from a list read before it existed.
   */
  test("a kept picture is told to the person's windows, and an early or missing one is not", async () => {
    const frames: Record<string, unknown>[] = [];
    const hub = {
      register: () => () => {},
      closeFor: () => 0,
      deliver: () => {},
      deliverFrame: (frame: Record<string, unknown>) => {
        frames.push(frame);
      },
      connectionCount: () => 0,
    };
    const kept = new Map<string, string>();
    const app = createChannelRoutes(
      {
        create: async () => channel("c"),
        get: async (_actor, id) => (id === "mine" ? channel(id) : null),
        list: async () => [],
        setLastRead: async (_actor, _id, at) => ({ previous: null, at }),
        recordActivity: async () => {},
        keepFrame: async (threadId, toolCallId, frame) => {
          if (toolCallId !== "call-9") return false;
          kept.set(`${threadId}/${toolCallId}`, frame);
          return true;
        },
        holdsCall: async (_threadId, toolCallId) => toolCallId === "not-yet",
      },
      requireUser,
      hub,
    );
    expect(
      (await app.request("/mine/frames/not-yet", put({ jpeg: JPEG }))).status,
    ).toBe(202);
    expect(
      (await app.request("/mine/frames/never", put({ jpeg: JPEG }))).status,
    ).toBe(404);
    expect(frames).toEqual([]);
    expect(
      (await app.request("/mine/frames/call-9", put({ jpeg: JPEG }))).status,
    ).toBe(204);
    expect(frames).toEqual([
      {
        kind: "frame_kept",
        memberIds: [actor.id],
        channelId: "mine",
        toolCallId: "call-9",
      },
    ]);
  });

  test("a miss is not cached, so the picture shows once it is kept", async () => {
    const { app } = routes();
    const missing = await app.request("/mine/frames/call-1");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
  });

  /*
   * THE LIST, SO A CARD ASKS ONLY WHERE THERE IS A PICTURE (0.5.4 QA): every ended card asked, and
   * each task without one was a 404 in the console.
   */
  test("lists the calls with a kept picture, and only in a conversation of theirs", async () => {
    const { app } = routes();
    expect(await (await app.request("/mine/frames")).json()).toEqual({
      toolCallIds: [],
    });
    await app.request("/mine/frames/call-1", put({ jpeg: JPEG }));
    expect(await (await app.request("/mine/frames")).json()).toEqual({
      toolCallIds: ["call-1"],
    });
    expect((await app.request("/theirs/frames")).status).toBe(404);
    const bare = routes({ framedCalls: undefined });
    expect(await (await bare.app.request("/mine/frames")).json()).toEqual({
      toolCallIds: [],
    });
  });

  test("a store without pictures answers every one as absent", async () => {
    const { app } = routes({ frameFor: undefined, keepFrame: undefined });
    expect((await app.request("/mine/frames/call-1")).status).toBe(404);
    expect(
      (await app.request("/mine/frames/call-1", put({ jpeg: JPEG }))).status,
    ).toBe(404);
  });
});
