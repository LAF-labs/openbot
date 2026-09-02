import type { AskSubject } from "../../src/computer/approvals";

/**
 * What a question is about, in the shape the registry takes, for tests that have to open one.
 *
 * Here rather than in each file because six suites open approvals by hand and they were all passing
 * the same made-up sentence; a shape that has to be spelled out in six places is a shape five of
 * them will be wrong about the next time it changes. See `AskSubject` for why the sentence went.
 */
export const A_CLICK: AskSubject = {
  kind: "browser",
  intent: "activate",
  host: "example.com",
  // The same page the suites' snapshot fixture is on, so a test that compares what the gateway
  // produced against this one is comparing two things that were built the same way.
  path: "/order",
  element: { role: "button", name: "Submit order" },
  reason: "policy_ask",
};

/** A tool call on somebody else's server, stopped by the contract's money floor. */
export const A_TOOL_CALL: AskSubject = {
  kind: "tool",
  intent: "call_tool",
  tool: { server: "notion", name: "create_page", guard: "money" },
  reason: "guard_floor",
};
