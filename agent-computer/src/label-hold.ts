/**
 * A control is acted on only while it is still called what it was judged as.
 *
 * THE BOUNDARY JUDGES THE NAME THE SNAPSHOT GAVE; THE CLICK LANDS ON THE NODE. A ref resolves for as
 * long as its node is connected, and a node whose text changes stays connected — so between a
 * snapshot and the click that used it, a page can turn "저장" into "결제하기" on the same button, and
 * the money-word rule, having judged "저장", lets the click through. Measured 2026-09-10 (audit A3,
 * fixture `/reorder`, the `relabel` case): click 200, the page's own counter recorded 결제하기, no
 * approval card.
 *
 * So the caller says what it judged — the role and name the server resolved the ref to, from its own
 * snapshot and never from the model — and the moment before acting this asks whether the node still
 * has them. Not: a refusal, and the Bot takes a snapshot, sees the name the control has now, and is
 * judged on THAT, with any approval bound to it rather than to the one it replaced.
 *
 * NOT BY READING THE NAME. The first attempt read it with `locator.ariaSnapshot()`, and in Playwright
 * 1.62 every aria snapshot — default mode included — replaces the one `aria-ref=` resolves against
 * (`_lastAriaSnapshotForQuery`). Measured 2026-09-13: after that read the same ref no longer resolved,
 * so every click held to a label would have lost its element. The role engine asks the same
 * question without touching that state: `aria-ref=… >> internal:and=role[name]` matches only if the
 * node still has that role and that name, computed by the function the snapshot used, and a frame
 * ref (`f1e3`) takes the whole selector into its frame.
 */
import type { Locator } from "playwright";

export type JudgedLabel = { role: string; name: string };

/** The control is still there and is not called what it was judged as. */
export class LabelChangedError extends Error {
  constructor() {
    super("laf:label_changed");
    this.name = "LabelChangedError";
  }
}

/** What the caller judged, when it said so in a usable shape; nothing otherwise. */
export function judgedLabelOf(value: unknown): JudgedLabel | null {
  if (!value || typeof value !== "object") return null;
  const { role, name } = value as { role?: unknown; name?: unknown };
  return typeof role === "string" && role && typeof name === "string"
    ? { role, name }
    : null;
}

/** Where the server cuts a name (`toElement` in aria-snapshot.ts). A name this long may be a prefix. */
const JUDGED_NAME_LIMIT = 200;

/**
 * The name to ask the role engine for: exactly what was judged, unless what was judged cannot be the
 * whole name.
 *
 *  - Cut at 200 by the server: the live name has to START with it.
 *  - Empty: the snapshot renders no name for one longer than 900 characters, and a name written
 *    `/like this/` without its quotes, which the parser then reads as no name. Those two, or empty.
 */
export function nameToMatch(name: string): string | RegExp {
  if (name.length >= JUDGED_NAME_LIMIT) {
    return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`);
  }
  if (name === "") return /^(|\/.*\/|.{901,})$/;
  return name;
}

/**
 * Hold an action to the label it was judged on.
 *
 * `"unchecked"` when the caller judged nothing — an older server makes no such promise and is held to
 * none. Otherwise the control either still has that role and name, or this throws. The caller has
 * already established that the ref resolves, so a miss here is the control, not the ref.
 */
export async function holdToLabel(
  control: Locator,
  judged: unknown,
): Promise<"unchecked" | "same"> {
  const wanted = judgedLabelOf(judged);
  if (!wanted) return "unchecked";
  const still = control.and(
    control
      .page()
      .getByRole(wanted.role as Parameters<Locator["getByRole"]>[0], {
        name: nameToMatch(wanted.name),
        exact: true,
      }),
  );
  if ((await still.count()) > 0) return "same";
  throw new LabelChangedError();
}
