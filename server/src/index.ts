/**
 * The entry: `eventsource` first, then the server, which is `main.ts`.
 *
 * Deep inside the runtime's dependencies, `@ag-ui/mcp-apps-middleware` is CommonJS and pulls in
 * `@modelcontextprotocol/sdk/client/sse.js` as CommonJS, which does `require("eventsource")`.
 * Under Bun that resolves to eventsource's ESM build — its package.json lists a `bun` export
 * condition ahead of `require` — and the runtime's own graph imports the same module as ESM.
 * Bun can `require()` an ES module that is already evaluated, or one nothing has touched yet;
 * what it cannot do is wait for one its loader is in the middle of loading. So which side
 * reaches `eventsource` first is a matter of the loader's timing, and when the CommonJS side
 * loses, the process dies before its first log line:
 *
 *     TypeError: require() async module ".../eventsource/dist/index.js" is unsupported.
 *
 * Seen on CI (run 34005591828, Bun 1.3.14, Linux): the server that
 * log-hygiene.integration.test.ts spawned crashed exactly so, and the runs before and after it
 * booted. Reproduced under oven/bun:1.3.14 with two CPUs and six boots at once: 7 of 30 boots
 * died so with the old entry, 0 of 30 with this one; one boot at a time never showed it, on
 * 1.3.11 or 1.3.14, which is why it only ever appeared on the runner. The test process itself
 * was already covered — `bunfig.toml` preloads `eventsource` before any test file, see
 * scripts/test-preload.ts — but the server as a process of its own, in the image and under
 * that test, had nothing of the kind.
 *
 * Two dynamic imports in sequence are the guarantee a static import cannot give: static imports
 * are fetched in parallel, and a CommonJS module runs while the rest are still in flight. Here
 * `eventsource` is evaluated to completion before the server's graph begins to load, so by the
 * time anything requires it, it is there.
 */
await import("eventsource");
await import("./main");

// A file with no static import or export is a script to TypeScript, and a script may not `await`
// at the top level. Bun runs it as a module either way; this is for the typecheck.
export {};
