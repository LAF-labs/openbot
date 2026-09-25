/**
 * The live screen, pushed by Chrome rather than polled, and a person's input back over the same
 * socket.
 *
 * Upgraded rather than served as HTTP because the whole point is that frames arrive when the page
 * changes and input goes back over the same connection. See screencast.ts for why polling was not
 * good enough once a person had to type into this.
 *
 * `/live` stays absent. A page served by this process can only be opened by putting the secret in a
 * URL, where it lands in history and logs. The React app is the guarded way to watch a Bot.
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { Page } from "playwright";
import type { ScreenCode } from "./codes";
import type { Computer } from "./computer";
import { TAKE_CONTROL_FIRST } from "./control";
import { log } from "./log";
import { followTyping, inTurn, settleTyping } from "./person-typing";
import { encodeScreenFrame } from "../../shared/screen-frame";
import {
  type CastFrame,
  type InputMessage,
  startScreencast,
} from "./screencast";
import type { BotSession } from "./sessions";

/** What a live-screen socket carries: the Bot whose screen it is showing. */
export type StreamData = { botId: string };

/**
 * A problem on the socket, as the fact.
 *
 * `code` was put beside the sentence on 2026-09-06, after the pane on the far side — Korean — was
 * measured showing this process's English as it was. The surface owns the words, and chooses them by
 * `code` (`app/src/lib/computer/screen-problems.ts`); `error` carries the same code, so a reader that
 * still shows `error` shows a code rather than a sentence or Playwright's message.
 */
function screenError(code: ScreenCode): string {
  return JSON.stringify({ type: "error", code, error: code });
}

/** How often the cast checks that it is still showing the page the Bot is on. */
const FOLLOW_INTERVAL_MS = 1_000;

/**
 * One live viewer at a time per Bot, so a reconnect replaces rather than stacks, and two people
 * watching two different Bots do not fight over one cast.
 *
 * A second cast on the same page would have Chrome encoding every frame twice and both sockets acking
 * independently, which stalls both. One person drives; one cast.
 */
export async function stopViewer(session: BotSession): Promise<void> {
  const current = session.viewer;
  session.viewer = undefined;
  if (current?.follow) clearInterval(current.follow);
  await current?.cast.stop();
}

/**
 * One piece of a person's input, applied to the tab being cast — after the pieces before it.
 *
 * IN TURN, BECAUSE OF THE QUESTION BEFORE A KEYSTROKE. The box a keystroke lands in is asked of the
 * page before the keystroke is sent (`person-typing.ts`), and two pieces whose questions came back
 * out of order would reach the page out of order — 한 and 글, sent a syllable at a time, landing as
 * 글한. Until 2026-09-16 each message went straight to Chrome as it arrived, which kept the order and
 * followed no box.
 */
async function applyInput(
  ws: ServerWebSocket<StreamData>,
  session: BotSession,
  message: InputMessage,
): Promise<void> {
  const viewer = session.viewer;
  if (!viewer) return;
  // Asked again, in turn: the wheel can be handed back while this waits behind the input before it.
  if (!session.control.humanMayDrive()) {
    ws.send(screenError(TAKE_CONTROL_FIRST));
    return;
  }
  try {
    if (message.type === "text") {
      await followTyping(session, viewer.page, message.text);
    } else if (message.type === "key" && message.event === "down") {
      await followTyping(session, viewer.page);
    } else if (message.type === "mouse" && message.event === "pressed") {
      // A press can send the form the last box is in: what that box holds is read before it goes.
      await settleTyping(session);
    }
    await viewer.cast.send(message);
  } catch (error) {
    // Reported rather than swallowed. A dispatch that fails means the person's input did nothing,
    // and they must not be left believing it landed.
    // The input's TYPE (a click, a key) and never its content: a keystroke on the live screen
    // is what somebody typed into a browser holding their logins.
    log.error("screencast_input_failed", {
      input: message.type,
      reason: error,
    });
    ws.send(screenError("laf:input_not_applied"));
  }
}

/**
 * EVERY SOCKET WATCHING A BOT'S SCREEN, OLDEST FIRST — AND THE CAST GOES TO THE LAST ONE STILL OPEN.
 *
 * Opening is slow (a page to find, a cast to start) and two opens can overlap: React mounts the live
 * view twice in development, and a person who closes the view and opens it again does the same by
 * hand. Whichever finished starting last used to become the viewer, and any socket's close stopped
 * whichever viewer was current — so the socket on its way out took the cast with it, and the one that
 * stayed showed a frozen picture and dropped every click and key without a word (measured
 * 2026-09-24, taking the wheel from the live view: the page never saw a keystroke).
 *
 * Now the newest open socket is the viewer however the starts interleave, a socket only ever stops
 * its own cast, and when the viewer closes, the socket opened before it takes the picture back.
 */
/**
 * The shortest time between two frames sent: at most ten a second. A person watching a Bot read a
 * page, or clicking through a sign-in, is not helped by thirty; the bytes are what the VM's one core
 * and the person's connection pay for (the audit's target is ~1 MB/s while a page animates).
 */
const FRAME_INTERVAL_MS = 100;

/**
 * The newest frame not yet sent, and the acknowledgements of every frame it stands for.
 *
 * WHY NOT JUST DELAY THE ACK. Chrome keeps two frames in flight, not one: acknowledging late alone
 * still let 16 frames a second through (measured on Naver's home page while it scrolled). So a frame
 * that comes too soon is held; a newer one replaces it — the picture a person needs is the latest —
 * and Chrome hears nothing for either until the held one goes, which is what slows its encoder down.
 * Held rather than dropped, so the last change on a page that then goes still is always shown.
 */
type Held = {
  bytes: Uint8Array;
  acks: (() => void)[];
  timer?: ReturnType<typeof setTimeout>;
};
const held = new WeakMap<ServerWebSocket<StreamData>, Held>();
const lastSent = new WeakMap<ServerWebSocket<StreamData>, number>();
/** Acknowledgements waiting for the socket to take what it queued. */
const draining = new WeakMap<ServerWebSocket<StreamData>, (() => void)[]>();

/** Keep the newest frame and send it as soon as the interval, and the socket, allow. */
function offer(
  ws: ServerWebSocket<StreamData>,
  bytes: Uint8Array,
  ack: () => void,
  failed: () => void,
): void {
  const frame = held.get(ws) ?? { bytes, acks: [] };
  frame.bytes = bytes;
  frame.acks.push(ack);
  held.set(ws, frame);
  if (frame.timer || draining.has(ws)) return;
  const wait = FRAME_INTERVAL_MS - (Date.now() - (lastSent.get(ws) ?? 0));
  frame.timer = setTimeout(() => flush(ws, failed), Math.max(0, wait));
}

function flush(ws: ServerWebSocket<StreamData>, failed: () => void): void {
  const frame = held.get(ws);
  if (!frame) return;
  held.delete(ws);
  let status: number;
  try {
    status = ws.send(frame.bytes);
  } catch {
    for (const ack of frame.acks) ack();
    failed();
    return;
  }
  lastSent.set(ws, Date.now());
  // -1: queued behind what the socket has not sent yet. Chrome waits for the drain.
  if (status === -1) {
    draining.set(ws, frame.acks);
    return;
  }
  for (const ack of frame.acks) ack();
}

const watching = new WeakMap<BotSession, ServerWebSocket<StreamData>[]>();
/** How each socket takes the cast back when the one opened after it closes. */
const resumes = new WeakMap<ServerWebSocket<StreamData>, () => void>();
/** Each socket's follow timer, kept apart from the viewer so a displaced socket's can be stopped. */
const follows = new WeakMap<
  ServerWebSocket<StreamData>,
  ReturnType<typeof setInterval>
>();

export function liveScreen({
  profiles,
  sessions,
}: Computer): WebSocketHandler<StreamData> {
  return {
    async open(ws) {
      const session = sessions.sessionFor(ws.data.botId);
      // Before anything is awaited, so the order is the order the sockets arrived in.
      watching.set(session, [...(watching.get(session) ?? []), ws]);
      const isNewest = () => watching.get(session)?.at(-1) === ws;
      // How many are watching, never who: enough to see an overlap in the log.
      log.info("screen_opened", {
        bot: ws.data.botId,
        watching: watching.get(session)?.length ?? 0,
      });
      try {
        await stopViewer(session);

        /*
         * BYTES, AT MOST TEN A SECOND, AND NONE INTO A SOCKET THAT IS BEHIND. Each frame is one
         * binary message (`shared/screen-frame.ts`), sent no sooner than {@link FRAME_INTERVAL_MS}
         * after the last (`offer`), and Chrome is told to go on only once it has gone — at the drain,
         * if the socket queued it. Before, frames went as base64 JSON and were acknowledged before
         * they were sent: 25–30 fps, ~123 KB each, 3.1–3.7 MB/s on a Naver page whatever the viewer
         * could take (performance audit, 2026-09-25).
         */
        const send = (frame: CastFrame, ack: () => void) =>
          offer(ws, encodeScreenFrame(frame.header, frame.jpeg), ack, () => {
            // A closed socket starts a fresh cast on the next connection.
            if (session.viewer?.socket === ws) void stopViewer(session);
          });

        /*
         * The cast follows the Bot's current page. Re-checking also handles a page being closed
         * underneath us without a listener per page.
         */
        let casting: Page | undefined;
        const attach = async () => {
          const target = await profiles.page(ws.data.botId);
          if (
            !isNewest() ||
            (target === casting && session.viewer?.socket === ws)
          ) {
            return;
          }
          const previous = session.viewer;
          const cast = await startScreencast(target, send);
          // A newer socket opened while this cast was starting: that one is the viewer.
          if (!isNewest()) {
            await cast.stop().catch(() => undefined);
            return;
          }
          casting = target;
          session.viewer = {
            socket: ws,
            cast,
            page: target,
            follow: follows.get(ws),
          };
          // The old cast stops after the replacement is running, so the screen does not go blank.
          await previous?.cast.stop().catch(() => undefined);
        };
        const follow = () => {
          clearInterval(follows.get(ws));
          // Closed while it was still starting: nothing to follow for, and nothing would stop it.
          if (!watching.get(session)?.includes(ws)) return;
          const timer = setInterval(() => {
            void attach().catch(() => undefined);
          }, FOLLOW_INTERVAL_MS);
          follows.set(ws, timer);
          if (session.viewer?.socket === ws) session.viewer.follow = timer;
        };
        resumes.set(ws, () => {
          void attach().then(follow, () => undefined);
        });

        await attach();
        follow();
      } catch (error) {
        log.error("screen_not_started", { bot: ws.data.botId, reason: error });
        ws.send(screenError("laf:screen_not_started"));
        ws.close();
      }
    },

    async message(ws, raw) {
      const session = sessions.sessionFor(ws.data.botId);
      // Only the socket being cast to drives. One that another viewer displaced is looking at a
      // picture that stopped; its clicks would land on a page it no longer sees.
      if (session.viewer?.socket !== ws) return;
      let message: InputMessage;
      try {
        message = JSON.parse(String(raw)) as InputMessage;
      } catch {
        return;
      }
      // A person's input is accepted only while they hold the wheel. The socket being open is not permission:
      // without this check, anything that could reach this port could drive the browser while a Bot
      // was working, which is the one thing the control state exists to prevent.
      //
      // Refuse with an error so the surface can explain why input is ignored.
      if (!session.control.humanMayDrive()) {
        ws.send(screenError(TAKE_CONTROL_FIRST));
        return;
      }
      await inTurn(session, () => applyInput(ws, session, message));
    },

    drain(ws) {
      const acks = draining.get(ws);
      if (!acks) return;
      draining.delete(ws);
      for (const ack of acks) ack();
      // What came while the socket was behind goes now, at the pace it would have.
      const frame = held.get(ws);
      if (frame && !frame.timer) {
        const wait = FRAME_INTERVAL_MS - (Date.now() - (lastSent.get(ws) ?? 0));
        frame.timer = setTimeout(
          () => flush(ws, () => undefined),
          Math.max(0, wait),
        );
      }
    },

    async close(ws) {
      const session = sessions.sessionFor(ws.data.botId);
      // Frames waiting on a socket that will never take them: let Chrome go on for whoever is next.
      for (const ack of draining.get(ws) ?? []) ack();
      draining.delete(ws);
      const frame = held.get(ws);
      clearTimeout(frame?.timer);
      for (const ack of frame?.acks ?? []) ack();
      held.delete(ws);
      clearInterval(follows.get(ws));
      follows.delete(ws);
      resumes.delete(ws);
      const rest = (watching.get(session) ?? []).filter((open) => open !== ws);
      watching.set(session, rest);
      const wasViewer = session.viewer?.socket === ws;
      log.info("screen_closed", {
        bot: ws.data.botId,
        wasViewer,
        watching: rest.length,
      });
      // Its own cast, never whoever's is current.
      if (!wasViewer) return;
      await stopViewer(session);
      // Somebody is still watching: the socket opened before this one gets the picture back.
      const next = rest.at(-1);
      if (next) resumes.get(next)?.();
    },
  };
}
