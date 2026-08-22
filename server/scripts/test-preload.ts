/**
 * Loaded before any test file, to make module loading deterministic.
 *
 * Deep inside the runtime's dependencies, `@modelcontextprotocol/sdk`
 * does `require("eventsource")` from CommonJS, and eventsource ships as ESM only. Bun permits that
 * only when the module has already been evaluated as ESM by something earlier in the process, so
 * whether it works depends on the order the test files happen to be walked, an order that changes
 * whenever a test file is added or renamed.
 *
 * The failure is not a failing test. The file throws while being imported, so its tests are never
 * registered and never reported.
 *
 * Importing it here evaluates it as ESM once, before anything requires it, so the order no longer
 * decides the outcome. `eventsource` is declared as a dev dependency of this package for the same
 * reason; test determinism depends on it.
 *
 * This compatibility shim is narrow enough to delete when the SDK ships an ESM-safe require or Bun
 * handles it.
 */

import "eventsource";

/*
 * Seats, out of the way of the tests.
 *
 * An account's computer seats five Bots, and the integration tests write to a real database — so as
 * soon as a few Bots exist in it for any other reason, a test that creates two of its own fails
 * with a roster-full error about data it never made. The product number stays five; this is the
 * suite declining to share that budget.
 */
process.env.BOT_SEATS_PER_ACCOUNT ??= "1000";
