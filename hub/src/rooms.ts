import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  HUB_FACTS,
  HUB_HEADERS,
  HUB_LAFI_MENTION,
  HUB_ROOM_LIMITS,
  type HubRoom,
  type HubRoomMessage,
  type HubRoomMessages,
  type HubRoomPost,
  type HubRooms,
  roomMessageRef,
} from "../../shared/hub/protocol";
import { recordAudit } from "./audit";
import type { AuthedMember, MemberVariables } from "./auth";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubMembers, hubMessages, hubRoomMembers, hubRooms } from "./db/schema";
import { emitEvent, type Listeners } from "./events";
import { type Answer, IDEMPOTENCY_KEY_SHAPE, onceFor } from "./idempotency";

/**
 * The company's group chat: rooms, who is in each, and the messages.
 *
 * WHO MAY DO WHAT, AND WHY.
 * - Any member makes a room, and is in it. A room is how two or three people talk about one
 *   thing; a company of five where only the owner can open one is a company that talks somewhere
 *   else. Making a room shows nothing to anybody who was not put in it, so it needs no rank.
 * - Reading a room, posting in it and adding people to it are for the people in it. An admin who
 *   is not in a room cannot read it either: a room is the people in it. An admin or owner may still
 *   add and take out people (the company decides who is in what), and adding themselves is an event
 *   every member sees and a row in the trail, never a quiet look.
 * - Taking somebody out is for that person (leaving), the room's maker, or an admin or owner.
 * - Leaving the company takes a person out of every room, in the same commit. Coming back does not
 *   put them back: somebody adds them again, as anybody new, or they would read what was said
 *   while they were gone.
 * - A room the caller may not read answers 404, the same as one that does not exist, so a member
 *   cannot learn from the answer that a room they are not in is there.
 *
 * THE TRAIL HOLDS NO WORDS. A message's row in `hub_audit` says who posted where, how long it was
 * and whom it mentioned, never its text; a room's row never holds its name.
 */

/** A hub id as this hub makes them (`m_<uuid>`, `r_<uuid>`) or a file id: no spaces, bounded. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,80}$/;
const RUN_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

class Invalid extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

const invalid = (field: string): Answer => ({
  status: 400,
  body: { ok: false, code: "laf:request_invalid", field },
});
const notFound: Answer = {
  status: 404,
  body: { ok: false, code: HUB_FACTS.notFound },
};
const forbidden: Answer = {
  status: 403,
  body: { ok: false, code: HUB_FACTS.forbidden },
};

const isString = (value: unknown): value is string => typeof value === "string";

/** A list of ids, each distinct, at most `max`; absent is empty. */
function idList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Invalid(field);
  const ids = [...new Set(value)];
  if (ids.length > max) throw new Invalid(field);
  for (const id of ids) {
    if (!isString(id) || !ID_SHAPE.test(id)) throw new Invalid(field);
  }
  return ids as string[];
}

function parseName(value: unknown): string {
  if (!isString(value)) throw new Invalid("name");
  const name = value.trim();
  if (name === "" || name.length > HUB_ROOM_LIMITS.name)
    throw new Invalid("name");
  return name;
}

type Post = Required<Omit<HubRoomPost, "runId">> & { runId: string | null };

function parsePost(body: Record<string, unknown>, runHeader?: string): Post {
  const text = body.text;
  if (
    !isString(text) ||
    text.trim() === "" ||
    text.length > HUB_ROOM_LIMITS.text
  )
    throw new Invalid("text");
  const as = body.as ?? "member";
  if (as !== "member" && as !== "bot") throw new Invalid("as");
  const mentions = idList(body.mentions, "mentions", HUB_ROOM_LIMITS.mentions);
  // A 라피 asking a 라피 would have the author's VM answer its own answer, and again.
  if (as === "bot" && mentions.includes(HUB_LAFI_MENTION))
    throw new Invalid("mentions");
  const runId = body.runId ?? runHeader ?? null;
  if (runId !== null && (!isString(runId) || !RUN_SHAPE.test(runId)))
    throw new Invalid("runId");
  return {
    text,
    as,
    mentions,
    runId,
    files: idList(body.files, "files", HUB_ROOM_LIMITS.files),
  };
}

async function readJson(
  context: Context,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await context.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A whole number from a query string, or null when it is anything else. */
function wholeOf(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
}

const isManager = (member: AuthedMember) =>
  member.role === "owner" || member.role === "admin";

async function roomMemberIds(
  tx: HubTransaction | HubDatabase,
  roomId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: hubRoomMembers.memberId })
    .from(hubRoomMembers)
    .where(eq(hubRoomMembers.roomId, roomId))
    .orderBy(asc(hubRoomMembers.addedAt), asc(hubRoomMembers.memberId));
  return rows.map((row) => row.id);
}

/**
 * Which of `ids` are members of the company now. `hold` keeps them so until the commit, for a
 * write that puts them in a room: a departure committing beside it waits, or is waited for and
 * then seen, so nobody is put in a room in the moment they leave the company. A post does not hold
 * them: the room's lock already orders it against a departure, which takes that lock too.
 */
async function activeOf(
  tx: HubTransaction,
  ids: string[],
  hold = false,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const query = tx
    .select({ id: hubMembers.id })
    .from(hubMembers)
    .where(and(inArray(hubMembers.id, ids), eq(hubMembers.state, "active")));
  const rows = hold ? await query.for("key share") : await query;
  return rows.map((row) => row.id);
}

/**
 * Takes a member who has left the company out of every room they were in, inside the registry's
 * transaction that marks them gone. The rooms are locked in one order, the way a post or an add
 * locks its room, so a message committing beside the departure is shown to them or not, never
 * after they are gone. Each room left with anybody in it hears of it, so their VMs redraw it.
 */
export async function leaveEveryRoom(
  tx: HubTransaction,
  memberId: string,
  by: string,
): Promise<void> {
  const rooms = await tx
    .select({ id: hubRooms.id })
    .from(hubRooms)
    .where(
      inArray(
        hubRooms.id,
        tx
          .select({ roomId: hubRoomMembers.roomId })
          .from(hubRoomMembers)
          .where(eq(hubRoomMembers.memberId, memberId)),
      ),
    )
    .orderBy(asc(hubRooms.id))
    .for("update");
  for (const room of rooms) {
    await tx
      .delete(hubRoomMembers)
      .where(
        and(
          eq(hubRoomMembers.roomId, room.id),
          eq(hubRoomMembers.memberId, memberId),
        ),
      );
    const left = await roomMemberIds(tx, room.id);
    if (left.length > 0) {
      await emitEvent(tx, {
        type: "room.changed",
        refId: room.id,
        visibleTo: left,
      });
    }
    await recordAudit(tx, {
      action: "room.member_removed",
      member: by,
      target: room.id,
      outcome: "ok",
      payload: { member: memberId },
    });
  }
}

async function roomView(
  tx: HubTransaction | HubDatabase,
  roomId: string,
): Promise<HubRoom | null> {
  const [room] = await tx
    .select()
    .from(hubRooms)
    .where(eq(hubRooms.id, roomId));
  if (!room) return null;
  return {
    id: room.id,
    name: room.name,
    members: await roomMemberIds(tx, room.id),
    lastSeq: room.lastSeq,
    createdBy: room.createdBy,
    createdAt: room.createdAt.toISOString(),
  };
}

const messageView = (row: typeof hubMessages.$inferSelect): HubRoomMessage => ({
  seq: row.seq,
  by: row.by,
  text: row.text,
  mentions: row.mentions,
  runId: row.runId,
  files: row.files,
  at: row.at.toISOString(),
});

export type RoomRouteOptions = {
  database: HubDatabase;
  listeners: Listeners;
  member: MiddlewareHandler<{ Variables: MemberVariables }>;
};

export function roomRoutes(options: RoomRouteOptions) {
  const { database, listeners } = options;
  const route = new Hono<{ Variables: MemberVariables }>();
  route.use(options.member);

  /**
   * One write: inside the idempotency ledger when the request carries a key, in a plain
   * transaction when it does not and may not. Listeners are poked after the commit, and not for a
   * replay, whose events were delivered the first time.
   */
  const write = async (
    context: Context<{ Variables: MemberVariables }>,
    keyRequired: boolean,
    work: (tx: HubTransaction, emitted: () => void) => Promise<Answer>,
  ) => {
    const key = context.req.header(HUB_HEADERS.idempotencyKey);
    if (
      (key === undefined && keyRequired) ||
      (key !== undefined && !IDEMPOTENCY_KEY_SHAPE.test(key))
    ) {
      const answer = invalid("idempotencyKey");
      return context.json(answer.body as Record<string, unknown>, 400);
    }
    let poke = false;
    const emitted = () => {
      poke = true;
    };
    const member = context.get("member");
    const answer =
      key === undefined
        ? {
            ...(await database.transaction((tx) => work(tx, emitted))),
            replayed: false,
          }
        : await onceFor(database, member.id, key, (tx) => work(tx, emitted));
    if (poke && !answer.replayed) listeners.pokeAll();
    return context.json(
      answer.body as Record<string, unknown>,
      answer.status as 200,
    );
  };

  const limited = bodyLimit({
    maxSize: 64 * 1024,
    onError: (context) =>
      context.json({ ok: false, code: "laf:request_invalid" }, 413),
  });

  route.get("/", async (context) => {
    const self = context.get("member");
    const mine = database
      .select({ roomId: hubRoomMembers.roomId })
      .from(hubRoomMembers)
      .where(eq(hubRoomMembers.memberId, self.id));
    const rooms = await database
      .select()
      .from(hubRooms)
      .where(inArray(hubRooms.id, mine))
      .orderBy(asc(hubRooms.createdAt), asc(hubRooms.id));
    const members =
      rooms.length === 0
        ? []
        : await database
            .select()
            .from(hubRoomMembers)
            .where(
              inArray(
                hubRoomMembers.roomId,
                rooms.map((room) => room.id),
              ),
            )
            .orderBy(asc(hubRoomMembers.addedAt), asc(hubRoomMembers.memberId));
    const body: HubRooms = {
      ok: true,
      rooms: rooms.map((room) => ({
        id: room.id,
        name: room.name,
        members: members
          .filter((row) => row.roomId === room.id)
          .map((row) => row.memberId),
        lastSeq: room.lastSeq,
        createdBy: room.createdBy,
        createdAt: room.createdAt.toISOString(),
      })),
    };
    return context.json(body);
  });

  route.post("/", limited, async (context) => {
    const self = context.get("member");
    const body = await readJson(context);
    let name: string;
    let named: string[];
    try {
      if (!body) throw new Invalid("body");
      name = parseName(body.name);
      named = idList(body.members, "members", HUB_ROOM_LIMITS.members);
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      return context.json(invalid(error.field).body as object, 400);
    }
    return write(context, false, async (tx, emitted) => {
      const wanted = [...new Set([self.id, ...named])];
      const active = await activeOf(tx, wanted, true);
      if (active.length !== wanted.length) return invalid("members");
      const id = `r_${randomUUID()}`;
      await tx.insert(hubRooms).values({ id, name, createdBy: self.id });
      await tx.insert(hubRoomMembers).values(
        wanted.map((memberId) => ({
          roomId: id,
          memberId,
          addedBy: self.id,
        })),
      );
      await emitEvent(tx, {
        type: "room.changed",
        refId: id,
        actor: self.id,
        visibleTo: wanted,
      });
      emitted();
      await recordAudit(tx, {
        action: "room.created",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: id,
        outcome: "ok",
        payload: { members: wanted.length },
      });
      return { status: 200, body: { ok: true, room: await roomView(tx, id) } };
    });
  });

  route.post("/:id/members", limited, async (context) => {
    const self = context.get("member");
    const roomId = context.req.param("id");
    const body = await readJson(context);
    let named: string[];
    try {
      if (!body) throw new Invalid("body");
      named = idList(body.members, "members", HUB_ROOM_LIMITS.members);
      if (named.length === 0) throw new Invalid("members");
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      return context.json(invalid(error.field).body as object, 400);
    }
    return write(context, false, async (tx, emitted) => {
      // The room's row is locked first, so a post and an add to one room do not interleave: a
      // message's `room.message` event is seen by exactly the members at its commit.
      const [room] = await tx
        .select({ id: hubRooms.id })
        .from(hubRooms)
        .where(eq(hubRooms.id, roomId))
        .for("update");
      if (!room) return notFound;
      const before = await roomMemberIds(tx, roomId);
      if (!before.includes(self.id) && !isManager(self)) return notFound;
      // Only the ones not in it yet are checked and held: holding somebody already in the room
      // while their departure waits for this room's lock would have each wait for the other.
      const fresh = named.filter((id) => !before.includes(id));
      const active = await activeOf(tx, fresh, true);
      if (active.length !== fresh.length) return invalid("members");
      const added = await tx
        .insert(hubRoomMembers)
        .values(
          named.map((memberId) => ({ roomId, memberId, addedBy: self.id })),
        )
        .onConflictDoNothing()
        .returning({ id: hubRoomMembers.memberId });
      if (added.length > 0) {
        await emitEvent(tx, {
          type: "room.changed",
          refId: roomId,
          actor: self.id,
          visibleTo: await roomMemberIds(tx, roomId),
        });
        emitted();
        await recordAudit(tx, {
          action: "room.members_added",
          member: self.id,
          vmOrigin: self.vmOrigin,
          target: roomId,
          outcome: "ok",
          payload: { members: added.map((row) => row.id) },
        });
      }
      return {
        status: 200,
        body: { ok: true, room: await roomView(tx, roomId) },
      };
    });
  });

  route.delete("/:id/members/:member", async (context) => {
    const self = context.get("member");
    const roomId = context.req.param("id");
    const target = context.req.param("member");
    return write(context, false, async (tx, emitted) => {
      const [room] = await tx
        .select({ id: hubRooms.id, createdBy: hubRooms.createdBy })
        .from(hubRooms)
        .where(eq(hubRooms.id, roomId))
        .for("update");
      if (!room) return notFound;
      const before = await roomMemberIds(tx, roomId);
      const inRoom = before.includes(self.id);
      if (!inRoom && !isManager(self)) return notFound;
      if (!before.includes(target)) return notFound;
      if (
        target !== self.id &&
        room.createdBy !== self.id &&
        !isManager(self)
      ) {
        return forbidden;
      }
      await tx
        .delete(hubRoomMembers)
        .where(
          and(
            eq(hubRoomMembers.roomId, roomId),
            eq(hubRoomMembers.memberId, target),
          ),
        );
      // The one taken out sees this one too, so their VM drops the room.
      await emitEvent(tx, {
        type: "room.changed",
        refId: roomId,
        actor: self.id,
        visibleTo: before,
      });
      emitted();
      await recordAudit(tx, {
        action: "room.member_removed",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: roomId,
        outcome: "ok",
        payload: { member: target },
      });
      return {
        status: 200,
        body: { ok: true, room: await roomView(tx, roomId) },
      };
    });
  });

  route.get("/:id/messages", async (context) => {
    const self = context.get("member");
    const roomId = context.req.param("id");
    const since = wholeOf(context.req.query("since"));
    const before = wholeOf(context.req.query("before"));
    const limit = wholeOf(context.req.query("limit"));
    if (since === null || before === null || limit === null || limit === 0) {
      return context.json(invalid("since").body as object, 400);
    }
    if (since !== undefined && before !== undefined) {
      return context.json(invalid("before").body as object, 400);
    }
    const [membership] = await database
      .select({ roomId: hubRoomMembers.roomId })
      .from(hubRoomMembers)
      .where(
        and(
          eq(hubRoomMembers.roomId, roomId),
          eq(hubRoomMembers.memberId, self.id),
        ),
      );
    if (!membership) return context.json(notFound.body as object, 404);
    const size = Math.min(
      limit ?? HUB_ROOM_LIMITS.pageDefault,
      HUB_ROOM_LIMITS.page,
    );
    // One row past the page says whether there is more, without a count.
    let rows: (typeof hubMessages.$inferSelect)[];
    if (since !== undefined) {
      rows = await database
        .select()
        .from(hubMessages)
        .where(and(eq(hubMessages.roomId, roomId), gt(hubMessages.seq, since)))
        .orderBy(asc(hubMessages.seq))
        .limit(size + 1);
    } else {
      rows = (
        await database
          .select()
          .from(hubMessages)
          .where(
            before === undefined
              ? eq(hubMessages.roomId, roomId)
              : and(
                  eq(hubMessages.roomId, roomId),
                  lt(hubMessages.seq, before),
                ),
          )
          .orderBy(desc(hubMessages.seq))
          .limit(size + 1)
      ).reverse();
    }
    const more = rows.length > size;
    // Forward, the extra row is the newest; backward, it is the oldest.
    const page = more
      ? since !== undefined
        ? rows.slice(0, size)
        : rows.slice(1)
      : rows;
    const body: HubRoomMessages = {
      ok: true,
      messages: page.map(messageView),
      seq: page.at(-1)?.seq ?? since ?? 0,
      more,
    };
    return context.json(body);
  });

  route.post("/:id/messages", limited, async (context) => {
    const self = context.get("member");
    const roomId = context.req.param("id");
    const body = await readJson(context);
    let post: Post;
    try {
      if (!body) throw new Invalid("body");
      post = parsePost(body, context.req.header(HUB_HEADERS.run));
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      return context.json(invalid(error.field).body as object, 400);
    }
    return write(context, true, async (tx, emitted) => {
      // Locking the room's row orders this post against every other write to the room: the number
      // it takes is final when it commits, and the members it is shown to are the members then.
      const [room] = await tx
        .select({ id: hubRooms.id })
        .from(hubRooms)
        .where(eq(hubRooms.id, roomId))
        .for("update");
      if (!room) return notFound;
      const members = await roomMemberIds(tx, roomId);
      if (!members.includes(self.id)) return notFound;
      const mentioned = post.mentions.filter((id) => id !== HUB_LAFI_MENTION);
      // A mention reaches only somebody who can read the room, or it would name a room to an
      // outsider. Somebody who left the company is no longer mentioned either.
      if (
        mentioned.some((id) => !members.includes(id)) ||
        (await activeOf(tx, mentioned)).length !== mentioned.length
      ) {
        return invalid("mentions");
      }
      const [bumped] = await tx
        .update(hubRooms)
        .set({ lastSeq: sql`${hubRooms.lastSeq} + 1` })
        .where(eq(hubRooms.id, roomId))
        .returning({ seq: hubRooms.lastSeq });
      if (!bumped) throw new Error("hub_rooms bump returned nothing");
      const seq = bumped.seq;
      await tx.insert(hubMessages).values({
        roomId,
        seq,
        by: `${post.as === "bot" ? "bot" : "m"}:${self.id}`,
        text: post.text,
        mentions: post.mentions,
        runId: post.runId,
        files: post.files,
      });
      // TODO(hub-files): once `hub_chunks` lands (laf/hub-files), index the message's text there so
      // `POST /search` finds it, with the room's members as who may see the hit.
      const ref = roomMessageRef(roomId, seq);
      await emitEvent(tx, {
        type: "room.message",
        refId: ref,
        actor: self.id,
        visibleTo: members,
      });
      /*
       * One mention event for everyone it is for. `lafi` is the author's own: only the caller's VM
       * answers, so only the caller hears of it — every other member's 라피 stays out. A member who
       * mentions themself is not told of it; a 라피 mentioning its own person is.
       */
      const told = new Set<string>();
      if (post.mentions.includes(HUB_LAFI_MENTION)) told.add(self.id);
      for (const id of mentioned) {
        if (!(post.as === "member" && id === self.id)) told.add(id);
      }
      if (told.size > 0) {
        await emitEvent(tx, {
          type: "room.mention",
          refId: ref,
          actor: self.id,
          visibleTo: [...told],
        });
      }
      emitted();
      await recordAudit(tx, {
        action: "room.message_posted",
        member: self.id,
        vmOrigin: self.vmOrigin,
        target: ref,
        runId: post.runId,
        outcome: "ok",
        payload: {
          as: post.as,
          chars: post.text.length,
          mentions: post.mentions,
          files: post.files.length,
        },
      });
      return { status: 200, body: { ok: true, seq } };
    });
  });

  return route;
}
