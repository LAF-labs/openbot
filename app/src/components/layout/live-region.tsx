import type { ReactNode } from "react";

/**
 * A LINE A SCREEN READER HEARS WHEN IT CHANGES — MOUNTED BEFORE IT HAS ANYTHING TO SAY.
 *
 * A screen reader announces a change inside a live region it already knows about. A status line
 * written `{saved ? <p role="status">저장됨</p> : null}` arrives in the same commit as its region,
 * so there is no change for it to announce, and in most screen readers nothing is read out: the
 * person pressed 저장 and heard nothing. That was the shape of every status line this app had —
 * 저장됨, the reconnecting pill, what 모두 멈추기 came to, a Bot's "생각하는 중".
 *
 * So the region is always there, and only its words come and go. While it is empty it is
 * `sr-only` — in the accessibility tree, out of the layout, so an empty line leaves no gap in a
 * column — and once it has words it takes the classes it was given.
 *
 * `status` (polite) for anything that is progress or a confirmation; it waits for a pause in
 * whatever is being read. `alert` interrupts, and is kept for a failure: a person told "failed"
 * a sentence late has already moved on as though it worked.
 */
export function LiveRegion({
  as: Element = "div",
  children,
  className,
  tone = "status",
}: {
  /** `p` or `span` where the line sits inside prose; a `div` inside a `p` is not valid HTML. */
  as?: "div" | "p" | "span";
  children?: ReactNode;
  className?: string;
  tone?: "status" | "alert";
}) {
  const isEmpty = isNothing(children);
  return (
    <Element
      aria-atomic="true"
      aria-live={tone === "alert" ? "assertive" : "polite"}
      className={isEmpty ? "sr-only" : className}
      role={tone === "alert" ? "alert" : "status"}
    >
      {isEmpty ? null : children}
    </Element>
  );
}

/** What React draws as nothing: the values a `cond ? words : null` hands over when it is off. */
function isNothing(node: ReactNode): boolean {
  if (node === null || node === undefined || node === false || node === "") {
    return true;
  }
  return Array.isArray(node) && node.every(isNothing);
}
