import { describe, expect, test } from "bun:test";
import { isHubFrame } from "../src/lib/channels/use-channel-events";
import { hubFactText, hubStatusLine } from "../src/lib/hub/status";
import { ko } from "../src/lib/i18n-ko";

/**
 * 회사: the settings line on a VM that belongs to a company hub, and the hub's four facts in the
 * surface's words. The server says only the state and a code (`server/src/hub/link.ts`).
 */

const base = {
  configured: true as const,
  code: null,
  workspace: { name: "라프상사" },
  member: { role: "member", name: null },
  since: "2026-10-16T00:00:00.000Z",
};

describe("the company line", () => {
  test("is not drawn on a VM with no company", () => {
    expect(hubStatusLine({ configured: false })).toBeNull();
  });

  test("names the company and says it is connected, with nothing under it", () => {
    expect(hubStatusLine({ ...base, state: "connected" })).toEqual({
      line: "Company: 라프상사 · Connected",
      note: null,
      connected: true,
    });
  });

  test("says it is cut off, and why, in the surface's words", () => {
    expect(
      hubStatusLine({
        ...base,
        state: "disconnected",
        code: "laf:hub_unreachable",
      }),
    ).toEqual({
      line: "Company: 라프상사 · Disconnected",
      note: "Cannot reach the company server · trying again",
      connected: false,
    });
    expect(
      hubStatusLine({
        ...base,
        workspace: null,
        state: "refused",
        code: "laf:hub_pass_refused",
      }),
    ).toEqual({
      line: "Company · Disconnected",
      note: "The link to your company was undone. Let the operator know.",
      connected: false,
    });
  });

  test.each([
    "laf:hub_unreachable",
    "laf:hub_pass_refused",
    "laf:hub_forbidden",
    "laf:hub_not_found",
  ])("the fact %p has a sentence, and a Korean one", (code) => {
    const sentence = hubFactText(code);
    expect(sentence).toBeTruthy();
    expect(ko[sentence ?? ""]).toBeTruthy();
  });

  test("a code it does not know is no sentence, never the code itself", () => {
    expect(hubFactText("laf:something_else")).toBeNull();
    expect(hubFactText(null)).toBeNull();
  });

  test("the app's socket tells a hub frame from a roster patch", () => {
    expect(isHubFrame({ kind: "hub.member.changed", seq: 3 })).toBe(true);
    expect(isHubFrame({ kind: "hub.status", state: "connected" })).toBe(true);
    expect(isHubFrame({ kind: "frame_kept", channelId: "c" })).toBe(false);
    expect(isHubFrame({ channelId: "c", name: "x" })).toBe(false);
  });
});
