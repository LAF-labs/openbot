import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  type HubRoom,
  type HubRoomMessages,
  type HubRooms,
  type HubSync,
  roomMessageRef,
} from "../../shared/hub/protocol";
import { hubAudit, hubEvents, hubMembers, hubMessages } from "../src/db/schema";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";
import { openSocket } from "./support/socket";

let hub: TestHub;
const ann = {
  email: "ann@example.com",
  vmOrigin: "https://ann.example",
  pass: newPass(),
};
const ben = {
  email: "ben@example.com",
  vmOrigin: "https://ben.example",
  pass: newPass(),
};
/** In the company, in none of the rooms below unless a test adds her. */
const cy = {
  email: "cy@example.com",
  vmOrigin: "https://cy.example",
  pass: newPass(),
};
/** An admin, outside the rooms too. */
const dee = {
  email: "dee@example.com",
  role: "admin" as const,
  vmOrigin: "https://dee.example",
  pass: newPass(),
};
let annId = "";
let benId = "";
let cyId = "";
let deeId = "";

beforeAll(async () => {
  hub = await startTestHub();
  annId = (await putMember(hub, ann)).id;
  benId = (await putMember(hub, ben)).id;
  cyId = (await putMember(hub, cy)).id;
  deeId = (await putMember(hub, dee)).id;
});
afterAll(() => hub.stop());

const call = (
  pass: string,
  method: string,
  path: string,
  body?: unknown,
  key: string | null = randomUUID(),
) =>
  fetch(`${hub.url}/hub/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${pass}`,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function makeRoom(pass: string, members: string[]): Promise<HubRoom> {
  const response = await call(pass, "POST", "/rooms", {
    name: "견적 방",
    members,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { room: HubRoom }).room;
}

async function post(
  pass: string,
  roomId: string,
  body: Record<string, unknown>,
  key: string = randomUUID(),
): Promise<Response> {
  return call(pass, "POST", `/rooms/${roomId}/messages`, body, key);
}

async function postedSeq(
  pass: string,
  roomId: string,
  body: Record<string, unknown>,
) {
  const response = await post(pass, roomId, body);
  expect(response.status).toBe(200);
  return ((await response.json()) as { seq: number }).seq;
}

async function head(pass: string): Promise<number> {
  const response = await fetch(`${hub.url}/hub/v1/me`, asMember(pass));
  return ((await response.json()) as { seq: number }).seq;
}

async function eventsAfter(pass: string, since: number) {
  const response = await fetch(
    `${hub.url}/hub/v1/sync?since=${since}`,
    asMember(pass),
  );
  return ((await response.json()) as HubSync).events;
}

async function messages(pass: string, roomId: string, query = "") {
  return fetch(
    `${hub.url}/hub/v1/rooms/${roomId}/messages${query}`,
    asMember(pass),
  );
}

describe("rooms: who is in them", () => {
  test("a room is listed and read only by its members; an outsider and an outside admin get 404", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    expect(room.members.toSorted()).toEqual([annId, benId].toSorted());
    await postedSeq(ann.pass, room.id, { text: "내일 견적 보내요" });

    const listed = async (pass: string) =>
      ((await (await call(pass, "GET", "/rooms")).json()) as HubRooms).rooms
        .map((each) => each.id)
        .includes(room.id);
    expect(await listed(ann.pass)).toBe(true);
    expect(await listed(ben.pass)).toBe(true);
    expect(await listed(cy.pass)).toBe(false);
    expect(await listed(dee.pass)).toBe(false);

    expect((await messages(ben.pass, room.id)).status).toBe(200);
    for (const outsider of [cy.pass, dee.pass]) {
      const read = await messages(outsider, room.id);
      expect(read.status).toBe(404);
      expect(await read.json()).toEqual({
        ok: false,
        code: "laf:hub_not_found",
      });
      expect((await post(outsider, room.id, { text: "끼어들기" })).status).toBe(
        404,
      );
    }
    // A room that does not exist answers the same as one the caller is not in.
    expect((await messages(cy.pass, "r_nothing")).status).toBe(404);
  });

  test("a message's event reaches the room's members and not the outsider", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    const start = await head(ann.pass);
    const seq = await postedSeq(ben.pass, room.id, { text: "확인했어요" });
    const ref = `${room.id}:${seq}`;
    const seen = async (pass: string) =>
      (await eventsAfter(pass, start))
        .filter((event) => event.type === "room.message")
        .map((event) => event.refId);
    expect(await seen(ann.pass)).toEqual([ref]);
    expect(await seen(ben.pass)).toEqual([ref]);
    expect(await seen(cy.pass)).toEqual([]);
  });

  test("an admin outside a room adds somebody, the room hears of it, and the newcomer reads it", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    const start = await head(ann.pass);
    const added = await call(dee.pass, "POST", `/rooms/${room.id}/members`, {
      members: [cyId],
    });
    expect(added.status).toBe(200);
    // Members made in one write share a time, so their order is not the test's business.
    expect(
      ((await added.json()) as { room: HubRoom }).room.members.toSorted(),
    ).toEqual([annId, benId, cyId].toSorted());
    const changed = (await eventsAfter(ann.pass, start)).filter(
      (event) => event.type === "room.changed",
    );
    expect(changed.map((event) => [event.refId, event.actor])).toEqual([
      [room.id, deeId],
    ]);
    expect((await messages(cy.pass, room.id)).status).toBe(200);
    // The admin added somebody else, not themself: still outside.
    expect((await messages(dee.pass, room.id)).status).toBe(404);
  });

  test("a plain member cannot add to a room they are not in", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    const refused = await call(cy.pass, "POST", `/rooms/${room.id}/members`, {
      members: [cyId],
    });
    expect(refused.status).toBe(404);
    expect((await messages(cy.pass, room.id)).status).toBe(404);
  });

  test("somebody leaves: they stop reading it, are told, and only the maker or an admin takes others out", async () => {
    const room = await makeRoom(ann.pass, [benId, cyId]);
    const refused = await call(
      ben.pass,
      "DELETE",
      `/rooms/${room.id}/members/${cyId}`,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      ok: false,
      code: "laf:hub_forbidden",
    });

    const start = await head(ben.pass);
    const left = await call(
      ben.pass,
      "DELETE",
      `/rooms/${room.id}/members/${benId}`,
    );
    expect(left.status).toBe(200);
    expect((await messages(ben.pass, room.id)).status).toBe(404);
    expect(
      (await eventsAfter(ben.pass, start))
        .filter((event) => event.type === "room.changed")
        .map((event) => event.refId),
    ).toEqual([room.id]);
    // After leaving, a message there is no event of theirs.
    const after = await head(ben.pass);
    await postedSeq(ann.pass, room.id, { text: "벤 없이" });
    expect(await eventsAfter(ben.pass, after)).toEqual([]);

    // The maker takes somebody else out.
    const out = await call(
      ann.pass,
      "DELETE",
      `/rooms/${room.id}/members/${cyId}`,
    );
    expect(((await out.json()) as { room: HubRoom }).room.members).toEqual([
      annId,
    ]);
  });

  test("a room is made only with members of the company", async () => {
    const response = await call(ann.pass, "POST", "/rooms", {
      name: "방",
      members: ["m_nobody"],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "members" });
  });

  test("leaving the company takes them out of every room; coming back does not put them back", async () => {
    const eve = {
      email: "eve@example.com",
      vmOrigin: "https://eve.example",
      pass: newPass(),
    };
    const eveId = (await putMember(hub, eve)).id;
    const room = await makeRoom(ann.pass, [eveId]);
    await postedSeq(ann.pass, room.id, { text: "이브 있을 때" });

    const start = await head(ann.pass);
    await putMember(hub, { ...eve, state: "left" });
    const rooms = (await (
      await call(ann.pass, "GET", "/rooms")
    ).json()) as HubRooms;
    expect(rooms.rooms.find((each) => each.id === room.id)?.members).toEqual([
      annId,
    ]);
    // The ones still in it hear the roster change, so their VMs redraw it.
    expect(
      (await eventsAfter(ann.pass, start))
        .filter((event) => event.type === "room.changed")
        .map((event) => event.refId),
    ).toEqual([room.id]);
    const seq = await postedSeq(ann.pass, room.id, { text: "이브 없이" });
    const said = await hub.database
      .select({ type: hubEvents.type, visibleTo: hubEvents.visibleTo })
      .from(hubEvents)
      .where(eq(hubEvents.refId, roomMessageRef(room.id, seq)));
    expect(said).toEqual([{ type: "room.message", visibleTo: [annId] }]);

    // Back with a new pass: the same member, in no room, reading none of it.
    const back = { ...eve, pass: newPass() };
    expect((await putMember(hub, back)).id).toBe(eveId);
    const theirs = (await (
      await call(back.pass, "GET", "/rooms")
    ).json()) as HubRooms;
    expect(theirs.rooms).toEqual([]);
    expect((await messages(back.pass, room.id)).status).toBe(404);
  });

  test("nobody is added to a room in the moment they leave the company", async () => {
    const fay = {
      email: "fay@example.com",
      vmOrigin: "https://fay.example",
      pass: newPass(),
    };
    const fayId = (await putMember(hub, fay)).id;
    const room = await makeRoom(ann.pass, []);
    // A departure holding her row, the way the registry's does, while the add arrives.
    let adding: Promise<Response> | undefined;
    await hub.database.transaction(async (tx) => {
      await tx
        .select({ id: hubMembers.id })
        .from(hubMembers)
        .where(eq(hubMembers.id, fayId))
        .for("update");
      await tx
        .update(hubMembers)
        .set({ state: "left", leftAt: new Date() })
        .where(eq(hubMembers.id, fayId));
      adding = call(ann.pass, "POST", `/rooms/${room.id}/members`, {
        members: [fayId],
      });
      // Until the add is waiting on her row.
      for (let tries = 0; tries < 200; tries++) {
        const [row] = await hub.database.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );
        if ((row?.n ?? 0) > 0) break;
        await Bun.sleep(10);
      }
    });
    const answer = await (adding as Promise<Response>);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toMatchObject({ field: "members" });
    const rooms = (await (
      await call(ann.pass, "GET", "/rooms")
    ).json()) as HubRooms;
    expect(rooms.rooms.find((each) => each.id === room.id)?.members).toEqual([
      annId,
    ]);
  });
});

describe("rooms: mentions", () => {
  test("@라피 is told to the author alone; a member mention to that member alone", async () => {
    const room = await makeRoom(ann.pass, [benId, cyId]);
    const start = await head(ann.pass);
    const asked = await postedSeq(ann.pass, room.id, {
      text: "@라피 지난주 견적 정리해줘",
      mentions: ["lafi"],
    });
    const named = await postedSeq(ann.pass, room.id, {
      text: "@벤 확인 부탁",
      mentions: [benId],
    });
    const mentionsFor = async (pass: string) =>
      (await eventsAfter(pass, start))
        .filter((event) => event.type === "room.mention")
        .map((event) => event.refId);
    expect(await mentionsFor(ann.pass)).toEqual([`${room.id}:${asked}`]);
    expect(await mentionsFor(ben.pass)).toEqual([`${room.id}:${named}`]);
    expect(await mentionsFor(cy.pass)).toEqual([]);
    // Every member still sees both messages.
    expect(
      (await eventsAfter(cy.pass, start)).filter(
        (event) => event.type === "room.message",
      ),
    ).toHaveLength(2);
  });

  test("the mention reaches the author's socket and no other", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    const start = await head(ann.pass);
    const forAnn = await openSocket(hub.url, ann.pass, `?since=${start}`);
    const forBen = await openSocket(hub.url, ben.pass, `?since=${start}`);
    try {
      const seq = await postedSeq(ann.pass, room.id, {
        text: "@라피 요약",
        mentions: ["lafi"],
      });
      const annFrames = await forAnn.events(2);
      expect(annFrames.map((frame) => frame.type)).toEqual([
        "room.message",
        "room.mention",
      ]);
      expect(annFrames[1]?.refId).toBe(`${room.id}:${seq}`);
      // Ben's socket gets the message; a later event proves nothing else was waiting before it.
      await postedSeq(ben.pass, room.id, { text: "네" });
      const benFrames = await forBen.events(2);
      expect(benFrames.map((frame) => frame.type)).toEqual([
        "room.message",
        "room.message",
      ]);
    } finally {
      forAnn.close();
      forBen.close();
    }
  });

  test("a 라피 posts as itself, and cannot call 라피", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    const refused = await post(ann.pass, room.id, {
      text: "@라피",
      as: "bot",
      mentions: ["lafi"],
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ field: "mentions" });

    const start = await head(ann.pass);
    const seq = await postedSeq(ann.pass, room.id, {
      text: "정리했어요",
      as: "bot",
      runId: "run-1",
      mentions: [annId],
    });
    const page = (await (
      await messages(ann.pass, room.id)
    ).json()) as HubRoomMessages;
    expect(page.messages.map((message) => [message.seq, message.by])).toEqual([
      [seq, `bot:${annId}`],
    ]);
    expect(page.messages[0]?.runId).toBe("run-1");
    // Its own person is told when the 라피 mentions them.
    expect(
      (await eventsAfter(ann.pass, start))
        .filter((event) => event.type === "room.mention")
        .map((event) => event.refId),
    ).toEqual([`${room.id}:${seq}`]);
  });

  test("a mention of somebody outside the room is refused, and nothing is posted", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    const refused = await post(ann.pass, room.id, {
      text: "@cy",
      mentions: [cyId],
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ field: "mentions" });
    const rows = await hub.database
      .select()
      .from(hubMessages)
      .where(eq(hubMessages.roomId, room.id));
    expect(rows).toEqual([]);
  });
});

describe("rooms: posting", () => {
  test("a post sent twice with one key is one message, one event, one answer", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    const start = await head(ben.pass);
    const key = randomUUID();
    const first = await post(ann.pass, room.id, { text: "한 번만" }, key);
    const again = await post(ann.pass, room.id, { text: "한 번만" }, key);
    const firstBody = await first.json();
    expect(await again.json()).toEqual(firstBody);
    expect(firstBody).toEqual({ ok: true, seq: 1 });
    const rows = await hub.database
      .select()
      .from(hubMessages)
      .where(eq(hubMessages.roomId, room.id));
    expect(rows.map((row) => row.seq)).toEqual([1]);
    expect(
      (await eventsAfter(ben.pass, start)).filter(
        (event) => event.type === "room.message",
      ),
    ).toHaveLength(1);
  });

  test("a post without an idempotency key is refused", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    const response = await call(
      ann.pass,
      "POST",
      `/rooms/${room.id}/messages`,
      { text: "열쇠 없이" },
      null,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field: "idempotencyKey" });
  });

  test.each([
    ["empty", { text: "   " }, "text"],
    ["too long", { text: "가".repeat(4_001) }, "text"],
    ["an unknown author", { text: "a", as: "boss" }, "as"],
    ["mentions not a list", { text: "a", mentions: "lafi" }, "mentions"],
  ])("refuses a message that is %s", async (_name, body, field) => {
    const room = await makeRoom(ann.pass, [benId]);
    const response = await post(ann.pass, room.id, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ field });
  });

  test("takes a message at the limit", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    expect(
      (await post(ann.pass, room.id, { text: "가".repeat(4_000) })).status,
    ).toBe(200);
  });

  test("the trail says who posted where, and holds no text and no room name", async () => {
    const room = await makeRoom(ann.pass, [benId]);
    const secret = `비밀 단가 ${randomUUID()}`;
    const seq = await postedSeq(ann.pass, room.id, {
      text: secret,
      mentions: [benId],
      runId: "run-trail",
    });
    const rows = await hub.database
      .select()
      .from(hubAudit)
      .where(eq(hubAudit.member, annId));
    const posted = rows.filter((row) => row.target === `${room.id}:${seq}`);
    expect(
      posted.map((row) => [row.action, row.runId, row.vmOrigin, row.payload]),
    ).toEqual([
      [
        "room.message_posted",
        "run-trail",
        ann.vmOrigin,
        { as: "member", chars: secret.length, mentions: [benId], files: 0 },
      ],
    ]);
    const whole = JSON.stringify(rows);
    expect(whole).not.toContain(secret);
    expect(whole).not.toContain("견적 방");
  });
});

describe("rooms: reading", () => {
  let roomId = "";
  beforeAll(async () => {
    roomId = (await makeRoom(ann.pass, [benId])).id;
    for (let index = 1; index <= 5; index += 1) {
      await postedSeq(ann.pass, roomId, { text: `글 ${index}` });
    }
  });

  const page = async (query: string) => {
    const response = await messages(ben.pass, roomId, query);
    expect(response.status).toBe(200);
    const body = (await response.json()) as HubRoomMessages;
    return {
      seqs: body.messages.map((message) => message.seq),
      seq: body.seq,
      more: body.more,
    };
  };

  test("pages forward from a cursor and says when there is more", async () => {
    expect(await page("?since=0&limit=2")).toEqual({
      seqs: [1, 2],
      seq: 2,
      more: true,
    });
    expect(await page("?since=2&limit=2")).toEqual({
      seqs: [3, 4],
      seq: 4,
      more: true,
    });
    expect(await page("?since=4&limit=2")).toEqual({
      seqs: [5],
      seq: 5,
      more: false,
    });
    expect(await page("?since=5")).toEqual({ seqs: [], seq: 5, more: false });
  });

  test("with no cursor reads the newest page, and reads back before one", async () => {
    expect(await page("?limit=2")).toEqual({
      seqs: [4, 5],
      seq: 5,
      more: true,
    });
    expect(await page("?before=4&limit=2")).toEqual({
      seqs: [2, 3],
      seq: 3,
      more: true,
    });
    expect(await page("?before=2&limit=2")).toEqual({
      seqs: [1],
      seq: 1,
      more: false,
    });
  });

  test.each([
    ["?since=-1"],
    ["?limit=0"],
    ["?since=abc"],
    ["?since=1&before=3"],
  ])("refuses the query %s", async (query) => {
    expect((await messages(ben.pass, roomId, query)).status).toBe(400);
  });
});
