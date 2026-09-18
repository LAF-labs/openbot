import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RatingScenario, RatingShown } from "./support/rating-render";

/**
 * 좋아요·아쉬워요 UNDER AN ANSWER, AS A KOREAN READER MEETS THEM.
 *
 * The server's half — who may rate what, the replace, who is told and what they are told — is
 * `server/tests/answer-ratings.integration.test.ts`. This is the screen: the controls sit under the
 * Bot's answer and nowhere else, 좋아요 is sent as nothing but itself and drawn as chosen only once
 * the server has it, 아쉬워요 asks why in a popover and sends the reason and the words, the popover
 * says the words arrived, the person can change their mind, and a rating the server already holds is
 * drawn — reason and words — when the conversation is opened again. And a deployment with no rating
 * route draws no controls at all. Rendered in a process of its own (`support/rating-render.tsx`).
 */

async function render(scenario: RatingScenario): Promise<RatingShown> {
  const directory = mkdtempSync(join(tmpdir(), "rating-render-"));
  const file = join(directory, "scenario.json");
  writeFileSync(file, JSON.stringify(scenario));
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "support/rating-render.tsx"), file],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith("RATING_RENDER "));
  if (status !== 0 || !line) {
    throw new Error(
      `the Korean render did not finish (exit ${status}):\n${stderr.slice(-3000)}`,
    );
  }
  return JSON.parse(line.slice("RATING_RENDER ".length)) as RatingShown;
}

describe("rating an answer", () => {
  test("좋아요, then 아쉬워요 with a reason and a note, then 좋아요 again — each drawn once the server has it", async () => {
    const note = "어제 매출을 알려 줬어요";
    const shown = await render({
      stored: [],
      ratingsRoute: true,
      steps: "rate",
      note,
    });

    // Under the Bot's answer, beside 복사; under the person's own question, nothing.
    expect(shown.controls).toEqual([
      { said: "오늘 매출 얼마야?", buttons: [] },
      {
        said: "오늘 매출은 1,234,000원입니다.",
        buttons: ["이 답장 복사", "좋아요", "아쉬워요"],
      },
    ]);
    expect(shown.pressedOnOpen).toEqual({ up: false, down: false });

    // What left the browser: which way, and for 아쉬워요 the reason key and the words. Nothing else.
    expect(shown.puts).toEqual([
      { rating: "up" },
      { rating: "down", reason: "wrong-facts", note },
      { rating: "up" },
    ]);
    expect(JSON.stringify(shown.puts)).not.toContain("1,234,000");

    expect(shown.upStatus).toBe("잘 받았어요. 고마워요.");
    for (const said of [
      "어떤 점이 아쉬웠나요?",
      "요청과 달라요",
      "사실과 달라요",
      "너무 느려요",
      "그 밖에",
      "여기 적은 내용만 앱을 만드는 사람들에게 가요. 답변 내용은 보내지 않아요.",
      "0/500",
      "취소",
      "보내기",
    ]) {
      expect({ said, shown: shown.popover?.includes(said) }).toEqual({
        said,
        shown: true,
      });
    }
    // A popover opened on a 좋아요 starts empty: no reason chosen, no words.
    expect(shown.prefilled).toEqual({ reasons: [], note: "" });
    // Said beside the thumbs, once the server had it, and the popover out of the way.
    expect(shown.receipt).toBe("보냈어요. 앱을 만드는 사람들에게 전달됐어요.");
    expect(shown.popoverClosed).toBe(true);
    // The person changed their mind twice, and the screen followed both times.
    expect(shown.pressedAfterDown).toEqual({ up: false, down: true });
    expect(shown.pressedAfterUpAgain).toEqual({ up: true, down: false });
  }, 120_000);

  test("a rating the server already holds is drawn again, with its reason and its words", async () => {
    const shown = await render({
      stored: [
        {
          messageId: "m-answer",
          rating: "down",
          reason: "too-slow",
          note: "오래 걸렸어요",
          updatedAt: "2026-09-18T09:00:00.000Z",
        },
      ],
      ratingsRoute: true,
      steps: "reopen",
      note: "",
    });

    expect(shown.pressedOnOpen).toEqual({ up: false, down: true });
    expect(shown.prefilled).toEqual({
      reasons: ["너무 느려요"],
      note: "오래 걸렸어요",
    });
    // "오래 걸렸어요" is seven characters, the space included.
    expect(shown.popover).toContain("7/500");
    expect(shown.puts).toEqual([]);
  }, 120_000);

  test("a deployment with no rating route draws no rating controls — 복사 stays", async () => {
    const shown = await render({
      stored: [],
      ratingsRoute: false,
      steps: "none",
      note: "",
    });

    expect(shown.controls).toEqual([
      { said: "오늘 매출 얼마야?", buttons: [] },
      { said: "오늘 매출은 1,234,000원입니다.", buttons: ["이 답장 복사"] },
    ]);
    expect(shown.puts).toEqual([]);
  }, 120_000);
});
