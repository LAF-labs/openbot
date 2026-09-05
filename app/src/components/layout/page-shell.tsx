import type * as React from "react";

import { PageHeader } from "@/components/layout/page-header";
import {
  pageMeasure,
  sectionDescriptionClass,
  sectionTitleClass,
  sectionTitleRowClass,
} from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

/**
 * The frame every configuration screen sits in.
 *
 * WHAT THIS IS FIXING. Admin was nine pages that shared no layout: four container widths plus three
 * pages with no container at all, four heading sizes, four padding schemes, and a sidebar 20px wider
 * than the rest of the app. Three of those pages imported nothing from `components/ui` and drew
 * their own buttons, inputs and tables. The result did not read as a different screen, it read as a
 * different application — which is the impression an administrator forms at exactly the moment they
 * are deciding whether to trust it with credentials.
 *
 * The shape was never in doubt: Skills and Settings already had it. So this is that shape, extracted
 * once and used everywhere, INCLUDING by Skills and Settings. Leaving those two as hand-written
 * copies would mean three dialects rather than two, and the next screen somebody writes copies
 * whichever it happened to see first.
 */

/**
 * `prose` is the default because configuration is mostly reading. A measure of around 65 characters
 * is where prose stays comfortable, and a row of label-and-control has no business being wider than
 * the sentence explaining it.
 *
 * `wide` exists for one page. An audit log is a table you scan, and forcing it into the prose column
 * would wrap every row. It is not a licence for anything else to be wide.
 */
type ShellWidth = "prose" | "wide";

export function PageShell({
  action,
  children,
  className,
  description,
  title,
  width = "prose",
}: {
  /** Sits on the title's baseline. For the page's one primary verb, if it has one. */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title: string;
  width?: ShellWidth;
}) {
  return (
    /*
     * THE SCROLLER LIVES HERE, AND IT HAS TO LIVE SOMEWHERE.
     *
     * The app shell is one non-scrolling viewport on purpose — the transcript's own scroller sizes
     * against it — so `main` is `overflow-hidden` and the document never scrolls. Nothing then
     * scrolled these pages either: Routines, Skills, Settings and every Admin screen simply CLIPPED
     * whatever did not fit, and on a short window the bottom of the page was unreachable by any
     * means. Putting it in the shell rather than on each page means the next screen somebody writes
     * inherits it instead of rediscovering this.
     *
     * The outer element owns the scrolling and the inner one keeps the measure, because a scroll
     * container that is also the max-width column puts its scrollbar in the middle of the page.
     */
    <div className="min-h-0 w-full flex-1 overflow-y-auto">
      <div
        className={cn(
          "mx-auto flex w-full flex-col px-4 py-12",
          pageMeasure[width],
          className,
        )}
      >
        {/*
         * The header is its own component now, so the three sibling pages cannot drift apart: they
         * all reach it through this shell, and it reaches the tokens in `ui/page-header.ts`.
         */}
        <PageHeader action={action} description={description} title={title} />
        {children}
      </div>
    </div>
  );
}

/**
 * A titled group of rows.
 *
 * The gap above a section is deliberately large. These pages are lists of unrelated decisions, and
 * the space is what stops the eye running two of them together — it is doing the work a divider
 * would otherwise do, without drawing a line.
 */
export function PageSection({
  action,
  children,
  className,
  description,
  title,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title?: string;
}) {
  return (
    <section className={cn("mt-12", className)}>
      {title ? (
        <div className={sectionTitleRowClass}>
          {/* 17px/600 — the scale's section title. See `ui/page-header.ts`. */}
          <h2 className={sectionTitleClass}>{title}</h2>
          {action}
        </div>
      ) : null}
      {description ? (
        <p className={sectionDescriptionClass}>{description}</p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The card that rows live in.
 *
 * Rows are `<Item size="sm">` with a `<Separator />` between them; this is only the border around
 * them. Rendering nothing when there is nothing is deliberate — an empty bordered box reads as a
 * thing that failed to load, where absence reads as nothing to see yet.
 */
export function PageRows({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("mt-4 rounded-lg border border-border bg-card", className)}
    >
      {children}
    </div>
  );
}

/**
 * What a section says when it has nothing to list.
 *
 * Said in a sentence rather than drawn as an illustration with a heading: on a configuration screen
 * "nothing here yet" is a fact, not an event, and the page already told you what the section is for.
 */
export function PageEmpty({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-muted-foreground text-sm">{children}</p>;
}
