/**
 * What the channel routes accept, read off a body that may be anything, refused as a code.
 */
import type { ChannelRefusal } from "./routes";
import type { ChannelActivity } from "./types";

type ChannelInputParseResult =
  | { ok: true; value: { agentIds: string[] } }
  | { ok: false; code: ChannelRefusal };

type ChannelInputObject = { agentIds?: unknown };

export function parseChannelInput(input: unknown): ChannelInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, code: "laf:channel_input_invalid" };
  }

  if (!Array.isArray(input.agentIds) || input.agentIds.length === 0) {
    return { ok: false, code: "laf:channel_agents_required" };
  }

  const agentIds: string[] = [];
  for (const agentId of input.agentIds) {
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, code: "laf:channel_agents_invalid" };
    }
    agentIds.push(agentId.trim());
  }

  if (new Set(agentIds).size !== agentIds.length) {
    return { ok: false, code: "laf:channel_agents_duplicate" };
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
  | { ok: false; code: ChannelRefusal };

/**
 * Parse a reported message.
 *
 * `at` comes from the client that saw the message, because only it knows when the message arrived,
 * but it is never trusted as a clock: the store compares it against what is stored and only ever
 * moves forwards, so a wrong one can lose a report, not corrupt the row.
 */
export function parseActivityInput(input: unknown): ActivityInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, code: "laf:activity_invalid" };
  }
  const object = input as { text?: unknown; agentId?: unknown; at?: unknown };

  if (typeof object.text !== "string" || object.text.trim().length === 0) {
    return { ok: false, code: "laf:activity_text_required" };
  }
  /*
   * BOUNDED, because nothing else here is. Only a preview of this is ever stored, so a caller
   * sending a megabyte is not sending anything anybody will read — but the server still has to
   * receive it, parse it and run a preview over it. The limit is generous against any real message
   * and small against a request built to cost something.
   */
  if (object.text.length > MAX_ACTIVITY_TEXT) {
    return { ok: false, code: "laf:activity_too_long" };
  }
  if (object.agentId !== null && typeof object.agentId !== "string") {
    return { ok: false, code: "laf:activity_agent_invalid" };
  }
  if (typeof object.at !== "string") {
    return { ok: false, code: "laf:activity_time_required" };
  }
  const at = new Date(object.at);
  if (Number.isNaN(at.getTime())) {
    return { ok: false, code: "laf:activity_time_invalid" };
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

/** What a person says to a room, and which of its Bots they named with a chip. */
export type RoomTurnInput = {
  text: string;
  messageId?: string;
  addressedAgentIds: string[];
};

type RoomTurnInputParseResult =
  | { ok: true; value: RoomTurnInput }
  | { ok: false; code: ChannelRefusal };

/** Parse a person's message to a room. Checked in this order, and the first refusal is the answer. */
export function parseRoomTurnInput(input: unknown): RoomTurnInputParseResult {
  const body = input as {
    text?: unknown;
    messageId?: unknown;
    addressedAgentIds?: unknown;
  } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) {
    return { ok: false, code: "laf:room_message_empty" };
  }
  if (text.length > MAX_ROOM_TURN_TEXT) {
    return { ok: false, code: "laf:room_message_too_long" };
  }
  /*
   * The browser mints the message's id so it can draw the bubble before the round trip and
   * keep it through catch-up. That makes the id input, and input is validated: a UUID and
   * nothing else, or a caller could store a message under an id that already exists and have
   * two messages share one key.
   */
  if (body?.messageId !== undefined && !isUuid(body.messageId)) {
    return { ok: false, code: "laf:room_message_id_invalid" };
  }
  return {
    ok: true,
    value: {
      text,
      ...(typeof body?.messageId === "string"
        ? { messageId: body.messageId }
        : {}),
      addressedAgentIds: Array.isArray(body?.addressedAgentIds)
        ? body.addressedAgentIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
    },
  };
}
