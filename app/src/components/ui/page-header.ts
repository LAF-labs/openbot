/**
 * THE PAGE HEADER, AS CLASSES — because the component belongs one directory up.
 *
 * `components/layout/` owns the frame (`PageShell`, `PageSection`) and is not this stream's to
 * edit, but the header pattern is a token question before it is a component question: how big is a
 * page title, how big is a section title, where does the description sit, and where does the one
 * primary verb go. Those answers live here so there is exactly one of each, and so a `PageHeader`
 * component built later composes them rather than re-typing them.
 *
 * The values are lifted verbatim from `PageShell` as it stands, so adopting them changes nothing on
 * screen. What changes is that the next screen has somewhere to look.
 *
 * THE RULE THE SURVEY FOUND. One page header in this app is built as an anchor wearing
 * `role="button"`, which logs a Base UI warning on every render and hands a screen reader two roles
 * for one element. A header's action is a `Button`; if it navigates it is
 * `<Button nativeButton={false} render={(props) => <Link {...props} />}>`, and never an `<a>` told
 * to pretend. See the note on `Button` in `ui/button.tsx`.
 */

/** The header block: title row, then description. */
export const pageHeaderClass = "flex flex-col gap-2";

/** Title and the page's one primary action, on the same baseline. */
export const pageTitleRowClass =
  "flex flex-row items-center justify-between gap-4";

/** 26px/600 — `text-2xl`, the top of the scale. One per page. */
export const pageTitleClass = "font-semibold text-2xl";

/**
 * The sentence under the title. `max-w-prose` even inside the prose column: a description that runs
 * the full width of a wide page is a paragraph nobody finishes.
 */
export const pageDescriptionClass =
  "max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed";

/** `min-h-8` so a section with an action and one without line up down the page. */
export const sectionTitleRowClass =
  "flex min-h-8 flex-row items-center justify-between gap-4";

/** 17px/600 — `text-lg`. */
export const sectionTitleClass = "font-semibold text-lg";

export const sectionDescriptionClass =
  "mt-1 max-w-prose text-pretty text-muted-foreground text-sm leading-relaxed";

/**
 * The two measures a configuration page may have.
 *
 * `prose` is the default because configuration is mostly reading; `wide` exists for the audit log,
 * which is a table you scan. It is not a licence for anything else to be wide.
 */
export const pageMeasure = {
  prose: "max-w-2xl",
  wide: "max-w-5xl",
} as const;
