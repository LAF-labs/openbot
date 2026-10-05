/**
 * When each message in a thread was first seen and which Bot said it.
 *
 * Straight out of the store, and deliberately not through the runner's `getThreadMessages`, while
 * there was one (it went with the run door, 2026-10-06). That method preferred
 * CopilotKit's in-memory copy for a live thread, and the in-memory copy is AG-UI's own — it has
 * never carried our `lafAt` and never will. The stamps only exist in the stored jsonb.
 *
 * The other door was closed too: `GET /api/copilotkit/threads/:id/messages` rebuilt each message
 * from a fixed whitelist of keys, so a timestamp on the stored object was dropped on the way out
 * whatever the store held. That is why the times got a route of their own rather than a field.
 *
 * The reading itself lives in `thread-store.ts` with everything else that touches the table; this
 * file is the name the routes already know it by.
 */
export { createMessageMarkReader as createMessageTimeReader } from "./thread-store";
