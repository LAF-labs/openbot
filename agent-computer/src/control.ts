/**
 * Who has the wheel.
 *
 * One browser has at most one driver. When a Bot meets a login wall it can ask for
 * help; a person takes control, does the part only they can do, and hands back. While a person holds
 * control every acting call from the Bot is refused, because two drivers on one page is how a Bot
 * clicks "Confirm" on a form a human was still filling in.
 *
 * State lives in this process rather than in the server because this process owns the browser, and a
 * takeover that the browser does not know about is not a takeover. The server records it and decides
 * who may ask for it; this decides whether the next action happens.
 *
 * This module has no Playwright import, so state-machine tests do not need a browser. Browser work
 * stays in `index.ts`.
 */
import { PERSON_WAIT_MS } from "../../shared/person-wait";

export type ControlState = {
  holder: "bot" | "human";
  since: string;
  /** Why the Bot asked, so the person knows what they are being handed. Set when the Bot requests. */
  reason?: string;
  /** True once the Bot has asked for help and no person has taken the wheel yet. */
  requested: boolean;
  /**
   * A secret the Bot is waiting for, described by its label only.
   *
   * Secret entry is scoped rather than a full takeover. The Bot names the field, says what it needs,
   * and the person types into a masked box that goes straight to the page.
   *
   * The label is all that is ever stored. The value passes through one request and is not kept here,
   * not returned, and not on any path the model reads.
   */
  secretWanted?: string;
  /**
   * Which field the secret goes in, as a ref from the Bot's snapshot.
   *
   * Required so a secret cannot be sent to whichever field happens to have focus.
   */
  secretRef?: string;
  secretSnapshotId?: number;
};

/** Refusal because a person is driving. Distinct from a failure, so the Bot can be told to wait. */
export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlError";
  }
}

/** What a caller must say to ask for a secret. Rejected as a request error, not thrown. */
export class ControlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlRequestError";
  }
}

/** A person's value arrived and nothing had asked for one. A code, for the reason below. */
export const NO_SECRET_PENDING = "laf:secret_not_pending";
/**
 * A FACT CODE, NOT A SENTENCE.
 *
 * This was an English paragraph addressed to a model — it forbids the retry
 * loop by name, because "wait before acting" alone left retrying the same
 * click a legal reading and the eval pack measured a reasoning model taking
 * it, one refused click in six, the day glm-5.3-flash was judged. The wording
 * still exists and still says exactly that; it lives in
 * `shared/prompt/tool-results.ko.ts`, in Korean, with the rest of the words a
 * model reads. This container ships a code, so the sentence a Korean Bot reads
 * is not decided by an English service that has never heard of a locale.
 */
export const HUMAN_HAS_CONTROL = "laf:human_has_control";
/** A person's own input, before they took the wheel. The live-screen pane has words for it. */
export const TAKE_CONTROL_FIRST = "laf:take_control_first";

/**
 * How long an ask nobody answered stands — for the wheel, or for a value — before it is let go of.
 *
 * AN ASK USED TO STAND FOR EVER. The wheel belongs to the computer and not to a conversation, so
 * when the Bot's wait gave up or its turn was stopped, nothing took the ask back: measured, both
 * kinds still stood with the clock moved on eleven minutes. The surface draws 도움 필요, and the
 * reason, from this state alone, in whichever conversation is open; and the masked box's door
 * takes a value for as long as one is wanted. Upstream OpenBot #145 and #457.
 *
 * LONGER THAN THE BOT'S OWN WAIT, WHERE UPSTREAM'S IS THE SAME TEN MINUTES. Here the call that
 * asked is still waiting, and it reads "nothing asked, and the Bot holds the wheel" as the person
 * having handed the wheel back (`server/src/turns/chat-tools.ts`, and a window's own wait in the
 * app). That wait begins only once the answer to the ask has travelled back, and its last look
 * can still be on its way when its time is up — so an ask let go of at ten minutes is read by
 * that look as "they came, and it is done" when nobody came. Measured with this a minute short of
 * the wait: the Bot was told `laf:control_returned`, and `laf:secret_entered`. Two minutes over,
 * because the server gives each of those two calls 45 seconds at most
 * (`server/src/computer/client.ts`); and made from the wait's own number, so one cannot move
 * without the other.
 *
 * WHY THE COMPUTER LETS GO, RATHER THAN THE WAIT TAKING ITS ASK BACK. A wait that ends could say
 * so, but one can end without a word — the API process restarted, the window carrying it closed —
 * and then only whoever holds the ask can end it. The price is that the ask still shows for the
 * two minutes after a wait gives up, and for up to this long after a turn is stopped.
 */
export const REQUEST_TTL_MS = PERSON_WAIT_MS + 2 * 60_000;

/**
 * Who was driving when the process died, as far as the next process may believe it.
 *
 * THE FAIL-SAFE ONLY EVER MAKES CONTROL STICKIER. A restart in the middle of a takeover used to hand
 * the wheel back to the Bot in silence — the person was still in front of a login form, and the Bot
 * was free to click on it. So a saved `human` is restored, and a saved `bot` is not "restored" at
 * all, it is simply the default: there is no path here by which reading a file can take control away
 * from a person.
 *
 * A PENDING SECRET REQUEST IS DROPPED. It named a ref from a snapshot of a page in a browser that no
 * longer exists, so the masked box would be pointed at nothing; and a person typing their password
 * into a box that quietly goes nowhere is worse than being asked again. The Bot is told, with
 * `laf:secret_request_lost`, so it asks again against a fresh snapshot instead of waiting for an
 * answer nobody can give.
 *
 * Anything unreadable is treated as nothing, and nothing is the Bot holding the wheel.
 */
export function restoredControl(saved: unknown): {
  state?: ControlState;
  secretLost: boolean;
} {
  if (!saved || typeof saved !== "object") return { secretLost: false };
  const held = saved as Partial<ControlState>;
  const secretLost =
    typeof held.secretWanted === "string" && !!held.secretWanted;
  if (held.holder !== "human") return { secretLost };
  return {
    state: {
      holder: "human",
      since:
        typeof held.since === "string" && held.since
          ? held.since
          : new Date().toISOString(),
      // What they were asked to do survives with them: they are still standing in front of it.
      ...(typeof held.reason === "string" && held.reason
        ? { reason: held.reason }
        : {}),
      // Somebody holding the wheel is not somebody waiting to be given it.
      requested: false,
    },
    secretLost,
  };
}

/**
 * The wheel, as a state machine.
 *
 * A factory rather than a module-level `let` so a test can have its own, and so two of these cannot
 * accidentally share state. `now` is injected for the same reason: `since` is part of the published
 * state, and a test that cannot control the clock has to either skip it or match it loosely.
 */
export function createControl(
  now: () => string = () => new Date().toISOString(),
  options: {
    /** What survived the last life of this process. See {@link restoredControl}. */
    initial?: ControlState;
    /**
     * Told after every change, so it can be written down.
     *
     * A callback rather than a path, because this module has no filesystem in it and a state machine
     * that opens files cannot be tested without one.
     */
    onChange?: (state: ControlState) => void;
  } = {},
) {
  let state: ControlState = options.initial ?? {
    holder: "bot",
    since: now(),
    requested: false,
  };

  /** The new state, handed to whoever is keeping it, and to the caller. */
  const changed = (): ControlState => {
    const copy = { ...state };
    options.onChange?.(copy);
    return copy;
  };

  /**
   * When each ask was made, so one nobody answered can be let go of ({@link REQUEST_TTL_MS}).
   *
   * Here and not on the state: nothing outside needs them, and the state is what a screen asking
   * somebody for a password is drawn from. An ask in the state this starts from is timed from now
   * (`restoredControl` hands back none, so only a caller that builds one meets this).
   */
  let helpAskedAt = state.requested ? Date.parse(now()) : undefined;
  let secretAskedAt = state.secretWanted ? Date.parse(now()) : undefined;

  /**
   * Let go of an ask that has stood its time.
   *
   * ON A LOOK, NOT ON A TIMER: there is nothing to wake. The wait that asked is over, and the only
   * ones who care are whoever looks next — the surface's poll, a value arriving for the masked box,
   * a person taking the wheel.
   *
   * ONLY EVER AN ASK. A person holding the wheel is never timed out from under their hands: they
   * may be half-way through typing a code, and taking the browser back mid-sign-in is worse than
   * any stale line. (Taking the wheel answers the ask, so there is none to let go of by then.)
   *
   * The reason goes with the ask for the wheel — it is what 도움 필요 was drawn with — and the field
   * with the label, since half an ask is nothing anybody downstream can read. And the keeper is
   * told, so the file does not go on saying what `get` has stopped saying: a restart would report
   * a value request "lost" (`restoredControl`) that had only run out.
   */
  const lapse = (): void => {
    if (helpAskedAt === undefined && secretAskedAt === undefined) return;
    const at = Date.parse(now());
    let lapsed = false;
    if (helpAskedAt !== undefined && at - helpAskedAt > REQUEST_TTL_MS) {
      helpAskedAt = undefined;
      if (state.holder === "bot" && state.requested) {
        state = { ...state, requested: false, reason: undefined };
        lapsed = true;
      }
    }
    if (secretAskedAt !== undefined && at - secretAskedAt > REQUEST_TTL_MS) {
      secretAskedAt = undefined;
      if (state.secretWanted) {
        state = {
          ...state,
          secretWanted: undefined,
          secretRef: undefined,
          secretSnapshotId: undefined,
        };
        lapsed = true;
      }
    }
    if (lapsed) changed();
  };

  return {
    /** The current state, as the surface polls it. A copy, so a caller cannot mutate the machine. */
    get(): ControlState {
      lapse();
      return { ...state };
    },

    /**
     * The Bot asking for help.
     *
     * It does not take control: it says it is stuck and why, and a person decides. A Bot that could
     * hand itself to a human could also hand a human a page they never asked to see.
     */
    requestHelp(reason: unknown): ControlState {
      // Stamped on every ask, not only the first: a Bot that asks again is waiting again, and an
      // ask running out under that second wait is the hand-back that never happened.
      helpAskedAt = Date.parse(now());
      state = {
        ...state,
        requested: true,
        reason:
          typeof reason === "string" && reason.trim()
            ? reason.trim()
            : "The assistant needs a person to continue.",
      };
      return changed();
    },

    /** The Bot asking for one value it must not be told, naming the field it goes in. */
    requestSecret(input: {
      label?: unknown;
      ref?: unknown;
      snapshotId?: unknown;
    }): ControlState {
      if (typeof input.ref !== "string" || !input.ref.trim()) {
        throw new ControlRequestError(
          "Say which field the value goes in, using a ref from your snapshot.",
        );
      }
      secretAskedAt = Date.parse(now());
      state = {
        ...state,
        secretWanted:
          typeof input.label === "string" && input.label.trim()
            ? input.label.trim()
            : "the value this page is asking for",
        secretRef: input.ref.trim(),
        secretSnapshotId:
          typeof input.snapshotId === "number" ? input.snapshotId : undefined,
      };
      return changed();
    },

    /**
     * The pending secret request, or null.
     *
     * Read before typing so the caller can refuse when nothing asked for one: this is what keeps the
     * masked box from being a general-purpose way to type into the page.
     *
     * Which is why an ask that has run out is let go of here as well as in `get`: a box that has
     * stopped being shown must stop being answerable at the same moment, or a value typed into one
     * left open in an old window still goes to a page whose turn ended.
     */
    pendingSecret(): { ref: string; snapshotId?: number } | null {
      lapse();
      if (!state.secretWanted || !state.secretRef) return null;
      return { ref: state.secretRef, snapshotId: state.secretSnapshotId };
    },

    /**
     * The secret landed, so the request is closed.
     *
     * Called only after the value reaches the field. A failure leaves the request open so the person
     * can try again.
     */
    secretSupplied(): void {
      secretAskedAt = undefined;
      state = {
        ...state,
        secretWanted: undefined,
        secretRef: undefined,
        secretSnapshotId: undefined,
      };
      changed();
    },

    /**
     * A person taking the wheel.
     *
     * `reason` survives, because it is the thing they were just asked to do. Any pending secret is
     * cleared: a person with full browser control can type the password into the page, and a masked
     * box left open behind them no longer corresponds to an active request.
     *
     * An ask that had already run out is let go of first, so its reason is not what this person is
     * told they were handed. Taking the wheel answers whatever ask is left: neither is timed again.
     */
    take(): ControlState {
      lapse();
      helpAskedAt = undefined;
      secretAskedAt = undefined;
      state = {
        holder: "human",
        since: now(),
        reason: state.reason,
        requested: false,
      };
      return changed();
    },

    /**
     * A person handing back.
     *
     * `reason` is dropped: it described the thing the person was asked to do, and once they have done
     * it, leaving it set would have the surface still showing the old request. Any pending secret goes
     * with it, a person who took the whole wheel and handed it back has dealt with the login, and a
     * secret box left open afterwards is asking for a password nothing is waiting for.
     */
    release(): ControlState {
      helpAskedAt = undefined;
      secretAskedAt = undefined;
      state = {
        holder: "bot",
        since: now(),
        requested: false,
      };
      return changed();
    },

    /**
     * The Bot may not act while a person holds the wheel.
     *
     * Refused rather than queued. A queued click lands after the person has moved on and is worse than
     * a refusal, which the Bot can explain and wait out.
     */
    assertBotMayAct(): void {
      if (state.holder === "human") throw new ControlError(HUMAN_HAS_CONTROL);
    },

    /** Whether a person's input should be applied. The socket being open is not permission. */
    humanMayDrive(): boolean {
      return state.holder === "human";
    },
  };
}

export type Control = ReturnType<typeof createControl>;
