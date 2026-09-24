import { describe, expect, test } from "bun:test";
import {
  forgetFirstMessage,
  peekFirstMessage,
  seedMessage,
  stashFirstMessage,
  transcriptMessages,
} from "../src/components/channels/transcript-messages";

/**
 * Brand-new channel transcript seeding: show the optimistic message until stored messages arrive.
 */

const SEED = seedMessage("what is our refund policy?", "seed-1");
const STORED = seedMessage("what is our refund policy?", "stored-1");

describe("transcriptMessages", () => {
  test("shows the seed while the agent has nothing", () => {
    expect(transcriptMessages([], SEED)).toEqual([SEED]);
  });

  test("shows the agent's messages once it has any, and drops the seed", () => {
    expect(transcriptMessages([STORED], SEED)).toEqual([STORED]);
  });

  test("shows nothing for an empty channel with no seed", () => {
    expect(transcriptMessages([], null)).toEqual([]);
  });

  test("is unaffected by a seed on an established channel", () => {
    expect(transcriptMessages([STORED], null)).toEqual([STORED]);
  });
});

describe("seedMessage", () => {
  test("is a user message carrying the text", () => {
    const message = seedMessage("hello", "id-1");
    expect(message).toEqual({ id: "id-1", role: "user", content: "hello" });
  });
});

describe("the first-message stash", () => {
  test("hands the message to the channel that was just created", () => {
    stashFirstMessage("channel_a", "hello");
    expect(peekFirstMessage("channel_a")).toBe("hello");
  });

  test("is still there for a render drawn again, and gone once the conversation is drawn", () => {
    // A render React threw away read it once already; the one it draws instead must find it too.
    stashFirstMessage("channel_b", "hello");
    peekFirstMessage("channel_b");
    expect(peekFirstMessage("channel_b")).toBe("hello");
    // Forgotten after the draw, so a remount cannot send it again.
    forgetFirstMessage("channel_b");
    expect(peekFirstMessage("channel_b")).toBeNull();
  });

  test("has nothing for a channel that was opened normally", () => {
    expect(peekFirstMessage("channel_never_stashed")).toBeNull();
  });

  test("keeps two channels' messages apart", () => {
    stashFirstMessage("channel_c", "for c");
    stashFirstMessage("channel_d", "for d");
    forgetFirstMessage("channel_d");
    expect(peekFirstMessage("channel_d")).toBeNull();
    expect(peekFirstMessage("channel_c")).toBe("for c");
  });
});
