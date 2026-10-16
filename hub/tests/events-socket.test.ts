import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PING_FRAME, PONG_FRAME } from "../../shared/channel-socket";
import type { HubMe } from "../../shared/hub/protocol";
import { emitEvent } from "../src/events";
import { startPings } from "../src/socket";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";
import { openSocket } from "./support/socket";

let hub: TestHub;
const amy = {
  email: "amy@example.com",
  vmOrigin: "https://amy.example",
  pass: newPass(),
};
const bo = {
  email: "bo@example.com",
  vmOrigin: "https://bo.example",
  pass: newPass(),
};
let amyId = "";
let boId = "";

beforeAll(async () => {
  hub = await startTestHub({ heartbeatMs: 100, rotationGraceMs: 400 });
  amyId = (await putMember(hub, amy)).id;
  boId = (await putMember(hub, bo)).id;
});
afterAll(() => hub.stop());

const head = async (pass: string) =>
  (
    (await (
      await fetch(`${hub.url}/hub/v1/me`, asMember(pass))
    ).json()) as HubMe
  ).seq;

describe("the events socket", () => {
  test("delivers another member's registry change while it happens", async () => {
    const socket = await openSocket(hub.url, bo.pass);
    try {
      const started = performance.now();
      const { seq } = await putMember(hub, { ...amy, name: "Amy" });
      const [event] = await socket.events(1, 1_000);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(event).toMatchObject({
        kind: "event",
        seq,
        type: "member.changed",
        refId: amyId,
      });
    } finally {
      socket.close();
    }
  });

  test("a reconnect with since= gets exactly the events it missed, in order", async () => {
    const first = await openSocket(hub.url, bo.pass);
    const { seq: before } = await putMember(hub, { ...amy, name: "Amy 1" });
    await first.events(1);
    first.close();
    await first.closed;

    const missed = [
      (await putMember(hub, { ...amy, name: "Amy 2" })).seq,
      (await putMember(hub, { ...amy, name: "Amy 3" })).seq,
    ];
    const again = await openSocket(hub.url, bo.pass, `?since=${before}`);
    try {
      const caught = await again.events(2);
      expect(caught.map((frame) => frame.seq)).toEqual(missed);
      const live = (await putMember(hub, { ...amy, name: "Amy 4" })).seq;
      const [, , next] = await again.events(3);
      expect(next?.seq).toBe(live);
      // Nothing twice: the catch-up and the live tail are one cursor.
      const seqs = again.frames
        .filter((frame) => frame.kind === "event")
        .map((f) => f.seq);
      expect(seqs).toEqual([...missed, live]);
    } finally {
      again.close();
    }
  });

  test("an event for one member reaches only that member", async () => {
    const start = await head(amy.pass);
    const forAmy = await openSocket(hub.url, amy.pass, `?since=${start}`);
    const forBo = await openSocket(hub.url, bo.pass, `?since=${start}`);
    try {
      const hidden = await hub.database.transaction((tx) =>
        emitEvent(tx, {
          type: "member.changed",
          refId: "only-amy",
          visibleTo: [amyId],
        }),
      );
      const shared = (await putMember(hub, { ...bo, name: "Bo" })).seq;
      expect((await forAmy.events(2)).map((frame) => frame.seq)).toEqual([
        hidden,
        shared,
      ]);
      expect((await forBo.events(1)).map((frame) => frame.seq)).toEqual([
        shared,
      ]);
      expect(forBo.frames.some((frame) => frame.refId === "only-amy")).toBe(
        false,
      );
    } finally {
      forAmy.close();
      forBo.close();
    }
  });

  test("pings, answers a ping with a pong, and lets a silent VM go", async () => {
    const socket = await openSocket(hub.url, amy.pass);
    socket.send(PING_FRAME);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const kinds = socket.frames.map((frame) => frame.kind);
      if (kinds.includes("pong") && kinds.includes("ping")) break;
      await Bun.sleep(20);
    }
    expect(socket.frames.map((frame) => frame.kind)).toContain(
      JSON.parse(PONG_FRAME).kind,
    );
    expect(socket.frames.map((frame) => frame.kind)).toContain("ping");
    // It answers nothing after that, so three intervals on the hub closes it.
    expect(await socket.closed).toEqual({
      code: 4408,
      reason: "laf:heartbeat_missed",
    });
  });

  test("a member who leaves has their socket closed", async () => {
    const cy = {
      email: "cy@example.com",
      vmOrigin: "https://cy.example",
      pass: newPass(),
    };
    await putMember(hub, cy);
    const socket = await openSocket(hub.url, cy.pass);
    await putMember(hub, { ...cy, state: "left" });
    expect(await socket.closed).toEqual({
      code: 4401,
      reason: "laf:hub_pass_refused",
    });
  });

  test("a socket opened before a rotation closes when the old pass's grace ends, not before", async () => {
    const dee = {
      email: "dee@example.com",
      vmOrigin: "https://dee.example",
      pass: newPass(),
    };
    await putMember(hub, dee);
    const socket = await openSocket(hub.url, dee.pass, "", {
      answerPings: true,
    });
    const rotatedAt = performance.now();
    const { seq } = await putMember(hub, { ...dee, pass: newPass() });
    // Still open through the grace: it is told about its own rotation.
    expect((await socket.events(1)).map((frame) => frame.seq)).toEqual([seq]);
    const ended = await Promise.race([
      socket.closed,
      Bun.sleep(3_000).then(() => "still open"),
    ]);
    expect(ended).toEqual({ code: 4401, reason: "laf:hub_pass_refused" });
    expect(performance.now() - rotatedAt).toBeGreaterThanOrEqual(300);
  });

  test("a socket opened inside the grace with the old pass closes when it ends; the new pass's stays", async () => {
    const eve = {
      email: "eve@example.com",
      vmOrigin: "https://eve.example",
      pass: newPass(),
    };
    await putMember(hub, eve);
    const next = newPass();
    await putMember(hub, { ...eve, pass: next });
    const onOld = await openSocket(hub.url, eve.pass, "", {
      answerPings: true,
    });
    const onNew = await openSocket(hub.url, next, "", { answerPings: true });
    try {
      const ended = await Promise.race([
        onOld.closed,
        Bun.sleep(3_000).then(() => "still open"),
      ]);
      expect(ended).toEqual({ code: 4401, reason: "laf:hub_pass_refused" });
      onNew.send(PING_FRAME);
      const deadline = Date.now() + 2_000;
      while (
        !onNew.frames.some((frame) => frame.kind === "pong") &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      expect(onNew.frames.map((frame) => frame.kind)).toContain("pong");
    } finally {
      onNew.close();
    }
  });

  test("a second rotation closes a socket on the pass it drops at once, and leaves the grace pass's", async () => {
    // A grace far longer than the test, so only the rotation itself can close the first socket.
    const slow = await startTestHub({
      heartbeatMs: 100,
      rotationGraceMs: 60_000,
    });
    try {
      const gil = {
        email: "gil@example.com",
        vmOrigin: "https://gil.example",
        pass: newPass(),
      };
      await putMember(slow, gil);
      const second = newPass();
      await putMember(slow, { ...gil, pass: second });
      const onFirst = await openSocket(slow.url, gil.pass, "", {
        answerPings: true,
      });
      const onSecond = await openSocket(slow.url, second, "", {
        answerPings: true,
      });
      const { seq } = await putMember(slow, { ...gil, pass: newPass() });
      const ended = await Promise.race([
        onFirst.closed,
        Bun.sleep(3_000).then(() => "still open"),
      ]);
      expect(ended).toEqual({ code: 4401, reason: "laf:hub_pass_refused" });
      // The pass still in its grace keeps its socket, and hears the rotation.
      expect((await onSecond.events(1)).map((frame) => frame.seq)).toEqual([
        seq,
      ]);
      onSecond.close();
    } finally {
      await slow.stop();
    }
  });

  test("a ping that throws stays inside the timer, and silence still ends the socket once", async () => {
    let clock = 0;
    let pinged = 0;
    let silent = 0;
    const pings = startPings({
      everyMs: 5,
      now: () => clock,
      ping: () => {
        pinged += 1;
        throw new Error("socket is closing");
      },
      onSilent: () => {
        silent += 1;
        throw new Error("socket is closing");
      },
    });
    while (pinged < 2) await Bun.sleep(5);
    clock = 1_000;
    while (silent < 1) await Bun.sleep(5);
    const after = pinged;
    await Bun.sleep(30);
    expect(silent).toBe(1);
    // Stopped once silent: no ping after the close.
    expect(pinged).toBe(after);
    pings.stop();
  });

  test("without a good pass there is no socket", async () => {
    await expect(openSocket(hub.url, newPass())).rejects.toThrow(
      "socket refused",
    );
    const response = await fetch(`${hub.url}/hub/v1/events`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${newPass()}` },
    });
    expect(response.status).toBe(401);
    expect(boId).not.toBe("");
  });
});
