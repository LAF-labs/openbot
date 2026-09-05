import type * as React from "react";
import {
  pageDescriptionClass,
  pageHeaderClass,
  pageTitleClass,
  pageTitleRowClass,
} from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

/**
 * ONE PAGE HEADER, AND THE THREE SIBLING PAGES GET IT BY CONSTRUCTION.
 *
 * Bots, Routines and Skills sit next to each other in the rail and a person walks between them in
 * one session, so a difference between their headings reads as three products rather than three
 * screens. They had three: Bots drew a title with a `NewBotButton` that rendered a div wrapping a
 * button and a paragraph; Routines drew a title, a description and a filled `Button`; Skills drew a
 * title and a description with the verb pushed down into a section.
 *
 * The shape is settled: TITLE · optional count in the section below · ONE primary verb, on the
 * title's baseline, as a real `<Button>`. This component is where that lives, so the next screen
 * inherits it instead of measuring it again.
 *
 * THE CLASSES COME FROM `ui/page-header.ts`, which is another stream's file and deliberately holds
 * only strings — how big a page title is, where the description sits — because that is a token
 * question. This is the markup question: what order the parts go in and what element the verb is.
 * `app/tests/page-header.test.ts` walks the three routes and checks they all arrive here.
 *
 * THE ACTION IS A BUTTON, NEVER AN ANCHOR WEARING `role="button"`. If it navigates, it is
 * `<Button nativeButton={false} render={(props) => <Link {...props} />}>` — see `ui/button.tsx`.
 */
export function PageHeader({
  action,
  className,
  description,
  title,
}: {
  /** The page's one primary verb, if it has one. On the title's baseline. */
  action?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  title: string;
}) {
  return (
    <header className={cn(pageHeaderClass, className)}>
      <div className={pageTitleRowClass}>
        <h1 className={pageTitleClass}>{title}</h1>
        {action}
      </div>
      {description ? (
        <p className={pageDescriptionClass}>{description}</p>
      ) : null}
    </header>
  );
}
