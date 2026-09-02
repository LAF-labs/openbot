/**
 * When each message in a thread was first seen and which Bot said it.
 *
 * Straight out of the store, and deliberately not through `getThreadMessages`. That method prefers
 * CopilotKit's in-memory copy for a live thread, and the in-memory copy is AG-UI's own — it has
 * never carried our `lafAt` and never will. The stamps only exist in the stored jsonb.
 *
 * The other door is closed too: `GET /api/copilotkit/threads/:id/messages` rebuilds each message
 * from a fixed whitelist of keys, so a timestamp on the stored object is dropped on the way out
 * whatever the store holds. That is why the times need a route of their own rather than a field.
 *
 * The reading itself lives in `thread-store.ts` with everything else that touches the table; this
 * file is the name the routes already know it by.
 */
export {
  createMessageMarkReader as createMessageTimeReader,
  type MessageSpeakers,
  type MessageTimes,
  type ThreadMarks,
} from "./thread-store";
