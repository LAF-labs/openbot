import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import {
  newPass,
  putMember,
  sendFleet,
  startTestHub,
  type TestHub,
} from "../../hub/tests/support/hub";
import { createDatabase } from "../src/db/client";
import { hubCursor } from "../src/db/schema";
import { createHubHttp, type HubHttp } from "../src/hub/http";
import {
  createHubLink,
  type HubFrame,
  type HubLink,
  type HubLinkTiming,
} from "../src/hub/link";
import { TEST_POOL } from "./support/database";

/**
 * The VM's line to a real hub — the one in `hub/`, served on port 0 against a database of its own —
 * so what is proven is the contract both ends were written to, not a fake of it: `/me`, the socket
 * with its catch-up, the cursor kept in `hub_cursor`, a departure's 4401 and a refused pass.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const FAST: HubLinkTiming = {
  firstRetryMs: 50,
  maxRetryMs: 200,
  pollMs: 100,
  silenceMs: 30_000,
};

let hub: TestHub;
const links: HubLink[] = [];

beforeAll(async () => {
  hub = await startTestHub();
  const response = await sendFleet(hub, {
    event: "workspace.put",
    workspace: { name: "라프상사" },
  });
  expect(response.status).toBe(200);
});

/*
 * Every line stopped between tests: the lines in one test stand for different VMs but share this
 * database's one cursor row, so a line left running would move the place the next test reads.
 */
afterEach(() => {
  for (const link of links.splice(0)) link.stop();
});

afterAll(async () => {
  await database.delete(hubCursor).where(eq(hubCursor.hub, hub.url));
  await hub.stop();
  await database.$client.close();
});

/** A VM: its pass registered at the hub as a member, and a line from it. */
function vm(pass: string, options: { http?: HubHttp } = {}) {
  const frames: HubFrame[] = [];
  const http =
    options.http ??
    createHubHttp({ url: hub.url, vmKey: pass, sleep: async () => {} });
  const link = createHubLink({
    database,
    http,
    hub: hub.url,
    deliver: (frame) => frames.push(frame),
    timing: FAST,
  });
  links.push(link);
  return { link, frames };
}

async function until(check: () => boolean, ms = 2_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`waited ${ms} ms`);
    await Bun.sleep(10);
  }
}

const eventsIn = (frames: HubFrame[]) =>
  frames.filter((frame) => frame.kind === "hub.member.changed") as {
    kind: string;
    seq: number;
    refId: string | null;
  }[];

describe("the line to the company hub", () => {
  test("two VMs connect, know their company, and hear each other's change within a second", async () => {
    const passA = newPass();
    const passB = newPass();
    await putMember(hub, {
      email: "a@laf.test",
      name: "김",
      vmOrigin: "https://a.agent.test",
      pass: passA,
    });
    const b = await putMember(hub, {
      email: "b@laf.test",
      vmOrigin: "https://b.agent.test",
      pass: passB,
    });
    const a = vm(passA);
    const other = vm(passB);
    a.link.start();
    other.link.start();
    await until(
      () =>
        a.link.status().state === "connected" &&
        other.link.status().state === "connected",
    );
    expect(a.link.status()).toMatchObject({
      state: "connected",
      code: null,
      workspace: { name: "라프상사" },
      member: { role: "member", name: "김" },
    });
    // The app heard the line come up.
    expect(a.frames.some((frame) => frame.kind === "hub.status")).toBe(true);

    // B's member row changes at the hub; both lines hear it, A within a second.
    const changed = Date.now();
    const put = await putMember(hub, {
      email: "b@laf.test",
      name: "박",
      vmOrigin: "https://b.agent.test",
      pass: passB,
    });
    await until(
      () => eventsIn(a.frames).some((frame) => frame.seq === put.seq),
      1_000,
    );
    expect(Date.now() - changed).toBeLessThan(1_000);
    await until(() =>
      eventsIn(other.frames).some((frame) => frame.seq === put.seq),
    );
    expect(eventsIn(a.frames).at(-1)).toMatchObject({
      kind: "hub.member.changed",
      seq: put.seq,
      refId: b.id,
    });

    // The place is kept, so the next boot starts after it.
    const kept = async () => {
      const [row] = await database
        .select()
        .from(hubCursor)
        .where(eq(hubCursor.hub, hub.url));
      return Number(row?.seq);
    };
    for (let tries = 0; tries < 100 && (await kept()) !== put.seq; tries += 1) {
      await Bun.sleep(10);
    }
    expect(await kept()).toBe(put.seq ?? -1);
  });

  test("a line started after a gap is told what it missed, from its cursor", async () => {
    const pass = newPass();
    await putMember(hub, {
      email: "c@laf.test",
      vmOrigin: "https://c.agent.test",
      pass,
    });
    const first = vm(pass);
    first.link.start();
    await until(() => first.link.status().state === "connected");
    first.link.stop();

    // While no line is up: a member joins.
    const missed = await putMember(hub, {
      email: "d@laf.test",
      vmOrigin: "https://d.agent.test",
      pass: newPass(),
    });
    const second = vm(pass);
    second.link.start();
    await until(() =>
      eventsIn(second.frames).some((frame) => frame.seq === missed.seq),
    );
    expect(
      eventsIn(second.frames).find((f) => f.seq === missed.seq),
    ).toMatchObject({
      refId: missed.id,
    });
  });

  test("a cursor that cannot be read once is not taken for none: what was missed still arrives", async () => {
    const pass = newPass();
    await putMember(hub, {
      email: "e@laf.test",
      vmOrigin: "https://e.agent.test",
      pass,
    });
    const first = vm(pass);
    first.link.start();
    await until(() => first.link.status().state === "connected");
    first.link.stop();

    const missed = await putMember(hub, {
      email: "f@laf.test",
      vmOrigin: "https://f.agent.test",
      pass: newPass(),
    });
    // The VM's database refuses the line's first read of its place, and only that one.
    let refusals = 1;
    const flaky = new Proxy(database, {
      get(target, key, receiver) {
        if (key === "select" && refusals > 0) {
          refusals -= 1;
          return () => {
            throw new Error("connection reset");
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const frames: HubFrame[] = [];
    const link = createHubLink({
      database: flaky,
      http: createHubHttp({ url: hub.url, vmKey: pass, sleep: async () => {} }),
      hub: hub.url,
      deliver: (frame) => frames.push(frame),
      timing: FAST,
    });
    links.push(link);
    link.start();
    await until(() =>
      eventsIn(frames).some((frame) => frame.seq === missed.seq),
    );
    expect(refusals).toBe(0);
    expect(eventsIn(frames).find((f) => f.seq === missed.seq)).toMatchObject({
      refId: missed.id,
    });
  });

  test("a pass the hub does not know is refused once, said once, and not asked again", async () => {
    const real = createHubHttp({
      url: hub.url,
      vmKey: newPass(),
      sleep: async () => {},
    });
    let asked = 0;
    const counting: HubHttp = {
      request: (request) => {
        asked += 1;
        return real.request(request);
      },
      socket: real.socket,
    };
    const stranger = vm("unused", { http: counting });
    stranger.link.start();
    await until(() => stranger.link.status().state === "refused");
    expect(stranger.link.status()).toMatchObject({
      state: "refused",
      code: "laf:hub_pass_refused",
    });
    // Twenty backoffs' worth of waiting, and no second knock.
    await Bun.sleep(FAST.maxRetryMs * 2);
    expect(asked).toBe(1);
    expect(
      stranger.frames.filter((frame) => frame.kind === "hub.status"),
    ).toHaveLength(1);
  });

  test("a member who leaves is let go by the hub, and the line stops instead of knocking", async () => {
    const pass = newPass();
    await putMember(hub, {
      email: "e@laf.test",
      vmOrigin: "https://e.agent.test",
      pass,
    });
    const real = createHubHttp({
      url: hub.url,
      vmKey: pass,
      sleep: async () => {},
    });
    const asked: string[] = [];
    const counting: HubHttp = {
      request: (request) => {
        asked.push(request.path);
        return real.request(request);
      },
      socket: real.socket,
    };
    const leaving = vm(pass, { http: counting });
    leaving.link.start();
    await until(() => leaving.link.status().state === "connected");
    const before = asked.length;
    await putMember(hub, {
      email: "e@laf.test",
      vmOrigin: "https://e.agent.test",
      pass,
      state: "left",
    });
    await until(() => leaving.link.status().state === "refused");
    expect(leaving.link.status().code).toBe("laf:hub_pass_refused");
    // The hub's 4401 is the answer: the line does not ask /me to be told the same thing.
    expect(asked.slice(before)).toEqual([]);
  });

  test("a door that takes the socket and drops it at once is not knocked on faster for it", async () => {
    const pass = newPass();
    await putMember(hub, {
      email: "f@laf.test",
      vmOrigin: "https://f.agent.test",
      pass,
    });
    const real = createHubHttp({
      url: hub.url,
      vmKey: pass,
      sleep: async () => {},
    });
    const asked: number[] = [];
    const counting: HubHttp = {
      request: (request) => {
        // `/me` only: each attempt starts with one. `/sync` is the poll between.
        if (request.path === "/me") asked.push(Date.now());
        return real.request(request);
      },
      socket: real.socket,
    };
    // Opens, then closes on the next tick: what a front door with its hub down did, live.
    const flapping = (() => {
      const socket = {
        onopen: null as null | (() => void),
        onclose: null as null | ((event: { code: number }) => void),
        onmessage: null,
        onerror: null,
        send() {},
        close() {},
      };
      setTimeout(() => {
        socket.onopen?.();
        setTimeout(() => socket.onclose?.({ code: 1011 }), 0);
      }, 0);
      return socket as unknown as WebSocket;
    }) as () => WebSocket;
    const link = createHubLink({
      database,
      http: counting,
      hub: hub.url,
      deliver: () => {},
      timing: FAST,
      openSocket: flapping,
    });
    links.push(link);
    link.start();
    await Bun.sleep(700);
    link.stop();
    // Waits of 50, 100, 200, 200 ms: about five asks in 700 ms. Reset on every open, it was fourteen.
    expect(asked.length).toBeLessThanOrEqual(6);
    expect(asked.length).toBeGreaterThanOrEqual(2);
  });

  test("a hub that does not answer leaves the line disconnected and trying", async () => {
    const nowhere = Bun.serve({ port: 0, fetch: () => new Response() });
    const url = `http://localhost:${nowhere.port}`;
    void nowhere.stop(true);
    let asked = 0;
    const real = createHubHttp({
      url,
      vmKey: newPass(),
      sleep: async () => {},
    });
    const counting: HubHttp = {
      request: (request) => {
        asked += 1;
        return real.request(request);
      },
      socket: real.socket,
    };
    const away = vm("unused", { http: counting });
    away.link.start();
    await until(() => away.link.status().state === "disconnected");
    expect(away.link.status().code).toBe("laf:hub_unreachable");
    // Still trying: the backoff asks /me again, and /sync is polled between.
    await until(() => asked >= 3);
    away.link.stop();
  });
});
