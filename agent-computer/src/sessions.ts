/**
 * What this process holds for each Bot besides its browser: who has the wheel, which snapshot its
 * refs belong to, the facts waiting to be told, the fields a person typed into and what is known of
 * what they typed (never the value), the navigation in flight and the person watching.
 *
 * Per Bot, and resolved once per request, so there is no path where one Bot's call reaches
 * another's. Profiles are isolated, but this process is not a security boundary.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ElementHandle, Frame, Page } from "playwright";
import type { NoteCode } from "./codes";
import {
  type Control,
  type ControlState,
  createControl,
  restoredControl,
} from "./control";
import { log } from "./log";
import type { Navigating } from "./navigation";
import type { Screencast } from "./screencast";

/**
 * Something the browser noticed that nothing asked it about.
 *
 * A CODE AND ITS FACTS, NEVER A SENTENCE. An alert that says 로그인이 필요합니다 is the answer to why
 * a click did nothing, and Playwright dismisses it before any tool call returns — so the fact has to
 * travel out of band, on the next result, or the Bot reports "I clicked it" about a page that never
 * moved. The Korean the model reads for each code is in `shared/prompt/tool-results.ko.ts`, for the
 * same reason `laf:human_has_control` lives there: this container ships facts and knows no locale.
 */
export type ComputerNote = { code: NoteCode } & Record<string, unknown>;

/**
 * How many of them one result carries.
 *
 * A page that opens an alert in a loop would otherwise fill a model's context with the same
 * sentence. The newest are kept: the last dialog is the one the Bot is standing in front of.
 */
const MAX_NOTES = 8;

/** A field a person typed into. See `BotSession.secretFields`. */
export type SecretField = {
  handle: ElementHandle;
  /** The ref it was last known by, or empty until a look finds it (`typedIntoRefs`). */
  ref: string;
  /**
   * The frame it is in, where that is known, so a person's next keystroke can ask that frame alone
   * whether it is landing in the same box.
   */
  frame?: Frame;
  /** A keyed digest of what it held when last read, never what it held (`typed-values.ts`). */
  digest?: string;
};

/** Per-Bot browser-control state. Profiles are isolated, but this process is not a security boundary. */
export type BotSession = {
  control: Control;
  /**
   * Which snapshot the caller's refs came from.
   *
   * Kept as a caller-facing guard even though Playwright enforces the real thing underneath. The
   * published tool contract says an action carries the `snapshotId` it got, and a mismatch is
   * answered with "take a new snapshot", which is a clearer message for a model than an element that
   * merely fails to resolve. Playwright's `aria-ref` engine is the runtime enforcement: it resolves a
   * ref only against the most recent snapshot, only while the element is still connected to the
   * document, and it mints a new ref if an element's role or accessible name changed, so a recycled
   * node cannot inherit an old one.
   */
  snapshotId: number;
  /** Facts waiting to ride out on the next tool result. Drained when they do. */
  notes: ComputerNote[];
  /**
   * The fields a person typed into: the node itself, and the ref it was last known by.
   *
   * Identity, not description: whatever the page calls the box and whatever its markup says, the
   * value in THIS node is one the model was promised it would never see — typed through
   * `computer_request_secret`, or by a person holding the wheel (`person-typing.ts`). Followed at
   * every snapshot (`typedIntoRefs`) and let go when the node or its document is gone.
   */
  secretFields: SecretField[];
  /**
   * Keyed digests of what a person typed whose box is gone, or that arrived as one block — so an
   * address carrying it is blanked after the page it was typed on has left (`typed-values.ts`).
   * Never the values.
   */
  typedDigests: string[];
  /**
   * Keyed digests of what the Bot itself put into a box or an address. Never blanked: the Bot knows
   * them already, and blanking one it chose would tell it the guess was what a person typed.
   */
  ownDigests: string[];
  /** The box a person's last keystroke landed in, for the next keystroke to be compared with. */
  lastTyped?: SecretField;
  /**
   * The tabs a person typed into while the page would not say where the typing went, and which of
   * each tab's documents it was (`documentOf`). That document shows no box's contents until it is
   * gone (`person-typing.ts`).
   */
  typedBlind: WeakMap<Page, number | undefined>;
  /**
   * A person's input, applied one piece at a time in the order it arrived. Finding the box a
   * keystroke lands in is a question to the page, and two keystrokes whose questions answered out of
   * order would reach the page out of order.
   */
  personInput: Promise<void>;
  /**
   * The `/navigate` in flight, while it is: which tab's frame it drives, which host it was judged
   * for, and what the guard stopped on its way.
   *
   * Playwright reports a stopped navigation as `net::ERR_BLOCKED_BY_CLIENT`, which names neither the
   * address nor the reason; this does. Scoped to one call and to that tab's main frame, so a refused
   * iframe, or a click three turns ago, is never blamed on the page being opened now.
   */
  navigating?: Navigating;
  /** The one live screen viewer for this Bot, if a person is watching. */
  viewer?: {
    socket: unknown;
    cast: Screencast;
    /** The tab being cast, which is the tab the person's input goes to. */
    page: Page;
    /** Stops the loop that keeps the cast pointed at whatever page the Bot is actually on. */
    follow?: ReturnType<typeof setInterval>;
  };
};

/** Put a fact in front of the Bot on its next call. */
export function note(session: BotSession, entry: ComputerNote): void {
  session.notes.push(entry);
  if (session.notes.length > MAX_NOTES) {
    session.notes.splice(0, session.notes.length - MAX_NOTES);
  }
}

/** Everything waiting, handed over once. A fact delivered twice reads as it having happened twice. */
function drainNotes(session: BotSession): ComputerNote[] {
  return session.notes.splice(0, session.notes.length);
}

/** One response, with whatever the browser noticed since the last one attached to it. */
export function withNotes(
  session: BotSession,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const notes = drainNotes(session);
  return notes.length ? { ...body, notes } : body;
}

/**
 * Every Bot's session, keyed by its id.
 *
 * `stateDirectoryFor` is where who had the wheel is written between lives of this process. Functions
 * rather than paths so the layout stays profiles.ts's to decide — and it is no longer the profile
 * directory: the profile is the deployment's and control is one Bot's, so five Bots writing
 * `control.json` into one directory would each answer "is a person driving" for all of them.
 *
 * `legacyStateDirectoryFor` is where it used to be, read when the new place has nothing. A container
 * upgraded while somebody held the wheel must not hand it back to the Bot on the way through:
 * `createControl`'s default holder is the Bot, so a control file this process cannot find is a
 * control file that silently makes control looser.
 */
export function createSessions(directories: {
  stateDirectoryFor: (botId: string) => string;
  legacyStateDirectoryFor?: (botId: string) => string;
}) {
  const sessions = new Map<string, BotSession>();

  /** Where a Bot's control state is kept between lives of this process. */
  const controlFileFor = (botId: string): string =>
    join(directories.stateDirectoryFor(botId), "control.json");

  const readAt = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // No file is the ordinary case: a Bot that has never been driven. An unreadable one is treated
      // the same way, because the fail-safe below only ever makes control stickier, never looser.
      return null;
    }
  };

  const readControlFile = (botId: string): unknown => {
    const current = readAt(controlFileFor(botId));
    if (current !== null) return current;
    const legacy = directories.legacyStateDirectoryFor?.(botId);
    return legacy === undefined ? null : readAt(join(legacy, "control.json"));
  };

  /**
   * Written on every change, synchronously.
   *
   * Synchronous because the case this exists for is the process ending: an async write scheduled a
   * millisecond before SIGKILL is a write that never happened, and the state it was carrying is
   * exactly the one somebody is relying on.
   */
  const writeControlFile = (botId: string, state: ControlState): void => {
    try {
      const path = controlFileFor(botId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state), "utf8");
    } catch (error) {
      log.error("control_state_not_saved", { bot: botId, reason: error });
    }
  };

  return {
    sessionFor(botId: string): BotSession {
      const existing = sessions.get(botId);
      if (existing) return existing;
      /*
       * WHO HAD THE WHEEL BEFORE THIS PROCESS STARTED.
       *
       * A restart in the middle of a takeover used to hand the browser back to the Bot in silence:
       * the person was still looking at a bank's login form, and the Bot was free to click on it.
       * Control is written to the profile directory on every change, and read back here, so a
       * restart cannot quietly promote a Bot. See `restoredControl` for what survives and what does
       * not.
       */
      const restored = restoredControl(readControlFile(botId));
      const created: BotSession = {
        control: createControl(undefined, {
          ...(restored.state ? { initial: restored.state } : {}),
          onChange: (state) => writeControlFile(botId, state),
        }),
        snapshotId: 0,
        notes: restored.secretLost ? [{ code: "laf:secret_request_lost" }] : [],
        secretFields: [],
        typedDigests: [],
        ownDigests: [],
        typedBlind: new WeakMap(),
        personInput: Promise.resolve(),
      };
      sessions.set(botId, created);
      return created;
    },

    /** The session if this process already has one. Never creates one, so never reads the disk. */
    existing(botId: string): BotSession | undefined {
      return sessions.get(botId);
    },

    /**
     * The Bot whose `/navigate` is driving this frame, if one is.
     *
     * The browser belongs to every Bot now, so a hop the navigation guard stopped arrives with a
     * frame id and no name on it. A Bot with a navigation in flight on that exact frame is the one
     * exact answer available: it asked for this page and it is waiting for the verdict. Everything
     * else `index.ts` has to work out for itself, and says so.
     */
    botNavigating(frameId: string): string | undefined {
      for (const [botId, session] of sessions) {
        if (session.navigating?.frameId === frameId) return botId;
      }
      return undefined;
    },

    /** Forget a Bot's session without writing anything. See `/computers/reset`. */
    drop(botId: string): void {
      sessions.delete(botId);
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;
