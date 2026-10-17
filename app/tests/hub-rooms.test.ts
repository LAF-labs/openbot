import { describe, expect, test } from "bun:test";
import { roomConversationId } from "@shared/hub/room-answers";
import type { ChannelSummary } from "../src/lib/channels/queries";
import {
  lafiWorkingLines,
  roomAuthorName,
  roomConversationName,
  roomConversationOf,
} from "../src/lib/hub/rooms";
import { ko } from "../src/lib/i18n-ko";

/**
 * A team room's words for whose 라피 is answering and who wrote what (`lib/hub/rooms.ts`): the rules
 * are shared with the VM that answers, the words are the surface's.
 */

const NOW = new Date("2026-10-16T09:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const names: Record<string, string> = { m_kim: "김민지", m_park: "박서준" };
const nameOf = (member: string) => names[member];

describe("whose 라피 is looking into it", () => {
  test("one line per member asking, by name, until their 라피 answers", () => {
    const lines = [
      { seq: 1, by: "m:m_kim", mentions: ["lafi"], at: ago(4_000) },
      { seq: 2, by: "m:m_park", mentions: ["lafi"], at: ago(3_000) },
      { seq: 3, by: "bot:m_park", mentions: [], at: ago(1_000) },
      { seq: 4, by: "m:m_lee", mentions: ["lafi"], at: ago(500) },
    ];
    expect(lafiWorkingLines(lines, NOW, nameOf)).toEqual([
      "김민지's Lafi is looking into it",
      "A teammate's Lafi is looking into it",
    ]);
    expect(lafiWorkingLines(lines.slice(1, 3), NOW, nameOf)).toEqual([]);
  });

  test("says it in Korean", () => {
    expect(ko["{name}'s Lafi is looking into it"]).toBe(
      "{name}의 라피가 알아보는 중",
    );
    expect(ko["{name}'s Lafi"]).toBe("{name}의 라피");
  });
});

describe("who wrote a room's message", () => {
  test("a person by name, their 라피 as theirs", () => {
    expect(roomAuthorName("m:m_kim", nameOf)).toBe("김민지");
    expect(roomAuthorName("bot:m_kim", nameOf)).toBe("김민지's Lafi");
    expect(roomAuthorName("bot:m_nobody", nameOf)).toBe("A teammate's Lafi");
    expect(roomAuthorName("job:j_1", nameOf)).toBe("A teammate");
  });
});

describe("the room's conversation in the app", () => {
  const channel = (
    id: string,
    kind: "main" | "project" | "room",
  ): ChannelSummary => ({
    id,
    name: "영업팀",
    agentIds: ["agent_1"],
    threadId: `t-${id}`,
    active: true,
    kind,
    lastMessage: null,
    lastMessageAt: null,
    lastMessageAgentId: null,
    unread: false,
    createdAt: NOW.toISOString(),
  });

  test("is found by the room and the Bot, once the 라피 has answered there", () => {
    const id = roomConversationId("r_1", "agent_1");
    const list = [channel("channel_main", "main"), channel(id, "room")];
    expect(roomConversationOf("r_1", "agent_1", list)?.id).toBe(id);
    expect(roomConversationOf("r_2", "agent_1", list)).toBeUndefined();
    expect(roomConversationOf("r_1", "agent_2", list)).toBeUndefined();
    // Only a conversation that says it is a room's.
    expect(
      roomConversationOf("r_1", "agent_1", [channel(id, "project")]),
    ).toBeUndefined();
  });

  test("is called by its room", () => {
    expect(roomConversationName({ name: "영업팀" })).toBe("Team room · 영업팀");
    expect(roomConversationName({ name: " " })).toBe("Team room · A team room");
    expect(ko["Team room · {name}"]).toBe("단체방 · {name}");
  });
});
