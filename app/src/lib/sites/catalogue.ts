/**
 * The site catalogue, as the surface reads it.
 *
 * THE TABLE ITSELF IS IN `shared/sites/catalogue.ts` and this re-exports it, because the server
 * needs the same rows: every successful navigation is matched against these hosts so that a routine
 * opening 배민 at 6am refreshes the card, and the "is this page signed in" question has to be
 * answered by the SAME predicate the card was drawn from. A second copy over here would disagree
 * within a month, and the disagreement would look like a card lying about a login.
 *
 * Everything user-facing on those rows is an English key. `t()` is called on it at the point of
 * drawing — a variable call, invisible to `i18n-coverage.test.ts`, which is why
 * `app/tests/site-catalogue.test.ts` walks the table instead.
 */
export {
  BUSINESS_SITES,
  type BusinessSite,
  hostBelongsTo,
  type SiteCategory,
  type SiteHandoff,
  siteById,
  siteForUrl,
} from "@shared/sites/catalogue";
