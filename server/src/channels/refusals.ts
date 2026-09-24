/**
 * How a channel route says no: a code, twice, and no sentence.
 */
import type { Context } from "hono";
import { AgentNotFoundError } from "../agents/profile-store";
import { ChannelNotFoundError } from "./errors";
import type { ChannelRefusal } from "./routes";

/** The body every channel refusal is answered with: the code, twice, and no sentence. */
export function refusal(code: ChannelRefusal) {
  return { error: code, code };
}

/**
 * A code and no sentence, whichever class refused. The surface owns the words; see the classes.
 * Anything else is rethrown to the boundary in `app.ts`, which answers `laf:internal` and logs.
 *
 * ONE MAPPER FOR EVERY CLASS THESE ROUTES MEET. The room routes used to catch `RoomError` in two
 * hand-written copies beside this one (audit A1 §6, "error classes and mappers"); a room's refusal
 * and the store's are the same shape on the wire, and now the same line.
 */
export function mapRefusal(context: Context, error: unknown): Response {
  if (
    error instanceof AgentNotFoundError ||
    error instanceof ChannelNotFoundError
  ) {
    return context.json({ error: error.code, code: error.code }, error.status);
  }
  throw error;
}
