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

  /*
   * ONE BOT A CONVERSATION. Rooms — a conversation with several Bots in it — were removed on
   * 2026-09-24 with the decision that a person has one Bot (docs/laf/deployment-model.md). Nothing
   * can run a conversation of two any more, so one is refused here rather than created and left
   * with nobody able to answer in it. The body keeps its list shape so the client did not change.
   */
  if (agentIds.length > 1) {
    return { ok: false, code: "laf:channel_one_bot" };
  }

  return { ok: true, value: { agentIds: agentIds.sort() } };
}

function isChannelInputObject(input: unknown): input is ChannelInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** As much reported text as any real message has, and far less than a request built to cost. */
const MAX_ACTIVITY_TEXT = 100_000;

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
