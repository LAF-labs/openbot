/**
 * The other thing a Bot can be blocked on: its own keyboard.
 *
 * `computer_request_help` and `computer_request_secret` are the two moments a Bot stops and cannot
 * continue without a person — a login it cannot complete, a password it must never see — and
 * neither goes through the approval registry, so neither reaches the buzz `notify.ts` puts on a
 * question. They were the leading gap in "a Bot is waiting" reaching anybody: on the browser path
 * the person is usually right there watching, and on every other path (a routine at seven, a room
 * turn) nothing at all happened.
 *
 * WHY THE TRAIL IS THE SEAM. Both already write a row — `computer.help_requested` and
 * `computer.secret_requested`, from `writeControlEvent` in `computer/gateway.ts` — and that row is
 * written on exactly the occasions worth telling somebody about, holds the Bot and the person, and
 * is the one place the two paths converge. A decorator here means the gateway keeps knowing nothing
 * about notifications, which is the same shape `withApprovalNotifications` uses on the registry
 * next door.
 *
 * IT CANNOT FAIL THE ROW IT IS WATCHING. The trail is the record; a notification is a convenience.
 * So the enqueue is fired and forgotten AFTER the insert has returned, never before it and never
 * inside it, and a throw from this file can only come from the store it wraps.
 */
import type { AuditEventInput, AuditStore } from "../audit";
import {
  TURN_FAILURE_CODES,
  type TurnFailureCode,
} from "../channels/turn-failures";
import type { NotificationOutbox } from "./outbox";

/** The rows that mean a Bot has stopped and is waiting on a person's hands. */
const NEEDS_YOU: ReadonlySet<string> = new Set([
  "computer.help_requested",
  "computer.secret_requested",
]);

/**
 * The third thing the trail already records on the right occasions: a routine that did not finish.
 *
 * `routine.ran` is written once per firing, whichever way it went, and `ok: false` is the half of it
 * nobody was told about — the 07:30 briefing that hit its deadline or lost its model left a red
 * line in the routine's own history, behind a disclosure on a page nobody opens at 07:30. The row
 * carries who to tell (`actor`), which conversation the failure was marked in (`channelId`, from
 * the failure path in routines/service.ts) and the failure as a fact code, so this is one more
 * decorator over the same seam and the routine service goes on knowing nothing about notifications.
 *
 * Only `routine.ran`. A room's failed turn has its own frame on the room's socket and a chat turn's
 * failure is on the screen it happened on; a run the process died on is reported by boot itself
 * (`runner/laf-runner.ts`), because no row is written for a run that never got to write one.
 */
const RUN_FAILED = "routine.ran";

const KNOWN_CODES = new Set<string>(Object.values(TURN_FAILURE_CODES));

/** A fact code off a payload, or the generic one: the surface has words for every code in the set. */
function failureCodeOf(value: unknown): TurnFailureCode {
  return typeof value === "string" && KNOWN_CODES.has(value)
    ? (value as TurnFailureCode)
    : TURN_FAILURE_CODES.unknown;
}

export function withOutboxWatch(
  store: AuditStore,
  outbox: NotificationOutbox,
): AuditStore {
  return {
    insert: async (event: AuditEventInput) => {
      await store.insert(event);
      if (event.eventType === RUN_FAILED) {
        if (event.payload.ok !== false) return;
        const botId = event.payload.agentId;
        const actor = event.payload.actor;
        if (typeof actor !== "string" || !actor) return;
        if (typeof botId !== "string" || !botId) return;
        void outbox
          .enqueue({
            kind: "run.failed",
            botId,
            userId: actor,
            ...(typeof event.payload.channelId === "string" &&
            event.payload.channelId
              ? { channelId: event.payload.channelId }
              : {}),
            run: {
              origin: "routine",
              ...(typeof event.payload.name === "string"
                ? { label: event.payload.name }
                : {}),
              code: failureCodeOf(event.payload.failure),
            },
          })
          .catch(() => undefined);
        return;
      }
      if (!NEEDS_YOU.has(event.eventType)) return;
      const botId = event.payload.bot;
      /*
       * WHO TO TELL COMES OFF THE PAYLOAD FIRST, and that is not a detail.
       *
       * `actor_user_id` is deliberately EMPTY for the local development fixture — a fixture is not
       * a person, so its id does not become the actor of a row (dev-actor.ts) — while `payload.actor`
       * holds the same id either way. Reading only the column meant every notification worked in a
       * real deployment and none of them worked on the machine where they are looked at, which is
       * the shape of bug this rule exists to catch: measured, on a running server, by a secret
       * request that wrote its trail row and told nobody.
       *
       * A person this deployment does not have is refused by the foreign key and logged by the
       * outbox — see its module note.
       */
      const actor =
        typeof event.payload.actor === "string" && event.payload.actor
          ? event.payload.actor
          : event.actorUserId;
      if (!actor || typeof botId !== "string" || !botId) return;
      void outbox
        .enqueue({ kind: "run.needs_you", botId, userId: actor })
        .catch(() => undefined);
    },
  };
}
