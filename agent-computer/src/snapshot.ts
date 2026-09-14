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
import {
  opaqueFramesIn,
  parseAriaSnapshot,
  type SnapshotElement,
} from "./aria-snapshot";
import {
  type Arrival,
  arrivalNote,
  arrivalOf,
  WHILE_ARRIVING_MS,
} from "./page-arrival";
import { settleIfLoading, titleOf } from "./page-text";
import type { TabSummary } from "./profiles";
import {
  SECRET_JOIN_TIMEOUT_MS,
  type SecretMarks,
  secretSignals,
  typedIntoRefs,
} from "./secret-fields";
import { type BotSession, note } from "./sessions";

export type Snapshot = {
  snapshotId: number;
  url: string;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
  tabs: TabSummary[];
  /**
   * How many iframes on the page the snapshot could not see into (`opaqueFramesIn`).
   *
   * Always a number, zero included, so the server can tell "none" from an older image that never
   * counted. What a Bot is missing inside one is a payment or 본인인증 window more often than not,
   * and the audit row for a snapshot that met one is how anybody learns which sites do it.
   */
  opaqueFrames: number;
};

/**
 * HOW LONG A LOOK MAY TAKE, WHATEVER THE PAGE'S FRAMES DO.
 *
 * There was no deadline, and a frame whose request was accepted and never answered held the look for
 * ever. Found by W3-c and measured 2026-09-14 in the image built from eeea985, on the fixture's
 * `/hanging-frame`: `/snapshot` did not answer in 120 s, twice — the server's client ends the Bot's
 * call at 45 s, as `laf:computer_timed_out`. The wait was the secret join's `evaluateAll` on that
 * frame, which has no timeout; had it answered, Playwright's tree would have sat out its default
 * thirty seconds on the same frame (measured: 30.04 s).
 *
 * Every wait inside fits in this now, the longest first: a page still arriving (`settleIfLoading`,
 * up to 5 s), a frame with no document yet ({@link FRAME_WAIT_MS}), the secret join (1 s a step), and
 * {@link AFTER_TREE_MS} kept for what follows the tree. A frame that has not arrived by then is left
 * out and counted in `opaqueFrames`, and the Bot is answered with what the browser could see. A third
 * of the server client's deadline, so the look ends and says so well before the call does.
 */
export const SNAPSHOT_DEADLINE_MS = 15_000;

/**
 * How long the tree waits for a frame that has not given the browser a document yet.
 *
 * Playwright's tree enters every frame it meets, waits for each one's document, and spends the whole
 * of its timeout on a frame that never gets one — then leaves that frame as a bare `- iframe` line,
 * without failing the rest (measured on 1.62.1: 5 s given, 5.04 s taken, the page's own controls all
 * there). Its default is thirty seconds. Three is room for a payment window that is slow rather than
 * dead, on a page `settleIfLoading` has already waited for; what arrives later, the next look finds.
 */
const FRAME_WAIT_MS = 3_000;

/**
 * What the tree leaves for the steps after it: the late join's wait, and the refs of a field a
 * person typed a secret into. A tree is never given time out of this.
 */
const AFTER_TREE_MS = 3 * SECRET_JOIN_TIMEOUT_MS;

/**
 * What reading a late frame's refs commits the look to: the late join's wait and its snapshots of
 * inputs, then a whole tree again. Refs are not read unless all of it still fits.
 */
const RETAKE_MS = 2 * SECRET_JOIN_TIMEOUT_MS + FRAME_WAIT_MS;

/**
 * The page's tree, in the time the look has left.
 *
 * A throw from the first try is the page itself not answering — a document still being replaced —
 * because frames that will not answer come back as bare lines rather than as a failure. That page
 * gets what is left of the deadline, the way it used to get Playwright's thirty seconds.
 *
 * NEVER A TIMEOUT OF ZERO, which Playwright reads as no timeout at all: a look with no time left fails
 * rather than waits.
 */
async function pageTree(target: Page, deadline: number): Promise<string> {
  const left = () => deadline - Date.now() - AFTER_TREE_MS;
  /*
   * NOT A SECOND TRY FOR A PAGE WHOSE NEXT DOCUMENT IS ON ITS WAY: it will not answer before that
   * one arrives, and the look that asked is told so (`treeOrArrival`) rather than made to wait out
   * the deadline for it. Nor a full first try, once that is already known.
   */
  const first = Math.min(
    arrivalOf(target) ? WHILE_ARRIVING_MS : FRAME_WAIT_MS,
    left(),
  );
  if (first <= 0) throw new Error("laf:browser_failed");
  try {
    return await target.ariaSnapshot({ mode: "ai", timeout: first });
  } catch (error) {
    const again = left();
    if (
      !(error instanceof Error && error.name === "TimeoutError") ||
      again <= 0 ||
      arrivalOf(target)
    ) {
      throw error;
    }
    return target.ariaSnapshot({ mode: "ai", timeout: again });
  }
}

/**
 * The look at a tab whose next document is on its way: nothing on it, because nothing on it answers.
 *
 * Nothing from the tree either, even one already taken: its refs name a document that is leaving, and
 * whatever an early return would carry of it is exactly what the secret marking below exists to vet.
 * The generation has moved on, so an action carrying an older ref is told to look again; the tabs and
 * the address are the browser's to say, and `laf:page_loading` says why the rest is not here.
 */
async function stillArriving(
  session: BotSession,
  target: Page,
  tabs: () => Promise<TabSummary[]>,
  arrival: Arrival,
): Promise<Snapshot> {
  note(session, arrivalNote(arrival));
  return {
    snapshotId: session.snapshotId,
    url: target.url(),
    title: "",
    elements: [],
    truncated: false,
    tabs: await tabs(),
    opaqueFrames: 0,
  };
}

export async function snapshotPage(
  session: BotSession,
  target: Page,
  tabs: () => Promise<TabSummary[]>,
): Promise<Snapshot> {
  const deadline = Date.now() + SNAPSHOT_DEADLINE_MS;
  session.snapshotId += 1;
  // A tab that opened a moment ago is still `about:blank`, and an aria snapshot of that is an empty
  // list — which reads as "there is nothing on this page you can act on".
  if (!(await settleIfLoading(target))) {
    const arrival = arrivalOf(target);
    if (arrival) return stillArriving(session, target, tabs, arrival);
  }
  /*
   * A TREE THAT FAILED WHILE A DOCUMENT IS ON ITS WAY IS THAT, NOT A BROKEN BROWSER. Playwright's tree
   * does take its timeout on a tab whose document answers nothing, so before this the look ended at
   * the deadline as `laf:browser_failed` (measured 2026-09-14 in the image built from dbc1c67: 502 at
   * 12.0 s, one second into a `/navigate` to `/hang`). A navigation can begin after the question above
   * was answered — a page's own script — so every tree asks again.
   */
  const treeOrArrival = async (): Promise<string | Arrival> => {
    try {
      return await pageTree(target, deadline);
    } catch (error) {
      const arrival = arrivalOf(target);
      if (arrival) return arrival;
      throw error;
    }
  };
  /*
   * THE SECRET FIELDS FIRST, THE PAGE LAST. A ref is minted the first time an element is
   * snapshotted and reused after, so either order names the same refs — but Playwright resolves
   * `aria-ref=` only against the MOST RECENT snapshot, and the other way round left the page's refs
   * dangling behind a snapshot of one input (measured: the person's value could not be typed into
   * the box the Bot had just named, 502 after the action timeout). The page's has to be the one
   * standing when the Bot acts.
   */
  const joined = await secretSignals(session, target);
  let yaml = await treeOrArrival();
  if (typeof yaml !== "string") {
    return stillArriving(session, target, tabs, yaml);
  }
  const marks: SecretMarks = {
    labels: [...joined.labels],
    values: [...joined.values],
    refs: [...joined.refs],
  };
  /*
   * AND A FRAME THAT CAME IN BETWEEN IS JOINED, AND THE PAGE TAKEN LAST AGAIN. The join stops waiting
   * on a frame before the tree does, so a frame can reach the tree with a secret in it that the join
   * never saw (`SecretJoin`). What had not answered is heard once more here; when that took a
   * snapshot of an input for its ref, the tree is taken again so the page's is still the one standing.
   * Each frame answers late at most once, and refs are read only while a tree still fits.
   */
  for (;;) {
    const late = await joined.late({
      refs: deadline - Date.now() - AFTER_TREE_MS >= RETAKE_MS,
    });
    marks.labels.push(...late.labels);
    marks.values.push(...late.values);
    marks.refs.push(...late.refs);
    if (!late.snapshotted) break;
    const retaken = await treeOrArrival();
    if (typeof retaken !== "string") {
      return stillArriving(session, target, tabs, retaken);
    }
    yaml = retaken;
  }
  /*
   * After the page's snapshot, not before: whether a ref still names a node is asked of the
   * snapshot standing now, and a node renamed since the last one has only just been handed its ref.
   *
   * AND WHEN THAT QUESTION CANNOT BE ANSWERED, NO BOX KEEPS ITS VALUE. A field a person typed a secret
   * into is found in the tree by asking the page, and a page that stops answering part of the way —
   * its next document on its way, or the look's deadline come — leaves the field unfound: its ref
   * unmarked, and its value marked only if the join read it. A tab that is leaving is answered as
   * leaving; any other page with a question left unanswered shows the contents of no box
   * (`unverified`), which costs a Bot the sight of what is in the boxes for one look and never costs
   * anybody the secret.
   */
  const typedInto = await typedIntoRefs(session, target, yaml, deadline);
  if (!typedInto.complete) {
    const arrival = arrivalOf(target);
    if (arrival) return stillArriving(session, target, tabs, arrival);
  }
  return {
    snapshotId: session.snapshotId,
    url: target.url(),
    title: await titleOf(target),
    ...parseAriaSnapshot(yaml, {
      labels: marks.labels,
      values: marks.values,
      refs: [...marks.refs, ...typedInto.refs],
      ...(typedInto.complete ? {} : { unverified: true }),
    }),
    /*
     * The other tabs, listed with the elements rather than behind a tool of their own.
     * A Bot that has to ask whether a second tab exists will not ask, and the tab a click just
     * opened is usually where the answer is. `computer_switch_tab` takes the index from here.
     */
    tabs: await tabs(),
    opaqueFrames: opaqueFramesIn(yaml),
  };
}
