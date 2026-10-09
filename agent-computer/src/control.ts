/**
 * What the Bot has asked a person for, and the one value a person may put into its page.
 *
 * NOBODY DRIVES THIS BROWSER BUT THE BOT (owner, 2026-10-09). A person used to be able to take the
 * wheel — click and type on the Bot's page from the live screen — and this was the state machine
 * that said whose hands were on it. That is gone on every surface: a person watches the screen, and
 * the only way their typing reaches the page is the masked box a `computer_request_secret` opens.
 * What is left is the Bot's asks: for a hand with something outside its screen (approving on a
 * phone, confirming in an app), and for a value it must not be told.
 *
 * State lives in this process rather than in the server because this process owns the browser and
 * the box a value goes into. The server records the asks and decides who may answer them.
 *
 * This module has no Playwright import, so state-machine tests do not need a browser. Browser work
 * stays in `index.ts`.
 */
import { PERSON_WAIT_MS } from "../../shared/person-wait";

export type ControlState = {
  /**
   * Always the Bot. Kept on the wire because it is what every reader of this state was written
   * against — the server's wait, the surface's card — and what a file saved by an earlier release
   * says, which {@link restoredControl} reads as the Bot's whatever it held.
   */
  holder: "bot";
  since: string;
  /** Why the Bot asked, so the person knows what they are being handed. Set when the Bot requests. */
  reason?: string;
  /** True once the Bot has asked for help and nobody has answered yet. */
  requested: boolean;
  /**
   * A secret the Bot is waiting for, described by its label only.
   *
   * The one way a person's typing reaches the Bot's page. The Bot names the field, says what it
   * needs, and the person types into a masked box that goes straight to the page.
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
  /**
   * The last ask was let go of with nobody having answered it, because the tab it was about went
   * from under the Bot ({@link Control.tabLost}).
   *
   * SAID, BECAUSE AN ASK THAT IS GONE IS OTHERWISE READ AS AN ASK THAT WAS ANSWERED. The call
   * that asked is still waiting, and it reads "nothing asked" as the person having come and gone
   * (`shared/person-wait.ts`). An ask that ran out is let go of only
   * after that wait is over ({@link REQUEST_TTL_MS}); this one is let go of in the middle of it, so
   * the state has to say which it was. There until the next ask or answer.
   */
  unanswered?: true;
};

/** What a caller must say to ask for a secret. Rejected as a request error, not thrown. */
export class ControlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlRequestError";
  }
}

/** A person's value arrived and nothing had asked for one. */
export const NO_SECRET_PENDING = "laf:secret_not_pending";

/**
 * How long an ask nobody answered stands — for a hand, or for a value — before it is let go of.
 *
 * AN ASK USED TO STAND FOR EVER. An ask belongs to the computer and not to a conversation, so
 * when the Bot's wait gave up or its turn was stopped, nothing took the ask back: measured, both
 * kinds still stood with the clock moved on eleven minutes. The surface draws 도움 필요, and the
 * reason, from this state alone, in whichever conversation is open; and the masked box's door
 * takes a value for as long as one is wanted. Upstream OpenBot #145 and #457.
 *
 * LONGER THAN THE BOT'S OWN WAIT, WHERE UPSTREAM'S IS THE SAME TEN MINUTES. Here the call that
 * asked is still waiting, and it reads "nothing asked" as the person having answered
 * (`server/src/turns/chat-tools.ts`). That wait begins only once the answer to the ask has travelled back, and its last look
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
 * What the last life of this process left behind, as far as the next one may believe it.
 *
 * A SAVED HUMAN HOLD IS THE BOT'S. Until 2026-10-09 a person could hold the wheel, and a restart in
 * the middle of that was restored as theirs, so the Bot could not click on a form they were still
 * filling in. Nobody can hold it now, and a file saved by an earlier release mid-takeover would
 * otherwise leave a Bot refused every action for ever by a hold no screen can hand back. So it is
 * not restored. It is marked as an ask nobody answered ({@link ControlState.unanswered}): the person
 * did not say they were done, the upgrade ended it, and a wait still reading this state must not
 * hear that they came and did it.
 *
 * A PENDING SECRET REQUEST IS DROPPED. It named a ref from a snapshot of a page in a browser that no
 * longer exists, so the masked box would be pointed at nothing; and a person typing their password
 * into a box that quietly goes nowhere is worse than being asked again. The Bot is told, with
 * `laf:secret_request_lost`, so it asks again against a fresh snapshot instead of waiting for an
 * answer nobody can give.
 *
 * AN ASK A RESTART CUT SHORT IS NOBODY'S ANSWER — an ask for a hand as much as an ask for a value.
 * The call waiting on it is the server's, not this process's, and it outlives the restart: it reads
 * this state every few seconds, and an ask that is simply gone reads to it as one answered
 * (`shared/person-wait.ts`). Restored as nothing, the Bot was told the person had approved on their
 * phone, or had typed the value, when the restart had only taken the ask away (review, 2026-10-09).
 * So every ask that was standing comes back as one nobody answered, the same as a hold above.
 *
 * Anything unreadable is treated as nothing, and nothing is the Bot's fresh state.
 */
export function restoredControl(saved: unknown): {
  state?: ControlState;
  secretLost: boolean;
} {
  if (!saved || typeof saved !== "object") return { secretLost: false };
  const held = saved as {
    holder?: unknown;
    requested?: unknown;
    secretWanted?: unknown;
  };
  const secretLost =
    typeof held.secretWanted === "string" && !!held.secretWanted;
  const wasAsked =
    held.holder === "human" || held.requested === true || secretLost;
  if (!wasAsked) return { secretLost };
  return {
    state: {
      holder: "bot",
      since: new Date().toISOString(),
      requested: false,
      unanswered: true,
    },
    secretLost,
  };
}

/**
 * The asks, as a state machine.
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
   * ones who care are whoever looks next — the surface's poll, or a value arriving for the masked
   * box.
   *
   * The reason goes with the ask for a hand — it is what 도움 필요 was drawn with — and the field
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
      if (state.requested) {
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
     * The Bot asking for a hand with something outside its screen — a phone to approve on, an app
     * to confirm in. It says what and why, and a person answers: done, or skip.
     */
    requestHelp(reason: unknown): ControlState {
      // Stamped on every ask, not only the first: a Bot that asks again is waiting again, and an
      // ask running out under that second wait is the hand-back that never happened.
      helpAskedAt = Date.parse(now());
      state = {
        ...state,
        unanswered: undefined,
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
        unanswered: undefined,
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
     * The value could not be put in the field, and the request is closed as nobody's answer.
     *
     * CLOSED, because the field is gone and a person would retype their password into the same
     * dead ref for ever. AS NOBODY'S ANSWER, because closing it any other way is read as the value
     * having been typed: until 2026-10-05 this was `secretSupplied`, and the Bot was told "이
     * 사람이 그 값을 칸에 직접 입력했다" about a value that reached no field.
     */
    secretNotSupplied(): void {
      if (secretAskedAt !== undefined) secretAskedAt = undefined;
      const {
        secretWanted: _was,
        secretRef: _ref,
        secretSnapshotId: _id,
        ...rest
      } = state;
      state = { ...rest, unanswered: true };
      changed();
    },

    /**
     * THE CALLER THAT ASKED FOR A VALUE HAS STOPPED, and takes its ask back.
     *
     * Only the value, and only the one that caller asked for: a hand another turn is still
     * waiting on is not this caller's to end, and `release` — which is a person's answer — ends
     * both and marks neither, so the turn waiting on the hand was told the person had done it
     * (Codex's second read of the change that began taking asks back). The ref and the snapshot
     * the ask was made with say which one it is; an ask that has since been answered, or replaced
     * by a later one, is left exactly as it is.
     *
     * Says whether there was one to take back.
     */
    withdrawSecret(asked: { ref?: unknown; snapshotId?: unknown }): boolean {
      lapse();
      if (!state.secretWanted || state.secretRef !== asked.ref) return false;
      if (state.secretSnapshotId !== asked.snapshotId) return false;
      secretAskedAt = undefined;
      const {
        secretWanted: _was,
        secretRef: _ref,
        secretSnapshotId: _id,
        ...rest
      } = state;
      // Nobody's answer, like every ask that ends without one: nothing reads this as a value.
      state = { ...rest, unanswered: true };
      changed();
      return true;
    },

    /**
     * The tab the Bot was on has gone from under it, and every ask about that tab goes with it.
     *
     * A value was wanted for a box on a page that no longer exists, and a hand for a page nobody
     * can be shown. Left standing, the masked box would take a person's password for a ref that
     * now names whatever the Bot's other tab calls it — measured 2026-10-05, before this: a value
     * asked for on a sign-in popup, typed after the popup's renderer died, went into the page
     * behind it. So both asks end here, marked as nobody's answer ({@link ControlState.unanswered}).
     *
     * Says whether there was an ask to end.
     */
    tabLost(): boolean {
      lapse();
      const helpAsked = state.requested;
      const secretAsked = Boolean(state.secretWanted);
      if (!helpAsked && !secretAsked) return false;
      // Neither is timed any more: there is nothing left to run out.
      if (helpAsked) helpAskedAt = undefined;
      if (secretAsked) secretAskedAt = undefined;
      // The value's label goes with the field it named, as everywhere an ask for one ends.
      const {
        secretWanted: _was,
        secretRef: _ref,
        secretSnapshotId: _id,
        ...rest
      } = state;
      state = {
        ...rest,
        ...(helpAsked ? { requested: false, reason: undefined } : {}),
        unanswered: true,
      };
      changed();
      return true;
    },

    /**
     * A person answering: 다 했어요, or 건너뛰기 once the skip has been told to the turn that waits.
     *
     * `reason` is dropped: it described the thing the person was asked to do, and once they have
     * answered, leaving it set would have the surface still showing the old request. Any pending
     * secret goes with it, since 건너뛰기 on the masked box comes here too, and a box left open
     * afterwards is asking for a password nothing is waiting for.
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
  };
}

export type Control = ReturnType<typeof createControl>;
