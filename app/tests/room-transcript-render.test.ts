import { describe, expect, test } from "bun:test";
import type { RoomDrawn } from "./support/room-transcript-render";

/**
 * A ROOM READ AS A SET OF MINUTES, AND WENT DEAD BETWEEN SPEAKERS.
 *
 * Two things were missing from the one screen where knowing who is talking is the whole point.
 * Every Bot's bubble is identical — same shape, same colour — and the only thing separating one
 * colleague from another was a 12px grey name, so three Bots answering read as a transcript with
 * the speaker typed above each paragraph. And the transcript's thinking line is drawn only while
 * the last thing in the conversation is the person's own message, which in a room is true exactly
 * once: before the first reply. Every member after that thought, waited for its Bot's lane and did
 * whatever work it chose — up to five minutes — with nothing at all on the screen.
 *
 * Drawn in a process of its own (`support/room-transcript-render.tsx`) because the locale is
 * decided when the dictionary is first loaded, and by then the shared runner has chosen English.
 */

async function drawn(): Promise<RoomDrawn> {
  const child = Bun.spawn(
    ["bun", `${import.meta.dir}/support/room-transcript-render.tsx`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("ROOM_RENDER "));
  if (status !== 0 || !line) {
    throw new Error(
      `the room transcript did not draw (exit ${status}):\n${stderr.slice(-3000)}`,
    );
  }
  return JSON.parse(line.slice("ROOM_RENDER ".length)) as RoomDrawn;
}

describe("a room's transcript", () => {
  test("every colleague's turn opens with its own face and name, and a run keeps one", async () => {
    const room = await drawn();

    expect(room.turns).toEqual([
      // The person's own message carries neither: their side of a room is not a colleague's turn.
      { said: null, face: false, text: "지난주 어땠어?" },
      { said: "매출봇", face: true, text: "매출은 12% 올랐어요." },
      // The same Bot's second sentence continues the run: one face and one name per turn, not per
      // bubble. Joining two DIFFERENT colleagues would put one's words under the other's name.
      { said: null, face: false, text: "객단가도 조금 올랐고요." },
      { said: "리뷰봇", face: true, text: "리뷰는 4.5점이었습니다." },
    ]);
  });

  test("the colleague that has the floor is named while it works, and a reader hears it", async () => {
    const room = await drawn();

    // Who, not just that somebody: in a room of six that is the fact worth having.
    expect(room.workingLine).toContain("재고봇");
    expect(room.workingLine).toContain("생각 중");
    expect(room.workingFace).toBe(true);
    // Said in the region that was mounted before it spoke, so it is actually announced.
    expect(room.announced).toBe("재고봇 생각 중");
  });

  test("with nobody holding the floor the plain line is what is drawn", async () => {
    // A conversation with one Bot reaches this too, and must not grow a name it does not have.
    expect((await drawn()).firstWaitLine).toBe("생각 중");
  });
});
