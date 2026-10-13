/**
 * The entry: the server, which is `main.ts`, and nothing ahead of it.
 *
 * Until 2026-10-13 this file loaded `eventsource` first, in two dynamic imports in sequence, to
 * settle a race at boot. Deep inside CopilotKit's runtime, `@ag-ui/mcp-apps-middleware` was
 * CommonJS and pulled in `@modelcontextprotocol/sdk/client/sse.js` as CommonJS, which does
 * `require("eventsource")`, while the runtime's own graph imported the same module as ESM. Bun can
 * `require()` an ES module that is already evaluated, or one nothing has touched yet; what it
 * cannot do is wait for one its loader is in the middle of loading. When the CommonJS side lost
 * the timing, the process died before its first log line:
 *
 *     TypeError: require() async module ".../eventsource/dist/index.js" is unsupported.
 *
 * Seen on CI (run 34005591828, Bun 1.3.14, Linux), in the server that
 * log-hygiene.integration.test.ts spawned, and only ever with several boots at once.
 *
 * The runtime left the server in #230 and took the CommonJS side with it. What the server loads
 * of the MCP SDK is its ES build, from `client/index.js` and `client/streamableHttp.js`
 * (plugins/mcp.ts), and following every import from this file, the converter's entry, the scripts
 * and each test file reaches `eventsource` from none of them. Measured 2026-10-13 in the image
 * server/Dockerfile builds (oven/bun:1.3.14, two CPUs), thirty boots at once, five rounds: the
 * tree from before #230 with a plain `import "./main"` lost 72 of 150 boots to that TypeError;
 * this entry lost 0 of 300 run from source and 0 of 300 as the bundle, and with the preload it
 * was 0 of 150 each way.
 *
 * If that TypeError comes back, something has brought a CommonJS `require("eventsource")` into
 * the graph again — the SDK's SSE client is where it lives — and the cure is in this file's
 * history. The test suite had the same preload (`bunfig.toml`, `server/scripts/test-preload.ts`)
 * and lost it the same day.
 */
import "./main";
