/**
 * `/api/channels`: the route modules, put together. Nothing is answered in this file.
 *
 *   events-routes.ts        the live feed socket
 *   roster-routes.ts        the last thing said, and the read mark
 *   room-routes.ts          a room's turn, run on the server
 *   transcript-routes.ts    messages, when each was said, and the turns that failed
 *   participant-routes.ts   who is in the conversation
 *   conversation-routes.ts  start one, list them, read one
 *
 * The store is put together the same way in `store.ts`, and re-exported here with the rest of what
 * this module has always exported, so nothing that imports it had to change.
 */
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { createConversationRoutes } from "./conversation-routes";
import type { ChannelMembershipRefusal } from "./errors";
import type { ChannelEventHub } from "./events";
import { createEventRoutes } from "./events-routes";
import { createParticipantRoutes } from "./participant-routes";
import { createRoomRoutes, type RoomTurns } from "./room-routes";
import { createRosterRoutes } from "./roster-routes";
import { createTranscriptRoutes } from "./transcript-routes";
import type {
  ChannelStore,
  ReadMessageTimes,
  ReadThreadMessages,
} from "./types";

export {
  ChannelMembershipError,
  type ChannelMembershipRefusal,
  ChannelNotFoundError,
} from "./errors";
export { parseActivityInput, parseChannelInput } from "./input";
export { createChannelStore } from "./store";
export type {
  AgentChannel,
  ChannelActivity,
  ChannelStore,
  ChannelSummary,
} from "./types";

/**
 * The refusals a channel route answers with, as facts.
 *
 * Every one used to be an English sentence in `error` and nothing else — "Agent IDs must be a
 * non-empty array.", "Channel not found." — which the surface could only show as it was. The
 * words are the surface's (`CHANNEL_REFUSALS`, app/src/lib/channels/mutations.ts); the code is
 * what crosses. Kept as one union so the app's table can be checked against it — and kept HERE,
 * in the file every route module is mounted from, because that check reads this file's source
 * (app/tests/channel-refusals.test.ts). A new code handed to `refusal()` or returned by a parser
 * does not compile until it is in this union, and so reaches the check.
 */
export type ChannelRefusal =
  | ChannelMembershipRefusal
  | "laf:channel_not_found"
  | "laf:channel_input_invalid"
  | "laf:channel_agents_required"
  | "laf:channel_agents_invalid"
  | "laf:channel_agents_duplicate"
  | "laf:activity_invalid"
  | "laf:activity_text_required"
  | "laf:activity_too_long"
  | "laf:activity_agent_invalid"
  | "laf:activity_time_required"
  | "laf:activity_time_invalid"
  | "laf:read_flag_invalid"
  | "laf:room_message_empty"
  | "laf:room_message_too_long"
  | "laf:room_message_id_invalid";

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
  readMessageTimes?: ReadMessageTimes,
  /** Runs a room's turn on the server. Absent leaves the room routes unmounted. */
  rooms?: RoomTurns,
  /** The room's transcript, straight out of the snapshot. Absent serves an empty room. */
  readThreadMessages?: ReadThreadMessages,
  /**
   * Which origins may open the activity socket. LAST, like everything new here.
   *
   * EMPTY REFUSES EVERY UPGRADE, which is the honest degraded behaviour and not an oversight: a
   * deployment that cannot say which origins it trusts cannot tell one customer's page from
   * another's, and this product puts every customer under one registrable domain — so `SameSite`
   * decides nothing between them and the session cookie alone was the whole check. Everything else
   * on these routes keeps working; only the live feed goes quiet.
   */
  trustedOrigins: readonly string[] = [],
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /*
   * ORDER MATTERS AT BOTH ENDS, and only there.
   *
   * `/events` goes FIRST and `/:channelId` LAST, because a single-segment path that is not a
   * channel id is otherwise read as one. And it is not only a question of which route is found:
   * a plain GET the socket declines to upgrade falls through to the next route that matches, which
   * must still be the channel read answering 404. Every other path here has a literal segment after
   * the id, so nothing between the two can shadow anything.
   */
  if (events) {
    routes.route("/", createEventRoutes(events, requireUser, trustedOrigins));
  }
  routes.route("/", createRosterRoutes(store, requireUser, readMessageTimes));
  if (rooms) routes.route("/", createRoomRoutes(store, requireUser, rooms));
  routes.route(
    "/",
    createTranscriptRoutes(
      store,
      requireUser,
      readMessageTimes,
      readThreadMessages,
    ),
  );
  routes.route("/", createParticipantRoutes(store, requireUser));
  routes.route("/", createConversationRoutes(store, requireUser));

  return routes;
}
