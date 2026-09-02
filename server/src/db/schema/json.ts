import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";

/**
 * A `jsonb` column that actually stores JSON — objects AND arrays.
 *
 * Drizzle's ordinary `jsonb()` serialises the value in `mapToDriverValue`, and Bun's `SQL` driver
 * serialises it again on the way to Postgres. Objects that need SQL JSON operators use this custom
 * type so they are stored as JSON objects. The same insert through both paths:
 *
 *   drizzle jsonb()   jsonb_typeof = "string"   payload->>'bot' = NULL
 *   this type         jsonb_typeof = "object"   payload->>'bot' = "y"
 *
 * Application reads can still render double-encoded values as objects. SQL consumers require stored
 * JSON objects so fields such as `payload->>'bot'` stay queryable.
 *
 * Serialize once. The driver already knows how to send an object to a `jsonb`
 * parameter, so this hands it the object and stays out of the way. Reads are unchanged: both paths
 * return an object, which is why this can be swapped in without touching a single call site.
 *
 * ARRAYS TAKE THE THIRD FORM, and there were only ever three to choose between — measured on this
 * driver, not guessed. A top-level JS array handed straight to the driver is read as a POSTGRES
 * array (`{}`-syntax) and the insert fails; a parameter cast straight to `::jsonb` makes the jsonb
 * serialiser stringify an already-stringified value, storing a jsonb *string* that every SQL-side
 * `->>` and `jsonb_array_elements` then refuses. Typing the parameter as text first is the one form
 * that lands as a real jsonb array. Three call sites used to spell that cast out by hand next to a
 * drizzle `jsonb()` column; it belongs here, once, so a new array column cannot get it wrong —
 * `laf_routine_runs.steps` did, and every row it ever wrote is a jsonb string (migration 0026
 * repairs them).
 *
 * Use this everywhere instead of `jsonb` from `drizzle-orm/pg-core`.
 */
export const jsonb = customType<{
  data: Record<string, unknown>;
  driverData: unknown;
}>({
  dataType: () => "jsonb",
  // Straight through for an object. The double `JSON.stringify` is the whole bug.
  toDriver: (value) =>
    Array.isArray(value) ? sql`${JSON.stringify(value)}::text::jsonb` : value,
});
