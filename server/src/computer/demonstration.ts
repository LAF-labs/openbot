/**
 * What somebody did while showing a Bot how a task is done.
 *
 * A Bot already knows how to click things; what it lacks is knowing what to do. The cheapest way to
 * tell it is to do the task once, in its own browser, with it watching — and that is a thing this
 * product can already do, because taking the wheel puts a person in exactly that browser.
 *
 * NOT A MACRO. What arrives over the socket is `click at (412, 338)`, which is a fact about one
 * render of one page at one window size and is worth nothing the next time: it is precisely why the
 * gateway decides on refs the server resolved rather than on coordinates. So each click is turned
 * into the name of the thing that was clicked, and the result is a trace of what happened rather
 * than a sequence to replay. A procedure survives a site redesign; a macro does not.
 *
 * IT NEVER RECORDS WHAT WAS TYPED, and that is not a preference. Every keystroke a person makes in
 * that browser passes through this module, including the password they use to sign in to their own
 * bank — the surface sends `text` on printable keys and pastes arrive whole. So typing is recorded
 * as the fact that typing happened, the same rule and the same reason as the audit trail's
 * fingerprint, which leaves out the text for exactly this. Nothing here writes a value anywhere.
 *
 * IN MEMORY, AND ONLY WHILE THE WHEEL IS HELD. A demonstration is a live session: it belongs to one
 * socket, in one process, and it ends when the person hands back. A restart in the middle loses it,
 * which is honest — the browser it described has moved on too. Nothing here outlives the session it
 * describes, which is why it is not a table.
 */

/** One thing that happened, in the terms a procedure would be written from. */
export type DemonstrationStep =
  /** A page was opened. The URL is the step. */
  | { kind: "opened"; url: string; at: number }
  /** Something was pressed. Named where the page had a name for it. */
  | {
      kind: "pressed";
      element: { role: string; name: string } | null;
      at: number;
    }
  /**
   * Text was entered. WHAT was entered is deliberately absent.
   *
   * `into` is the last thing pressed, which is nearly always the field, and it is what makes the
   * step readable: "typed into 검색" rather than "typed".
   */
  | { kind: "typed"; into: string | null; at: number }
  /** A key that means something on its own — Enter, Escape, a shortcut. Never a printable one. */
  | { kind: "key"; key: string; at: number };

export type Demonstration = {
  botId: string;
  startedBy: string;
  startedAt: number;
  steps: DemonstrationStep[];
  /** True once the person handed the wheel back. A finished one is what gets written up. */
  finished: boolean;
};

/**
 * How many steps one demonstration may hold.
 *
 * A person showing a task takes tens of actions; a person who left the tab open and did their
 * afternoon's work in it takes thousands. The cap is what stops the second from becoming a summary
 * nobody can read and a model call nobody wants to pay for. Reaching it stops recording rather than
 * dropping the beginning: the start of a demonstration is the part that explains it.
 */
export const MAX_STEPS = 300;

/**
 * Two mouse messages make one press, and only one of them is a step.
 *
 * `pressed` and `released` both arrive. The press is where the interesting thing is — it is what
 * the page acts on — and recording both would double every step in the write-up.
 */
type SocketMessage = {
  type?: unknown;
  event?: unknown;
  x?: unknown;
  y?: unknown;
  key?: unknown;
};

/** Resolves what is at a point on the Bot's screen. Absent leaves presses unnamed but recorded. */
export type PointNamer = (
  botId: string,
  point: { x: number; y: number },
) => Promise<{ role: string; name: string } | null>;

export type DemonstrationRecorder = {
  /** Begin. Replaces any demonstration already running for this Bot, which a new one supersedes. */
  start: (botId: string, actor: string) => void;
  /** Whether this Bot is being taught right now. Checked on the hot path of every input message. */
  recording: (botId: string) => boolean;
  /**
   * One message on its way to the browser.
   *
   * Never throws and never delays the message: this sits in the middle of somebody's live typing,
   * and a recorder that made the mouse stutter would be worse than no recorder. Naming a press is
   * asynchronous and is therefore fired and forgotten — a step whose name arrives late is appended
   * in order of when it was pressed, and one whose lookup fails is kept unnamed.
   */
  observe: (botId: string, message: unknown) => void;
  /** Hand back. The demonstration is closed and returned, or null if nothing was being recorded. */
  finish: (botId: string) => Demonstration | null;
  /** What was recorded, finished or not. Null when this Bot is not being taught. */
  read: (botId: string) => Demonstration | null;
  /** Throw it away. What somebody decides not to keep should stop existing. */
  discard: (botId: string) => void;
};

export function createDemonstrationRecorder(
  options: {
    namePoint?: PointNamer;
    now?: () => number;
    maxSteps?: number;
  } = {},
): DemonstrationRecorder {
  const now = options.now ?? Date.now;
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const open = new Map<string, Demonstration>();

  const push = (session: Demonstration, step: DemonstrationStep) => {
    if (session.steps.length >= maxSteps) return;
    session.steps.push(step);
  };

  return {
    start(botId, actor) {
      open.set(botId, {
        botId,
        startedBy: actor,
        startedAt: now(),
        steps: [],
        finished: false,
      });
    },

    recording(botId) {
      const session = open.get(botId);
      return session !== undefined && !session.finished;
    },

    observe(botId, message) {
      const session = open.get(botId);
      if (!session || session.finished) return;
      if (!message || typeof message !== "object") return;
      const input = message as SocketMessage;

      if (input.type === "mouse") {
        // The press only. See SocketMessage.
        if (input.event !== "pressed") return;
        if (typeof input.x !== "number" || typeof input.y !== "number") return;
        const at = now();
        const step: DemonstrationStep = { kind: "pressed", element: null, at };
        push(session, step);
        // Fired and forgotten, and the step is already in the list: the name is filled in when it
        // arrives, so a slow lookup delays nothing and a failed one leaves a press that happened.
        const namer = options.namePoint;
        if (namer) {
          void namer(botId, { x: input.x, y: input.y })
            .then((element) => {
              if (element) step.element = element;
            })
            .catch(() => {});
        }
        return;
      }

      if (input.type === "text") {
        /*
         * A paste. The text is NOT read, not even to measure it — see the note at the top of this
         * file. What is worth recording is that something was entered here, and where.
         */
        push(session, { kind: "typed", into: lastPressed(session), at: now() });
        return;
      }

      if (input.type === "key" && input.event === "down") {
        const key = typeof input.key === "string" ? input.key : "";
        if (!key) return;
        /*
         * A printable character is a character of whatever somebody is typing, and this module does
         * not record that. One-character keys are exactly the printable ones — the surface sends
         * `text` for those and only those — so the length test is the same line the surface draws.
         */
        if (key.length === 1) {
          const last = session.steps.at(-1);
          // One "typed" step per run of typing, rather than one per keystroke: a person filling in
          // a form produces forty keystrokes and one fact.
          if (last?.kind !== "typed") {
            push(session, {
              kind: "typed",
              into: lastPressed(session),
              at: now(),
            });
          }
          return;
        }
        // Named keys are the ones that mean something on their own: Enter submits, Escape closes.
        // Modifiers on their own say nothing and would bury the rest.
        if (
          key === "Shift" ||
          key === "Control" ||
          key === "Alt" ||
          key === "Meta"
        ) {
          return;
        }
        push(session, { kind: "key", key, at: now() });
      }
    },

    finish(botId) {
      const session = open.get(botId);
      if (!session) return null;
      session.finished = true;
      return session;
    },

    read(botId) {
      return open.get(botId) ?? null;
    },

    discard(botId) {
      open.delete(botId);
    },
  };
}

/**
 * The last thing pressed, which is what typing went into.
 *
 * Not exact — somebody can tab into a field without clicking it, and then this names the thing they
 * clicked before that. It is a label on a step a person is about to read and correct, not a fact
 * anything acts on, and a wrong label they can see beats no label at all.
 */
function lastPressed(session: Demonstration): string | null {
  for (let index = session.steps.length - 1; index >= 0; index -= 1) {
    const step = session.steps[index];
    if (step?.kind === "pressed") return step.element?.name ?? null;
  }
  return null;
}

/** Whether a URL is worth recording as a step, or the same page again. */
export function opened(
  session: Demonstration,
  url: string,
): DemonstrationStep | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  for (let index = session.steps.length - 1; index >= 0; index -= 1) {
    const step = session.steps[index];
    if (step?.kind !== "opened") continue;
    // The same address again is a reload, not a step in a procedure.
    return step.url === trimmed
      ? null
      : { kind: "opened", url: trimmed, at: 0 };
  }
  return { kind: "opened", url: trimmed, at: 0 };
}
