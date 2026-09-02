import * as mcp from "../../src/plugins/mcp";

/**
 * The MCP client as the module actually ships it, snapshotted before any suite mocks the door.
 *
 * WHY THIS EXISTS. `mock.module` in bun is PROCESS-WIDE and it MERGES: every test file is evaluated
 * before any test runs, so one suite stubbing `../src/plugins/mcp` replaces `listTools` and
 * `callTool` for the whole run, in every file, whatever order they are listed in. Three suites
 * already carry a comment about it, and each answers it by injecting `callVendor` so that they never
 * touch the transport at all.
 *
 * That answer does not work for a suite whose subject IS the transport — what the HTTP client does
 * with a redirect cannot be asserted against a stub of the HTTP client. So the real module is
 * captured here, in a module both the stubbing suite and the transport suite import: a static import
 * is evaluated before the importing file's body, so whichever of them is loaded first, this snapshot
 * is taken before the `mock.module` call in that body.
 *
 * A suite that needs the real transport restores it in `beforeAll`; the suite that needs the stub
 * puts its own back the same way. Between them nothing depends on which file bun loads first.
 */
export const realMcpModule = { ...mcp };
