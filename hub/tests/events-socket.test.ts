import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PING_FRAME, PONG_FRAME } from "../../shared/channel-socket";
import type { HubMe } from "../../shared/hub/protocol";
import { emitEvent } from "../src/events";
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
  hub = await startTestHub({ heartbeatMs: 100 });
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
