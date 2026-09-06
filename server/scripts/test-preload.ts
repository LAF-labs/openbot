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
 * decides the outcome.
 *
 * The running server has the same race without any test file involved — the runtime's own graph
 * imports `eventsource` as ESM while the CommonJS side requires it, and which one gets there first
 * is the loader's timing — so `src/index.ts` does for the process what this file does for the
 * suite, and `eventsource` is a dependency of this package rather than a dev dependency.
 *
 * This compatibility shim is narrow enough to delete, together with the entry's, when the SDK
 * ships an ESM-safe require or Bun handles it.
 */

import "eventsource";
