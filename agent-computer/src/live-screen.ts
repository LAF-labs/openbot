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
import { type InputMessage, startScreencast } from "./screencast";
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

export function liveScreen({
  profiles,
  sessions,
}: Computer): WebSocketHandler<StreamData> {
  return {
    async open(ws) {
      const session = sessions.sessionFor(ws.data.botId);
      try {
        await stopViewer(session);

        const send = (frame: unknown) => {
          // A closed socket starts a fresh cast on the next connection.
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            void stopViewer(session);
          }
        };

        /*
         * The cast follows the Bot's current page. Re-checking also handles a page being closed
         * underneath us without a listener per page.
         */
        let casting: Page | undefined;
        const attach = async () => {
          const target = await profiles.page(ws.data.botId);
          if (target === casting) return;
          const previous = session.viewer;
          const cast = await startScreencast(target, send);
          casting = target;
          session.viewer = {
            socket: ws,
            cast,
            page: target,
            follow: previous?.follow,
          };
          // The old cast stops after the replacement is running, so the screen does not go blank.
          await previous?.cast.stop().catch(() => undefined);
        };

        await attach();
        const follow = setInterval(() => {
          void attach().catch(() => undefined);
        }, FOLLOW_INTERVAL_MS);
        if (session.viewer) session.viewer.follow = follow;
      } catch (error) {
        log.error("screen_not_started", { bot: ws.data.botId, reason: error });
        ws.send(screenError("laf:screen_not_started"));
        ws.close();
      }
    },

    async message(ws, raw) {
      const session = sessions.sessionFor(ws.data.botId);
      if (!session.viewer) return;
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

    async close(ws) {
      await stopViewer(sessions.sessionFor(ws.data.botId));
    },
  };
}
