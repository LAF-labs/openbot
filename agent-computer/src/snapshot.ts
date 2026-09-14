/**
 * Describe everything on the page a Bot can act on.
 *
 * Elements are addressed by reference, not by pixel. A snapshot stamps every interactive element
 * with a ref and hands back a compact list; `/click` and `/type` take one of those refs. That is the
 * accessibility-tree-first driver this is built on, and it is why filling in a form needs no vision
 * model at all: the Bot reads a list of fields rather than squinting at a picture and guessing
 * coordinates. Pixels remain the eventual fallback for canvas-style pages that expose no elements.
 *
 * Uses Playwright's AI snapshot rather than stamping attributes into the DOM. `ariaSnapshot` keeps
 * refs outside the page, survives framework re-renders, resolves accessible names, reports current
 * values and checked state, filters to actionable elements and descends into iframes.
 */
import type { Page } from "playwright";
import { parseAriaSnapshot, type SnapshotElement } from "./aria-snapshot";
import { settleIfLoading } from "./page-text";
import type { TabSummary } from "./profiles";
import { secretSignals, typedIntoRefs } from "./secret-fields";
import type { BotSession } from "./sessions";

export type Snapshot = {
  snapshotId: number;
  url: string;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
  tabs: TabSummary[];
};

export async function snapshotPage(
  session: BotSession,
  target: Page,
  tabs: () => Promise<TabSummary[]>,
): Promise<Snapshot> {
  session.snapshotId += 1;
  // A tab that opened a moment ago is still `about:blank`, and an aria snapshot of that is an empty
  // list — which reads as "there is nothing on this page you can act on".
  await settleIfLoading(target);
  /*
   * THE SECRET FIELDS FIRST, THE PAGE LAST. A ref is minted the first time an element is
   * snapshotted and reused after, so either order names the same refs — but Playwright resolves
   * `aria-ref=` only against the MOST RECENT snapshot, and the other way round left the page's refs
   * dangling behind a snapshot of one input (measured: the person's value could not be typed into
   * the box the Bot had just named, 502 after the action timeout). The page's has to be the one
   * standing when the Bot acts.
   */
  const marked = await secretSignals(session, target);
  const yaml = await target.ariaSnapshot({ mode: "ai" });
  // After the page's snapshot, not before: whether a ref still names a node is asked of the
  // snapshot standing now, and a node renamed since the last one has only just been handed its ref.
  const typedInto = await typedIntoRefs(session, target, yaml);
  return {
    snapshotId: session.snapshotId,
    url: target.url(),
    title: await target.title(),
    ...parseAriaSnapshot(yaml, {
      labels: marked.labels,
      values: marked.values,
      refs: [...marked.refs, ...typedInto],
    }),
    /*
     * The other tabs, listed with the elements rather than behind a tool of their own.
     * A Bot that has to ask whether a second tab exists will not ask, and the tab a click just
     * opened is usually where the answer is. `computer_switch_tab` takes the index from here.
     */
    tabs: await tabs(),
  };
}
