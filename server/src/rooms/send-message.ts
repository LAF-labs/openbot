/**
 * The only way a Bot can put words in a room.
 *
 * A room turn does not deliver whatever prose the model produced. It offers one tool, and what the
 * model passes to it is the message; everything else it writes is private scratch space nobody
 * sees. Three things follow from that, and all three are why the reference does it this way:
 *
 * SILENCE IS UNAMBIGUOUS. A turn that ends without calling this is a Bot with nothing to add —
 * not a Bot whose answer we failed to parse, and not a Bot forced to say "(pass)" out loud.
 *
 * WORKING IS PRIVATE. A member can open a page, read a file and think about it mid-turn without
 * narrating any of that at five colleagues; only the sentence it chooses to send lands in the room.
 *
 * THE FLOOR IS SHARED. A Bot gets three messages in a room turn, and the fourth is refused with a
 * sentence it can act on rather than dropped. Without a cap one member fills the whole turn and
 * the others never speak.
 */
import type { Tool } from "@ag-ui/client";
import { ROOM_MESSAGES_PER_MEMBER } from "./prompt";
import type {
  ToolExecutor,
  ToolOutcome,
  UnattendedToolkit,
} from "../runner/unattended";

export const SEND_MESSAGE = "send_message";

const SEND_MESSAGE_TOOL: Tool = {
  name: SEND_MESSAGE,
  description:
    "Say something the room can see. This is the only way to speak in a room: plain text you " +
    "write is private scratch space nobody reads. Keep it short and conversational — one to " +
    "three sentences. If you have nothing worth adding, do not call this at all.",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "What to say to the room, in your own voice.",
      },
    },
    required: ["text"],
  },
};

/**
 * The member's toolkit for one room turn: everything it normally has, plus a way to speak.
 *
 * `send_message` is answered here and never reaches the gateway — it is not an action on anybody's
 * computer, it is the turn's output. `deliver` is called with each accepted message so the caller
 * can post it while the turn is still running, which is what lets the room show a member's first
 * message before it has finished thinking about its second.
 */
export function roomToolkit(
  base: UnattendedToolkit,
  deliver: (text: string) => Promise<void>,
): UnattendedToolkit & { spoken: () => number } {
  let spoken = 0;

  const execute: ToolExecutor = async (name, args) => {
    if (name !== SEND_MESSAGE) return base.execute(name, args);

    const text = typeof args.text === "string" ? args.text : "";
    if (text.trim().length === 0) {
      return {
        ok: false,
        reason:
          "Nothing was sent: an empty message is the same as staying silent. End your turn " +
          "instead if you have nothing to add.",
      } satisfies ToolOutcome;
    }
    if (spoken >= ROOM_MESSAGES_PER_MEMBER) {
      return {
        ok: false,
        reason:
          `Not delivered — you have reached this room turn's ${ROOM_MESSAGES_PER_MEMBER}-message ` +
          "limit. Consolidate, or wait for your next turn.",
      } satisfies ToolOutcome;
    }

    spoken += 1;
    await deliver(text);
    return { ok: true, delivered: true } satisfies ToolOutcome;
  };

  return {
    tools: [SEND_MESSAGE_TOOL, ...base.tools],
    execute,
    spoken: () => spoken,
  };
}
