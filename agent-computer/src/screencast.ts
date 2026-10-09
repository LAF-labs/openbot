/**
 * The live screen over one WebSocket, using Chrome's own screencast.
 *
 * Chrome pushes frames as the page changes, which is a better picture to watch than a PNG polled
 * once a second.
 *
 * Follows `steel-dev/steel-browser`'s `casting.handler.ts` (Apache-2.0) for the server loop.
 *
 * WATCHING ONLY. This also carried a person's mouse and keyboard to the page while they held the
 * wheel, translated for Chrome after DevTools' `InputModel.ts`; nobody drives the Bot's browser now
 * (owner, 2026-10-09), and that half went with the wheel. It is in git history.
 *
 * noVNC is not used because it requires Xvfb, x11vnc and websockify, while this container runs
 * headless.
 */
import type { CDPSession, Page } from "playwright";
import type { FrameHeader } from "../../shared/screen-frame";

/**
 * What a frame is before it goes on the wire (`shared/screen-frame.ts`): the header and Chrome's own
 * JPEG bytes, which are never re-encoded.
 */
export type CastFrame = {
  header: FrameHeader;
  jpeg: Uint8Array;
};

/**
 * The site a frame is a picture of: an address's host; null for no page; the scheme alone for a
 * browser's own page.
 *
 * THE HOST AND NOTHING ELSE OF THE ADDRESS. The surface needs two facts: the site to name above
 * the picture, and whether there is a page at all — a closed tab comes back as a fresh blank one
 * (`profiles.page`), and the live view closes rather than draw a white box. A path or a query can
 * carry what a person typed into a form sent by GET, and this socket does not pass the filter
 * every HTTP answer passes (`typed-values.ts`), so none of it is sent.
 */
export function siteOf(address: string): string | null {
  const trimmed = address.trim();
  if (trimmed === "" || trimmed === "about:blank") return null;
  try {
    const url = new URL(trimmed);
    return url.host || url.protocol.replace(/:$/, "") || null;
  } catch {
    return null;
  }
}

export type Screencast = {
  /** Stop the cast and detach. Safe to call twice. */
  stop: () => Promise<void>;
};

/**
 * Start casting `page` to `onFrame`, and return the handle that stops it.
 *
 * `maxWidth`/`maxHeight` cap what Chrome encodes; it scales to fit and tells us the real dimensions in
 * the metadata, which the surface draws the picture at. Capping matters because the cost of a frame
 * is mostly encoding, and oversized casts waste bandwidth.
 */
export async function startScreencast(
  page: Page,
  /**
   * Handed each frame and the acknowledgement that asks Chrome for the next one. The caller acks when
   * the frame has left — see `live-screen.ts` — which is the whole of the backpressure: Chrome sends
   * nothing more until it is told the last one went.
   */
  onFrame: (frame: CastFrame, ack: () => void) => void,
  options: { maxWidth?: number; maxHeight?: number; quality?: number } = {},
): Promise<Screencast> {
  const client: CDPSession = await page.context().newCDPSession(page);
  let stopped = false;

  type ScreencastFrame = {
    data: string;
    sessionId: number;
    metadata: { deviceWidth: number; deviceHeight: number };
  };

  client.on("Page.screencastFrame", (event: ScreencastFrame) => {
    const { data, sessionId, metadata } = event;
    /*
     * Every frame is acknowledged exactly once: Chrome will not send the next one until the current is
     * acked, and forgetting is why a naive implementation delivers one frame and then appears to hang.
     * It used to be acked here, before the frame was sent — so a slow viewer got no backpressure at
     * all and Chrome ran at 25–30 fps whatever the socket could carry (performance audit, 2026-09-25).
     */
    let acked = false;
    const ack = () => {
      if (acked) return;
      acked = true;
      void client
        .send("Page.screencastFrameAck", { sessionId })
        .catch(() => undefined);
    };
    if (stopped) {
      ack();
      return;
    }
    onFrame(
      {
        header: {
          type: "frame",
          width: metadata.deviceWidth,
          height: metadata.deviceHeight,
          site: siteOf(page.url()),
        },
        jpeg: Buffer.from(data, "base64"),
      },
      ack,
    );
  });

  await client.send("Page.startScreencast", {
    format: "jpeg",
    /*
     * 60, not 70, for a picture a person reads text off at the pane's size. Measured 2026-09-25 on
     * Naver's home page while it scrolled: 131–137 KB a frame at 70 as base64 JSON, 86–95 KB at 60
     * as bytes — most of that is the base64 going, the rest is this.
     */
    quality: options.quality ?? 60,
    maxWidth: options.maxWidth ?? 1280,
    maxHeight: options.maxHeight ?? 800,
    // One frame per change, not per interval. Chrome decides when something moved.
    everyNthFrame: 1,
  });

  return {
    /*
     * ASKED, NOT WAITED FOR. On a tab whose next document is on its way, neither `Page.stopScreencast`
     * nor the detach answered in 5 s (measured 2026-09-14; page-arrival.ts), and a reset waits for
     * this stop: in the image built from dbc1c67, `/computers/reset` with the live screen open, one
     * second into a `/navigate` to the fixture's `/hang`, answered at 29.3 s — when the navigation gave
     * the page up. Frames that arrive after this are dropped by `stopped` either way.
     */
    async stop() {
      if (stopped) return;
      stopped = true;
      void client.send("Page.stopScreencast").catch(() => undefined);
      void client.detach().catch(() => undefined);
    },
  };
}
