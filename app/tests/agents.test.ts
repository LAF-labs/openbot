import { describe, expect, test } from "bun:test";
import { agentKeys } from "@/lib/agents/queries";
import { channelKeys } from "@/lib/channels/queries";

describe("coworker query keys", () => {
  test("separates the visible roster from the hidden one", () => {
    expect(agentKeys.list()).toEqual(["agents", "list", { hidden: false }]);
    expect(agentKeys.list(true)).toEqual(["agents", "list", { hidden: true }]);
    // Both lists and every profile sit under one prefix, so a mutation can invalidate all of them.
    expect(agentKeys.detail("agent_1")[0]).toBe(agentKeys.all[0]);
    expect(channelKeys.detail("channel_1")).toEqual([
      "channels",
      "detail",
      "channel_1",
    ]);
  });
});
