/**
 * The shape of a key from one of this product's own catalogues: a preset, a site, a routine
 * suggestion, a section of the guide. Lower-case letters and digits, hyphens inside, forty at most.
 *
 * ONE SHAPE, BECAUSE THE FLEET HOLDS US TO IT. laf-control's `insights` re-checks every key a VM
 * hands back against exactly this (`core/insights.ts` `KEY`) and reads anything else as `other`, so
 * a key written here in any other shape is a count the fleet silently files under the wrong name.
 * And the shape is what keeps a sentence out: no spaces, no `@`, no dots — a value that passes it
 * cannot be somebody's words or somebody's address, whatever a client sent.
 */
export const CATALOGUE_KEY_SOURCE = "^[a-z0-9][a-z0-9-]{0,39}$";

const CATALOGUE_KEY = new RegExp(CATALOGUE_KEY_SOURCE);

export const isCatalogueKey = (value: unknown): value is string =>
  typeof value === "string" && CATALOGUE_KEY.test(value);
