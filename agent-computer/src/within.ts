/**
 * An answer from the browser, or none by a moment that has to come.
 *
 * MOST OF PLAYWRIGHT'S CALLS TAKE A TIMEOUT, AND THE ONES A LOOK LEANS ON DO NOT. `evaluate`,
 * `evaluateAll` and `count` wait for the frame they are asked of to have a document, and a frame whose
 * request was accepted and never answered never has one: measured 2026-09-14 on 1.62.1, each of them
 * on such a frame outlasted every bound it was given (15 s, 15 s, 4 s), and a snapshot of a page
 * carrying one never came back (W3-c). A whole tab does the same while its next document is on its
 * way (`page-arrival.ts`). `title()` looked like the exception — it answered in milliseconds — but what
 * it answered was Playwright's `Loading ` and the address being loaded, not a title, so a title is
 * asked of the document through this too (`titleOf`).
 */

/**
 * What `work` answers within `ms`, or `undefined` when it has not answered by then — or failed.
 *
 * The work is not stopped, because Playwright offers no way to stop it, and its failure is swallowed
 * so a frame that detaches after the look has moved on is not an unhandled rejection. A caller that
 * must tell "failed" from "not yet" catches the failure into a value of its own before handing the
 * work in, and keeps the promise if the late answer still matters.
 */
export async function within<T>(
  ms: number,
  work: Promise<T>,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
