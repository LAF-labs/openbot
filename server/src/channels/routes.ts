import { RoomError } from "../rooms/service";
import { previewOf } from "./preview";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";
import {
  CHANNEL_ACTIVITY_TOPIC,
  type ChannelActivityEvent,
  type ChannelEventHub,
} from "./events";
import { upgradeWebSocket } from "./socket";
import type { ThreadIdentity } from "./thread-identity";

export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
};

/** A channel plus the last thing said in it, which is what a roster renders. */
export type ChannelSummary = AgentChannel & {
  lastMessage: string | null;
  lastMessageAt: Date | null;
  lastMessageAgentId: string | null;
  /** A Bot has spoken here since this person last looked. */
  unread: boolean;
  createdAt: Date;
};

/**
 * Whether a room has something in it this person has not seen.
 *
 * Two conditions, and the second is the one that is easy to forget: a message only counts as unread
 * if a BOT said it. Your own message is the newest thing in the room the instant you send it, so
 * without the agent check every room you spoke in would mark itself unread the moment you left.
 */
function isUnread(row: {
  lastMessageAt: Date | null;
  lastMessageAgentId: string | null;
  lastReadAt: Date | null;
}): boolean {
  if (row.lastMessageAgentId === null || row.lastMessageAt === null) {
    return false;
  }
  return row.lastReadAt === null || row.lastMessageAt > row.lastReadAt;
}

/** What a client that ran an agent reports back about the message it just saw. */
export type ChannelActivity = {
  text: string;
  /** The agent that said it, or null when a person did. */
  agentId: string | null;
  at: Date;
};

export type ChannelStore = {
  create(actor: AgentActor, agentIds: string[]): Promise<AgentChannel>;
  get(actor: AgentActor, channelId: string): Promise<AgentChannel | null>;
  list(actor: AgentActor): Promise<ChannelSummary[]>;
  /**
   * Move this person's read mark for a channel.
   *
   * `at` rather than a "mark read" verb, so the same call serves both directions: opening a room
   * sets it to now, and "mark unread" sets it back before the last thing said.
   */
  setLastRead(
    actor: AgentActor,
    channelId: string,
    at: Date | null,
    options?: {
      /**
       * Only ever move the mark BACK. What "mark unread" means, and it has to be enforced against
       * the stored mark rather than computed by the caller, because reading it first and writing it
       * second is the same two statements with a race in between.
       */
      neverForward?: boolean;
    },
  ): Promise<{ previous: Date | null; at: Date | null }>;
  recordActivity(
    actor: AgentActor,
    channelId: string,
    activity: ChannelActivity,
  ): Promise<void>;
};

const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";
const MAX_CHANNEL_NAME_CODE_POINTS = 120;

/**
 * Reduce a message to one line of plain text.
 *
 * A preview is rendered as text wherever a roster appears, so control characters have nothing to do
 * there: at best they are invisible, at worst a terminal escape somebody put in a message follows it
 * into a log. Newlines collapse to spaces because a preview is one line by definition.
 */
function channelName(names: string[]) {
  const joined = names.join(", ");
  const codePoints = Array.from(joined);
  if (codePoints.length <= MAX_CHANNEL_NAME_CODE_POINTS) return joined;
  return `${codePoints.slice(0, MAX_CHANNEL_NAME_CODE_POINTS - 1).join("")}…`;
}

export function createChannelStore(
  database: Database,
  profileStore: AgentProfileStore,
  threadIdentity: ThreadIdentity,
): ChannelStore {
  return {
    create(actor, agentIds) {
      return database.transaction(
        async (transaction) => {
          // Validated on this transaction, not through `profileStore.get`: the read has to share
          // the connection this transaction already holds, and has to hold the profile so an agent
          // cannot be deleted between passing the check and being linked to the new channel.
          //
          // Locks are taken in agent-ID order. Two channels selecting the same pair of agents in
          // opposite orders would otherwise be able to deadlock against each other.
          const profilesById = new Map<string, AgentProfile>();
          for (const agentId of [...agentIds].sort()) {
            const profile = await profileStore.getWithin(
              transaction,
              actor,
              agentId,
            );
            if (!profile) throw new AgentNotFoundError(agentId);
            profilesById.set(agentId, profile);
          }

          /*
           * ONE CONVERSATION PER BOT, AND THIS IS WHERE THAT IS DECIDED.
           *
           * A Bot here is a colleague with a face, a standing role, its own routines and its own
           * seat at the account's computer — and every other table in this server is keyed on it:
           * policy identity, approvals, repetition counts, credentials, the audit trail. The
           * conversation was the one thing that was not, so every message from Home minted a fresh
           * channel and the roster filled up with the same colleague over and over. Three Bots had
           * thirteen channels between them, nine of them the same Bot.
           *
           * So a request for a single Bot resolves to that Bot's conversation if it has one. Inside
           * the transaction, after the profile lock above, so two sends racing from two tabs cannot
           * each decide there is no channel and make one.
           *
           * Only for one Bot. A group of several is a different conversation every time it is
           * assembled, and nothing in the product returns to one yet.
           */
          const soleAgentId = agentIds.length === 1 ? agentIds[0] : undefined;
          if (soleAgentId) {
            const [existing] = await transaction
              .select({
                id: channels.id,
                name: channels.name,
                threadId: intelligenceChannelMappings.threadId,
              })
              .from(channels)
              .innerJoin(
                channelMemberships,
                and(
                  eq(channelMemberships.channelId, channels.id),
                  eq(channelMemberships.userId, actor.id),
                ),
              )
              .innerJoin(
                intelligenceChannelMappings,
                and(
                  eq(intelligenceChannelMappings.channelId, channels.id),
                  eq(intelligenceChannelMappings.userId, actor.id),
                ),
              )
              .innerJoin(
                channelAgents,
                and(
                  eq(channelAgents.channelId, channels.id),
                  eq(channelAgents.agentId, soleAgentId),
                ),
              )
              // A channel that also holds somebody else is a group, not this Bot's conversation.
              .where(
                sql`(select count(*) from ${channelAgents} where ${channelAgents.channelId} = ${channels.id}) = 1`,
              )
              // The oldest is the one with the history in it, which is the point of returning here.
              .orderBy(asc(channels.createdAt), asc(channels.id))
              .limit(1);

            if (existing) {
              return {
                id: existing.id,
                name: existing.name,
                agentIds,
                threadId: existing.threadId,
                active: true,
              };
            }
          }

          const id = `channel_${crypto.randomUUID()}`;
          // Minted rather than a bare random id, so the thread says which deployment it belongs to
          // in a project that may hold more than one. See thread-identity.ts.
          const threadId = threadIdentity.mint();
          // Named from the caller's ordering, which is the order the channel presents its agents in.
          const name = channelName(
            agentIds.map((agentId) => {
              const profile = profilesById.get(agentId);
              if (!profile) throw new AgentNotFoundError(agentId);
              return profile.name;
            }),
          );

          await transaction.insert(channels).values({
            id,
            name,
            description: PRIVATE_AGENT_CHANNEL_DESCRIPTION,
          });
          await transaction.insert(channelMemberships).values({
            channelId: id,
            userId: actor.id,
          });
          await transaction
            .insert(channelAgents)
            .values(agentIds.map((agentId) => ({ channelId: id, agentId })));
          await transaction.insert(intelligenceChannelMappings).values({
            userId: actor.id,
            channelId: id,
            threadId,
          });

          return { id, name, agentIds, threadId, active: true };
        },
        { isolationLevel: "read committed" },
      );
    },

    async get(actor, channelId) {
      const rows = await database
        .select({
          id: channels.id,
          name: channels.name,
          agentId: channelAgents.agentId,
          threadId: intelligenceChannelMappings.threadId,
          deletedAt: agentProfiles.deletedAt,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .innerJoin(
          intelligenceChannelMappings,
          and(
            eq(intelligenceChannelMappings.channelId, channels.id),
            eq(intelligenceChannelMappings.userId, actor.id),
          ),
        )
        .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.agentId, channelAgents.agentId),
        )
        .where(eq(channels.id, channelId))
        .orderBy(asc(channelAgents.agentId));

      const first = rows[0];
      if (!first) return null;

      return {
        id: first.id,
        name: first.name,
        agentIds: rows.map((row) => row.agentId),
        threadId: first.threadId,
        active: rows.every((row) => row.deletedAt === null),
      };
    },

    async list(actor) {
      const rows = await database
        .select({
          id: channels.id,
          name: channels.name,
          agentId: channelAgents.agentId,
          threadId: intelligenceChannelMappings.threadId,
          deletedAt: agentProfiles.deletedAt,
          lastMessage: channels.lastMessage,
          lastMessageAt: channels.lastMessageAt,
          lastMessageAgentId: channels.lastMessageAgentId,
          lastReadAt: channelMemberships.lastReadAt,
          createdAt: channels.createdAt,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .innerJoin(
          intelligenceChannelMappings,
          and(
            eq(intelligenceChannelMappings.channelId, channels.id),
            eq(intelligenceChannelMappings.userId, actor.id),
          ),
        )
        .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.agentId, channelAgents.agentId),
        )
        // Most recent first, where starting a conversation counts as activity. A channel somebody
        // just created has nothing said in it yet, and is also the one they are about to type in, // ordering on the message alone would bury it under every channel that has one.
        //
        // The browser repeats this when the socket patches a row. Both must agree, or the list
        // reorders itself on the next event; see `byRecency` in use-channel-events.ts.
        .orderBy(
          sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt}) desc`,
          asc(channels.id),
          asc(channelAgents.agentId),
        );

      // One row per channel-agent pair; the ordering above keeps each channel's rows together and
      // its agents in the same lexicographic order `get` returns.
      const summaries = new Map<string, ChannelSummary>();
      for (const row of rows) {
        const summary = summaries.get(row.id);
        if (summary) {
          summary.agentIds.push(row.agentId);
          summary.active &&= row.deletedAt === null;
          continue;
        }
        summaries.set(row.id, {
          id: row.id,
          name: row.name,
          agentIds: [row.agentId],
          threadId: row.threadId,
          active: row.deletedAt === null,
          lastMessage: row.lastMessage,
          lastMessageAt: row.lastMessageAt,
          lastMessageAgentId: row.lastMessageAgentId,
          unread: isUnread(row),
          createdAt: row.createdAt,
        });
      }
      return [...summaries.values()];
    },

    setLastRead(actor, channelId, at, options) {
      return database.transaction(async (transaction) => {
        /*
         * Scoped by userId in the WHERE, so this can only ever move the caller's own mark. Reading
         * membership first and updating second would be the same two statements with a race in
         * between; one guarded UPDATE is both.
         */
        /*
         * The PREVIOUS mark comes back, and that is the point of returning anything.
         *
         * Opening a room marks it read, which destroys the very fact the transcript needs to draw
         * its "unread from here" line. Reading it in a separate request would race the write; one
         * statement that reports what it replaced cannot.
         */
        const [before] = await transaction
          .select({ lastReadAt: channelMemberships.lastReadAt })
          .from(channelMemberships)
          .where(
            and(
              eq(channelMemberships.channelId, channelId),
              eq(channelMemberships.userId, actor.id),
            ),
          )
          .for("update");
        // Not a member, or no such channel: the same answer either way, so belonging to a channel
        // is not something an outsider can probe for.
        if (!before) throw new ChannelNotFoundError(channelId);

        /*
         * NEVER FORWARDS, when asked not to. Marking unread puts the boundary just before the
         * newest thing said — and on a room that already had several unread replies, taking that
         * literally moved the mark FORWARD and marked the earlier ones read. "I have not read this"
         * cannot be an instruction that marks four messages read.
         */
        const next =
          options?.neverForward && before.lastReadAt !== null && at !== null
            ? new Date(Math.min(before.lastReadAt.getTime(), at.getTime()))
            : at;

        await transaction
          .update(channelMemberships)
          .set({ lastReadAt: next })
          .where(
            and(
              eq(channelMemberships.channelId, channelId),
              eq(channelMemberships.userId, actor.id),
            ),
          );
        return { previous: before.lastReadAt, at: next };
      });
    },

    recordActivity(actor, channelId, activity) {
      return database.transaction(
        async (transaction) => {
          const [membership] = await transaction
            .select({
              channelId: channelMemberships.channelId,
              /*
               * POSTGRES' CLOCK, NOT THIS PROCESS'S, and taken here so it costs no extra round
               * trip. Everything this table orders by is written by Postgres — `created_at`
               * defaults, `now()` in the read mark — and the two clocks are not the same clock:
               * measured, this Postgres runs ~66 ms ahead of the Bun process beside it. Clamping a
               * browser's reported time to `new Date()` therefore pinned a message BEHIND the
               * `created_at` of the room it was sent to, and a room a person had just spoken in
               * failed to move to the top of their roster.
               */
              at: sql<Date>`now()`,
            })
            .from(channelMemberships)
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                eq(channelMemberships.userId, actor.id),
              ),
            );
          // Not a member, or no such channel: the same answer either way, so belonging to a channel
          // is not something an outsider can probe for.
          if (!membership) throw new ChannelNotFoundError(channelId);

          /*
           * The browser says when it saw the message, because only it knows that. A browser whose
           * clock runs ahead would write a `last_message_at` in the future, and then no read mark
           * this server sets could ever pass it — the room would stay unread however often it was
           * opened. Earlier is honest; later is impossible.
           */
          const now = new Date(membership.at);
          const at = activity.at > now ? now : activity.at;

          if (activity.agentId !== null) {
            const [linked] = await transaction
              .select({ agentId: channelAgents.agentId })
              .from(channelAgents)
              .where(
                and(
                  eq(channelAgents.channelId, channelId),
                  eq(channelAgents.agentId, activity.agentId),
                ),
              );
            if (!linked) throw new AgentNotFoundError(activity.agentId);
          }

          /*
           * NO RETITLING. A channel used to take its name from the first thing said in it, because
           * a roster of five conversations with the same Bot was five identical rows — and that is
           * fixed at the root now: a Bot has one conversation, and a channel is named after its
           * participants the way a messaging thread is. Naming a Bot's one room after whatever was
           * typed into it first would freeze a stale sentence over a colleague's name forever.
           */

          // A person's message and the agent's reply are reported separately, so they can arrive out
          // of order. Only ever move forwards.
          const lastMessage = previewOf(activity.text);
          const applied = await transaction
            .update(channels)
            .set({
              lastMessage,
              lastMessageAt: at,
              lastMessageAgentId: activity.agentId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(channels.id, channelId),
                or(
                  isNull(channels.lastMessageAt),
                  lt(channels.lastMessageAt, at),
                ),
              ),
            )
            .returning({ id: channels.id, name: channels.name });
          // Nothing changed, so there is nothing to announce: a stale report is not news.
          const [appliedRow] = applied;
          if (!appliedRow) return;

          const members = await transaction
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId));

          // Announced inside the transaction, so it is delivered on commit and a write that rolls
          // back is never announced. The payload carries the members because the writer has already
          // resolved them; NOTIFY caps at 8000 bytes, which a 200-character preview leaves room in.
          const event: ChannelActivityEvent = {
            channelId,
            memberIds: members.map((member) => member.userId),
            // The post-rename name, so a first message retitles every member's roster in the same
            // event that carries it.
            name: appliedRow.name,
            lastMessage,
            // The clamped time — what was WRITTEN. The event carrying the browser's own reading
            // would have every other tab patch its roster with a time the database does not hold.
            lastMessageAt: at.toISOString(),
            lastMessageAgentId: activity.agentId,
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
        },
        { isolationLevel: "read committed" },
      );
    },
  };
}

export class ChannelNotFoundError extends Error {
  constructor(id: string) {
    super(`Channel ${id} was not found.`);
    this.name = "ChannelNotFoundError";
  }
}

type ChannelInputParseResult =
  | { ok: true; value: { agentIds: string[] } }
  | { ok: false; error: string };

type ChannelInputObject = { agentIds?: unknown };

export function parseChannelInput(input: unknown): ChannelInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, error: "Channel input must be a JSON object." };
  }

  if (!Array.isArray(input.agentIds) || input.agentIds.length === 0) {
    return { ok: false, error: "Agent IDs must be a non-empty array." };
  }

  const agentIds: string[] = [];
  for (const agentId of input.agentIds) {
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "Agent IDs must be non-empty strings." };
    }
    agentIds.push(agentId.trim());
  }

  if (new Set(agentIds).size !== agentIds.length) {
    return { ok: false, error: "Agent IDs must be unique." };
  }

  return { ok: true, value: { agentIds: agentIds.sort() } };
}

function isChannelInputObject(input: unknown): input is ChannelInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** As much reported text as any real message has, and far less than a request built to cost. */
const MAX_ACTIVITY_TEXT = 100_000;

/**
 * As much as a person may say to a room in one turn.
 *
 * Much smaller than `MAX_ACTIVITY_TEXT`, which bounds a report of something ALREADY said. This is
 * input to as many models as there are Bots in the room, several times over as the rounds go.
 */
const MAX_ROOM_TURN_TEXT = 8000;

type ActivityInputParseResult =
  | { ok: true; value: ChannelActivity }
  | { ok: false; error: string };

/**
 * Parse a reported message.
 *
 * `at` comes from the client that saw the message, because only it knows when the message arrived, * but it is never trusted as a clock: the store compares it against what is stored and only ever
 * moves forwards, so a wrong one can lose a report, not corrupt the row.
 */
export function parseActivityInput(input: unknown): ActivityInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, error: "Activity must be a JSON object." };
  }
  const object = input as { text?: unknown; agentId?: unknown; at?: unknown };

  if (typeof object.text !== "string" || object.text.trim().length === 0) {
    return { ok: false, error: "Text is required." };
  }
  /*
   * BOUNDED, because nothing else here is. Only a preview of this is ever stored, so a caller
   * sending a megabyte is not sending anything anybody will read — but the server still has to
   * receive it, parse it and run a preview over it. The limit is generous against any real message
   * and small against a request built to cost something.
   */
  if (object.text.length > MAX_ACTIVITY_TEXT) {
    return { ok: false, error: "That message is too long to report." };
  }
  if (object.agentId !== null && typeof object.agentId !== "string") {
    return { ok: false, error: "Agent ID must be a string or null." };
  }
  if (typeof object.at !== "string") {
    return { ok: false, error: "Timestamp is required." };
  }
  const at = new Date(object.at);
  if (Number.isNaN(at.getTime())) {
    return { ok: false, error: "Timestamp must be an ISO-8601 date." };
  }

  return {
    ok: true,
    value: {
      agentId:
        typeof object.agentId === "string" ? object.agentId.trim() : null,
      at,
      text: object.text,
    },
  };
}

export function createChannelRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Absent in tests and wherever live updates are not wanted; the routes still work without it. */
  events?: ChannelEventHub,
  /**
   * Reads when each message in a thread was first seen, and which Bot said it. Optional for the
   * same reason as `events`: a deployment or a test without it serves a transcript with no
   * separators and no names, not an error.
   */
  readMessageTimes?: (threadId: string) => Promise<{
    times: Record<string, string>;
    speakers: Record<string, string>;
  }>,
  /** Runs a room's turn on the server. Absent leaves the room routes unmounted. */
  rooms?: {
    post: (input: {
      actor: { id: string; role: "admin" | "user" };
      actorLabel: string;
      channelId: string;
      threadId: string;
      text: string;
      messageId?: string;
      addressedAgentIds?: string[];
      personName: string;
    }) => Promise<{ turnId: string; messageId: string; epoch: number }>;
    stop: (actor: { id: string }, channelId: string) => Promise<void>;
  },
  /** The room's transcript, straight out of the snapshot. Absent serves an empty room. */
  readThreadMessages?: (threadId: string) => Promise<unknown[]>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  // Before `/:channelId`, or "events" is read as a channel id.
  if (events) {
    routes.get(
      "/events",
      requireUser,
      upgradeWebSocket((context) => {
        // Resolved at upgrade, not per message: the connection belongs to whoever authenticated it,
        // and nothing it later sends can change that.
        const { id: userId } = context.var.actor;
        let detach = () => {};
        return {
          onOpen: (_event, ws) => {
            detach = events.register(userId, (payload) => ws.send(payload));
          },
          onClose: () => detach(),
          onError: () => detach(),
        };
      }),
    );
  }

  routes.post("/", requireUser, async (context) => {
    const parsed = parseChannelInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const channel = await store.create(
        context.var.actor,
        parsed.value.agentIds,
      );
      return context.json({ channel: channelDto(channel) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/", requireUser, async (context) => {
    try {
      const channels = await store.list(context.var.actor);
      return context.json({ channels: channels.map(channelSummaryDto) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:channelId/activity", requireUser, async (context) => {
    const parsed = parseActivityInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      await store.recordActivity(
        context.var.actor,
        context.req.param("channelId"),
        parsed.value,
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * Before `/:channelId`, or "message-times" is read as a channel id.
   *
   * Keyed on the CHANNEL rather than the thread, even though the times are a property of the
   * thread, because the channel is where membership is enforced: `store.get` returns null for
   * somebody who is not in the room. A thread-keyed route would have had to re-derive that, and a
   * transcript's timing is enough to tell you when somebody was working.
   */
  /**
   * Move the caller's read mark. `{ read: true }` on open, `{ read: false }` for "mark unread".
   *
   * Marking unread sets the mark to one millisecond BEFORE the last thing said rather than to null.
   * Null means "never opened", and a room you have read and deliberately flagged to come back to is
   * not the same as one you have never seen — collapsing them would lose the distinction the moment
   * anybody used the feature.
   */
  routes.post("/:channelId/read", requireUser, async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const read =
      typeof body === "object" && body !== null
        ? (body as { read?: unknown }).read
        : undefined;
    if (typeof read !== "boolean") {
      return context.json({ error: "`read` must be true or false." }, 400);
    }

    try {
      const channelId = context.req.param("channelId");
      if (read) {
        const readAt = new Date();
        const { previous } = await store.setLastRead(
          context.var.actor,
          channelId,
          readAt,
        );
        /*
         * Both ends of the unread window, on the server's clock — the clock the message stamps
         * are on. `previousReadAt` is where the reading stopped; `readAt` is where it resumed. A
         * reply that lands AFTER `readAt` was watched arrive, and a line drawn above it would tell
         * the person they had missed the thing they just read.
         */
        return context.json({
          previousReadAt: previous?.toISOString() ?? null,
          readAt: readAt.toISOString(),
        });
      }
      /*
       * THE BOUNDARY COMES FROM THE MESSAGE STAMPS, NOT FROM `last_message_at`.
       *
       * Those are two different clocks for the same event. `last_message_at` is reported by the
       * browser once a reply has finished arriving; a message's own stamp is taken on the server as
       * it STARTS streaming, which is earlier by however long the answer took. Marking unread
       * against the browser's clock therefore placed the mark after every message the transcript
       * knows about, and the "unread from here" line had nothing left to sit above — it silently
       * did nothing, which is exactly how it first shipped.
       *
       * Read state is compared against message stamps, so it is set from message stamps.
       */
      const channel = await store.get(context.var.actor, channelId);
      if (!channel) return context.json({ error: "Channel not found." }, 404);
      const marks = readMessageTimes
        ? await readMessageTimes(channel.threadId)
        : { times: {}, speakers: {} };
      const newest = Object.values(marks.times)
        .map((iso) => new Date(iso).getTime())
        .filter((value) => !Number.isNaN(value))
        .reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
      /*
       * NEVER FORWARDS. Marking unread moves the boundary BACK to just before the newest thing
       * said, and taking that literally moved it forward on a room that already had unread
       * messages: five replies somebody had not read collapsed to one, because the mark jumped
       * past the other four. "I have not read this" cannot be an instruction that marks four
       * messages read. The reference product takes the same minimum
       * (`Math.min(lastViewedAt, …)`); this is that, with the existing mark included.
       */
      const wanted = Number.isFinite(newest) ? new Date(newest - 1) : null;
      const { previous, at: mark } = await store.setLastRead(
        context.var.actor,
        channelId,
        wanted,
        { neverForward: true },
      );
      return context.json({
        previousReadAt: previous?.toISOString() ?? null,
        readAt: mark?.toISOString() ?? null,
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /*
   * A ROOM'S TURN, RUN ON THE SERVER.
   *
   * Registered before `/:channelId` for the reason `/events` and `/message-times` already are: a
   * path segment that is not a channel id would otherwise be read as one.
   *
   * A room is a channel with more than one Bot in it. Its turn does not run in the browser — several
   * Bots answering in rounds is a minute of work that must survive a closed tab, and two tabs must
   * not each drive their own version of it. The browser posts the message and then watches.
   */
  if (rooms) {
    routes.post("/:channelId/room-turn", requireUser, async (context) => {
      const body = (await context.req.json().catch(() => null)) as {
        text?: unknown;
        messageId?: unknown;
        addressedAgentIds?: unknown;
      } | null;
      const text = typeof body?.text === "string" ? body.text : "";
      if (!text.trim()) {
        return context.json({ error: "Say something first." }, 400);
      }
      if (text.length > MAX_ROOM_TURN_TEXT) {
        return context.json({ error: "That message is too long." }, 400);
      }
      /*
       * The browser mints the message's id so it can draw the bubble before the round trip and
       * keep it through catch-up. That makes the id input, and input is validated: a UUID and
       * nothing else, or a caller could store a message under an id that already exists and have
       * two messages share one key.
       */
      if (body?.messageId !== undefined && !isUuid(body.messageId)) {
        return context.json({ error: "messageId must be a UUID." }, 400);
      }
      const channelId = context.req.param("channelId");
      const channel = await store.get(context.var.actor, channelId);
      if (!channel) return context.json({ error: "Channel not found." }, 404);

      try {
        const started = await rooms.post({
          actor: {
            id: context.var.actor.id,
            role: context.var.actor.role === "admin" ? "admin" : "user",
          },
          actorLabel: context.var.actor.email,
          channelId,
          threadId: channel.threadId,
          text,
          ...(typeof body?.messageId === "string"
            ? { messageId: body.messageId }
            : {}),
          addressedAgentIds: Array.isArray(body?.addressedAgentIds)
            ? body.addressedAgentIds.filter(
                (id): id is string => typeof id === "string",
              )
            : [],
          personName: context.var.actor.name?.trim() || "User",
        });
        return context.json(
          {
            turnId: started.turnId,
            messageId: started.messageId,
            epoch: started.epoch,
          },
          202,
        );
      } catch (error) {
        if (error instanceof RoomError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    });

    routes.post("/:channelId/room-turn/stop", requireUser, async (context) => {
      try {
        await rooms.stop(context.var.actor, context.req.param("channelId"));
        return context.body(null, 204);
      } catch (error) {
        if (error instanceof RoomError) {
          return context.json({ error: error.message }, error.status);
        }
        throw error;
      }
    });
  }

  /*
   * The room's transcript, read from the snapshot column directly.
   *
   * NOT the runtime's `/api/copilotkit/threads/:id/messages`: that route answers from what a run
   * put through the runner, and a room's messages are written by the server rather than by a run —
   * so a room read that way showed an empty screen.
   */
  routes.get("/:channelId/messages", requireUser, async (context) => {
    try {
      const channel = await store.get(
        context.var.actor,
        context.req.param("channelId"),
      );
      if (!channel) return context.json({ error: "Channel not found." }, 404);
      const messages = readThreadMessages
        ? await readThreadMessages(channel.threadId)
        : [];
      return context.json({ messages });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:channelId/message-times", requireUser, async (context) => {
    try {
      const channel = await store.get(
        context.var.actor,
        context.req.param("channelId"),
      );
      if (!channel) {
        return context.json({ error: "Channel not found." }, 404);
      }
      const marks = readMessageTimes
        ? await readMessageTimes(channel.threadId)
        : { times: {}, speakers: {} };
      /*
       * No backfill for rows written before speakers were recorded. It used to fill them in with
       * the room's first member — true of how the old code ran, but recomputed on every request
       * against the CURRENT membership, so adding a Bot whose id sorts first relabelled the whole
       * pre-attribution history to somebody who was not in the room when it was said. `attribute()`
       * refuses to guess a speaker for exactly this reason; this now refuses too, and an old
       * message simply carries no name.
       */
      return context.json({ times: marks.times, speakers: marks.speakers });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:channelId", requireUser, async (context) => {
    try {
      const channel = await store.get(
        context.var.actor,
        context.req.param("channelId"),
      );
      if (!channel) {
        return context.json({ error: "Channel not found." }, 404);
      }
      return context.json({ channel: channelDto(channel) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function channelDto(channel: AgentChannel): AgentChannel {
  return {
    id: channel.id,
    name: channel.name,
    agentIds: channel.agentIds,
    threadId: channel.threadId,
    active: channel.active,
  };
}

function channelSummaryDto(channel: ChannelSummary) {
  return {
    ...channelDto(channel),
    lastMessage: channel.lastMessage,
    // Serialised as ISO-8601 so the browser gets a string it can sort and format.
    lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
    lastMessageAgentId: channel.lastMessageAgentId,
    unread: channel.unread,
    createdAt: channel.createdAt.toISOString(),
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof ChannelNotFoundError) {
    return context.json({ error: "Channel not found." }, 404);
  }
  throw error;
}
