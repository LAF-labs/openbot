/**
 * A Bot's tabs in the deployment's one browser, and how long they may sit unused.
 */

/** One tab in a Bot's browser, as the snapshot lists them. */
export type TabSummary = {
  /** Position in the Bot's own list, which is what `computer_switch_tab` takes. */
  index: number;
  title: string;
  url: string;
  /** The one the Bot's next action lands on. */
  active: boolean;
};

/** A tab index that names nothing. Its own type so the route can answer 400 rather than 502. */
export class TabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabError";
  }
}

/**
 * How long a Bot may leave its tabs untouched before they are closed.
 *
 * Ten minutes. Four of five Bots are usually asleep between a routine at nine and one at noon, and a
 * tab nobody is looking at still costs a renderer; closing them costs the next call a page load and
 * gives the machine its memory back. The cookies are on the volume and the profile is shared, so
 * nothing is signed out by it — and when the last Bot's tabs go, so does the browser.
 */
export const IDLE_CLOSE_MS = 10 * 60_000;

/** How often idleness is checked. Coarse on purpose: this is housekeeping, not a deadline. */
export const IDLE_SWEEP_MS = 60_000;
