import { decodeScreenFrame } from "@shared/screen-frame";
import { useEffect, useRef, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { Button } from "@/components/ui/button";
import {
  SCREEN_STALLED,
  SCREEN_UNAVAILABLE,
  SCREEN_UNREACHABLE,
} from "@/lib/computer/screen-problems";
import { t } from "@/lib/i18n";
import { decodeFrame, decodeFrameBytes, paintFrame } from "./frame-bitmap";

/** The reconnect schedule: the roster socket's, so the two come back at the same pace. */
export const LIVE_SCREEN_RETRY = { firstMs: 500, maxMs: 30_000 } as const;

/**
 * How long the screen waits for a picture before it says it has none and offers 다시 연결.
 *
 * WAITING WAS SILENT, AND THE SCHEDULE ABOVE MADE IT LONG. A socket that opened and then sent
 * nothing kept "화면에 연결하는 중…" up for as long as anybody looked — measured 2026-09-24 at over
 * twenty seconds in two opens of three, and the audit's own "닫았다 다시 열어도 같았다" — and a
 * picture cut off by a server restart came back 11 s after the server did, because the wait had
 * doubled its way up while the server was down. Chrome sends a cast's first frame as soon as the
 * cast starts (measured: 0.1 s after the socket opened, every time it worked), so five seconds of
 * nothing is not a slow page, it is a picture that is not coming.
 */
export const SCREEN_STALL_MS = 5_000;

/**
 * The Bot's browser, live, to watch.
 *
 * WATCHED, NEVER DRIVEN (owner, 2026-10-09). Until then a person could take the wheel and this
 * forwarded their pointer and keys down the same socket — Chrome DevTools' `InputModel.ts` for the
 * translation, a hidden field for the input method. Nobody drives the Bot's browser now, on any
 * surface: the socket carries pictures out and nothing in, and the server and the computer refuse
 * anything sent the other way (`server/src/live-screen.ts`, `agent-computer/src/live-screen.ts`).
 * A value a page needs reaches it through the masked box a request opens, not through here.
 *
 * Follows `steel-dev/steel-browser`'s casting handler (Apache-2.0) for the frame loop, because no
 * maintained library publishes one.
 */

type Props = {
  /** Computer identity is part of the stream URL, so the frames are the active Bot's. */
  computerId: string;
  /**
   * Called with a fact code (`laf:…`) when the stream cannot be established, null once it is.
   *
   * A code and never a sentence: the container's `error` text used to be handed up here as it
   * came, and it came in English. `screenProblemText` turns the code into the person's words.
   */
  onProblem?: (problem: string | null) => void;
  /**
   * Called with each frame's site: a host, null for a browser with no page, or undefined from a
   * computer too old to say. The live view closes on null rather than draw a white box.
   */
  onSite?: (site: string | null | undefined) => void;
};

export function LiveScreen({ computerId, onProblem, onSite }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [connected, setConnected] = useState(false);
  /**
   * The stream had been showing a picture and then dropped. Drawn under the picture until a picture
   * is back — a frame, not the socket opening again: a socket can open and send nothing (see
   * `SCREEN_STALL_MS`).
   */
  const [lost, setLost] = useState(false);
  /** Lost for `SCREEN_STALL_MS`: the line under the picture offers 다시 연결 instead of only waiting. */
  const [isLostLong, setIsLostLong] = useState(false);
  /**
   * Drop whatever socket there is and open one now, from the first step of the schedule.
   *
   * Set and cleared by the socket's effect, which is where the socket lives; read only by a press.
   */
  const reconnectRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Same origin, so the scheme follows the page: wss when the app is served over https.
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${window.location.host}/api/computers/${encodeURIComponent(computerId)}/stream`;
    let socket: WebSocket | undefined;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay: number = LIVE_SCREEN_RETRY.firstMs;
    /** Whether a socket has ever opened: a close after that is a loss, before it a failure to start. */
    let hadOpened = false;
    /** Whether any frame has arrived: before one, a wait is the pane's problem to say; after, the line's. */
    let hadFrame = false;
    let isShowingLoss = false;
    /** Runs out when a socket has gone `SCREEN_STALL_MS` without a first picture. */
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    /** Runs out when a lost picture has stayed lost for `SCREEN_STALL_MS`. */
    let lostTimer: ReturnType<typeof setTimeout> | undefined;

    const watchForPicture = () => {
      clearTimeout(stallTimer);
      if (hadFrame) return;
      stallTimer = setTimeout(() => {
        if (!closed && !hadFrame) onProblem?.(SCREEN_STALLED);
      }, SCREEN_STALL_MS);
    };

    const sawFrame = () => {
      hadFrame = true;
      clearTimeout(stallTimer);
      if (!isShowingLoss) return;
      isShowingLoss = false;
      clearTimeout(lostTimer);
      setLost(false);
      setIsLostLong(false);
    };

    /*
     * A SOCKET LET GO OF SAYS NOTHING MORE. Only `onclose` used to be cleared, so a socket closed
     * while it was still opening — React mounts every effect twice in development, and the pane
     * does the same by hand when it is closed and reopened — went on to fire `onerror`, and the
     * pane drew "실시간 화면에 닿지 못했습니다" over the socket that had replaced it (measured
     * 2026-09-24, on every open after a server restart).
     */
    const release = (old: WebSocket) => {
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      old.close();
    };

    /*
     * RECONNECTS, LIKE THE ROSTER'S SOCKET NEXT DOOR. Audit A4 (2026-09-10), finding 6: this used
     * to be one socket and `onclose = () => setConnected(false)`, so the front door's three-second
     * restart on every upgrade left a frozen picture until the pane was closed and reopened. Same schedule as `use-channel-events.ts`: half a second,
     * doubling, capped.
     */
    const connect = () => {
      if (closed) return;
      socket = new WebSocket(url);
      // Frames come as bytes (`shared/screen-frame.ts`); errors and the probe still come as text.
      socket.binaryType = "arraybuffer";
      watchForPicture();

      socket.onopen = () => {
        retryDelay = LIVE_SCREEN_RETRY.firstMs;
        setConnected(true);
        onProblem?.(null);
        // From the open, not the attempt: a slow handshake is not the picture's wait.
        watchForPicture();
        hadOpened = true;
      };

      socket.onmessage = async (event) => {
        let message: {
          type: string;
          data?: string;
          /** The container's fact code. Its `error` sentence is for a log, never for this pane. */
          code?: string;
          /** The page's host only; null when there is no page (`agent-computer/src/screencast.ts`). */
          site?: string | null;
          /** The picture itself, for a frame that came as bytes. */
          jpeg?: Uint8Array;
        };
        if (event.data instanceof ArrayBuffer) {
          const frame = decodeScreenFrame(event.data);
          if (!frame) return;
          message = { ...frame.header, jpeg: frame.jpeg };
        } else {
          try {
            message = JSON.parse(String(event.data));
          } catch {
            return;
          }
        }
        if (message.type === "error") {
          onProblem?.(message.code ?? SCREEN_UNAVAILABLE);
          return;
        }
        if (message.type !== "frame" || !(message.jpeg || message.data)) return;
        // Counted before it is decoded: a frame is proof the stream works, whatever it shows.
        sawFrame();

        const canvas = canvasRef.current;
        if (!canvas || closed) return;

        /*
         * A BLANK PAGE IS SAID, NOT PAINTED. It is how a closed tab comes back — the computer opens a
         * fresh one — and painting it first would flash the white box the viewer is about to close
         * instead of showing.
         */
        if (message.site === null) {
          onSite?.(null);
          return;
        }

        // The decode lives in `frame-bitmap.ts`, which is also where the timings are.
        const bitmap = message.jpeg
          ? await decodeFrameBytes(message.jpeg, "image/jpeg")
          : await decodeFrame(message.data ?? "", "image/jpeg");
        // Ignore a single corrupt frame; the next frame replaces it.
        if (!bitmap) return;
        if (closed) {
          bitmap.close();
          return;
        }
        paintFrame(canvas, bitmap);
        bitmap.close();
        onSite?.(message.site);
      };

      // Only a stream that never started is a problem for the pane's own line; a stream that
      // dropped says so under the picture, and is about to be reopened.
      socket.onerror = () => {
        if (hadOpened) return;
        // Said as what it is. The wait for a picture is not the problem here, so it stops.
        clearTimeout(stallTimer);
        onProblem?.(SCREEN_UNREACHABLE);
      };
      socket.onclose = () => {
        if (closed) return;
        setConnected(false);
        // Cut off only once there was a picture to cut; before one, the wait above speaks.
        if (hadFrame && !isShowingLoss) {
          isShowingLoss = true;
          setLost(true);
          lostTimer = setTimeout(() => setIsLostLong(true), SCREEN_STALL_MS);
        }
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, LIVE_SCREEN_RETRY.maxMs);
      };
    };

    reconnectRef.current = () => {
      if (closed) return;
      clearTimeout(retryTimer);
      if (socket) release(socket);
      retryDelay = LIVE_SCREEN_RETRY.firstMs;
      connect();
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(stallTimer);
      clearTimeout(lostTimer);
      reconnectRef.current = null;
      // Its handlers cleared first: a pane that is gone must not be told anything, or reconnected.
      if (socket) release(socket);
    };
    // The socket is per Bot; switching Bot must close this stream and open the next one.
  }, [computerId, onProblem, onSite]);

  return (
    <>
      <canvas
        ref={canvasRef}
        // max-h/max-w rather than h-auto w-full: the expanded screen used to overflow a short window
        // and scroll, with the bottom of the Bot's page below the fold.
        className="block max-h-full max-w-full outline-none"
        aria-label={t("The assistant's screen, live")}
        data-connected={connected}
      />
      <div className="-translate-x-1/2 pointer-events-none absolute bottom-2 left-1/2 flex items-center gap-2">
        {/* Mounted with the screen, so the cut is heard when it happens and not only seen. */}
        <LiveRegion
          as="p"
          className="whitespace-nowrap rounded-full bg-background/90 px-3 py-1 text-foreground text-xs shadow"
        >
          {lost ? t("The live picture was cut off. Reconnecting…") : null}
        </LiveRegion>
        {lost && isLostLong ? (
          <Button
            className="pointer-events-auto shadow"
            onClick={() => reconnectRef.current?.()}
            size="xs"
            type="button"
            variant="outline"
          >
            {t("Reconnect")}
          </Button>
        ) : null}
      </div>
    </>
  );
}
