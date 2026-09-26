/**
 * A download stopped the moment it is bigger than the workspace takes, or older than it should be —
 * not once it has finished.
 *
 * THE LIMIT USED TO BE CHECKED AFTER THE FILE HAD ARRIVED. `saveDownload` measured what `saveAs`
 * handed it, and `saveAs` waits for the whole download, which Chromium streams into its own directory
 * under /tmp: the container's layer, the host's disk, the disk Postgres is on. Measured 2026-09-26
 * against the real computer with an attachment that never ends: 27.8, 53.5, 79.2 and 104.9 MB on disk
 * at 2, 4, 6 and 8 s, the click long since answered 200, the workspace empty, no note — and it went on
 * for as long as anything kept the browser open. Any page the Bot opens can start one; a site's
 * ordinary 2 GB file is the same thing without the malice.
 *
 * So the tab's own DevTools session (`followArrivals`) reports each download's progress — the
 * `Content-Length` it announced and the bytes that have arrived — and a download past the limit, or
 * past its time, is cancelled then, which also deletes Chromium's partial file. The progress events
 * come a few hundred ms apart (measured: four in 1.5 s at 12 MB/s), so what reaches the disk is the
 * limit plus one interval, never the whole file.
 *
 * Here rather than in `page-watch.ts` so it can be tested with a clock instead of a browser.
 */

/** One download as the tab reports it (`Page.downloadWillBegin`, then `Page.downloadProgress`). */
export type DownloadProgress = {
  guid: string;
  url?: string;
  suggestedFilename?: string;
  /** What the response said it would be. Zero when it did not say. */
  totalBytes?: number;
  receivedBytes?: number;
  state?: "inProgress" | "completed" | "canceled";
};

/** Why a download was stopped. */
export type DownloadVerdict = "too_large" | "too_slow";

/** What Playwright's `Download` is asked, so a test can hand in two strings. */
export type NamedDownload = { url(): string; suggestedFilename(): string };

/**
 * How long a download may take. A 세금계산서 PDF or a month's 정산내역 is ready in seconds; two
 * minutes is room for a slow portal generating one, and a bound on a stream that trickles in under
 * the byte limit for ever.
 */
export const DOWNLOAD_MAX_MS = 120_000;

type Known = {
  url?: string;
  name?: string;
  total: number;
  received: number;
  claimed: boolean;
};

type Watch = {
  download: NamedDownload;
  guid?: string;
  stop: (verdict: DownloadVerdict) => void;
};

/**
 * One tab's downloads, and the limit they are held to.
 *
 * `progress` is fed from the tab's DevTools session; `watch` is called from Playwright's `download`
 * event. The two arrive in either order, and neither names the other: the tab's events carry
 * Chromium's guid, Playwright's `Download` does not expose it. They are joined by the address and the
 * file name, which is what both do carry — two downloads of the same file at once are the same
 * decision anyway.
 */
export function createDownloadLimit(options: {
  limitBytes: number;
  maxMs?: number;
}) {
  const maxMs = options.maxMs ?? DOWNLOAD_MAX_MS;
  const known = new Map<string, Known>();
  const watches = new Set<Watch>();

  const matches = (watch: Watch, entry: Known) =>
    entry.url === watch.download.url() &&
    (entry.name === undefined ||
      entry.name === watch.download.suggestedFilename());

  const tooLarge = (entry: Known) =>
    entry.total > options.limitBytes || entry.received > options.limitBytes;

  /** Join a watch to a download the tab has reported, and judge it on what is known so far. */
  const join = (watch: Watch) => {
    if (watch.guid === undefined) {
      for (const [guid, entry] of known) {
        if (entry.claimed || !matches(watch, entry)) continue;
        entry.claimed = true;
        watch.guid = guid;
        break;
      }
    }
    const entry = watch.guid === undefined ? undefined : known.get(watch.guid);
    if (entry && tooLarge(entry)) watch.stop("too_large");
  };

  return {
    /** What the tab said about one download. Never throws: this is fed from an event handler. */
    progress(event: DownloadProgress): void {
      const entry = known.get(event.guid) ?? {
        total: 0,
        received: 0,
        claimed: false,
      };
      if (event.url !== undefined) entry.url = event.url;
      if (event.suggestedFilename !== undefined) {
        entry.name = event.suggestedFilename;
      }
      if (typeof event.totalBytes === "number") entry.total = event.totalBytes;
      if (typeof event.receivedBytes === "number") {
        entry.received = event.receivedBytes;
      }
      if (event.state === "completed" || event.state === "canceled") {
        known.delete(event.guid);
      } else {
        known.set(event.guid, entry);
      }
      for (const watch of watches) {
        if (watch.guid === undefined || watch.guid === event.guid) join(watch);
      }
    },

    /**
     * Hold one download to the limit. `verdict` settles only when it has to be stopped — too large,
     * or still going at `maxMs` — and `done` lets it go once it has been saved or has failed.
     */
    watch(download: NamedDownload): {
      verdict: Promise<DownloadVerdict>;
      done: () => void;
    } {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settle: (verdict: DownloadVerdict) => void = () => undefined;
      const verdict = new Promise<DownloadVerdict>((resolve) => {
        settle = resolve;
      });
      const watch: Watch = {
        download,
        stop: (reason) => {
          done();
          settle(reason);
        },
      };
      const done = () => {
        clearTimeout(timer);
        watches.delete(watch);
        if (watch.guid !== undefined) known.delete(watch.guid);
      };
      watches.add(watch);
      timer = setTimeout(() => watch.stop("too_slow"), maxMs);
      join(watch);
      return { verdict, done };
    },
  };
}
