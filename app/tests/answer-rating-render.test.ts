import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RatingScenario, RatingShown } from "./support/rating-render";

/**
 * 좋아요·아쉬워요 FOR AN ANSWER, AS A KOREAN READER MEETS THEM.
 *
 * The server's half — who may rate what, the replace, who is told and what they are told — is
 * `server/tests/answer-ratings.integration.test.ts`. This is the screen. Under the Bot's answer
 * and nowhere else there are two controls, 복사 and 더 보기, and the two ratings are rows of the
 * menu 더 보기 opens (the owner's "proposal A", 2026-10-04: they were two of five buttons in that
 * row). What they do is what the buttons did: 좋아요 is sent as nothing but itself and drawn as
 * chosen only once the server has it, 아쉬워요 asks why in a popover and sends the reason and the
 * words, a line under the answer says the words arrived, the person can change their mind, and a
 * rating the server already holds is drawn — reason and words — when the conversation is opened
 * again. And a deployment with no rating route offers neither row. Rendered in a process of its
 * own (`support/rating-render.tsx`).
 */

/**
 * Each scenario is rendered once, in a process of its own, and a second test of the same scenario
 * reads the same render: two of the tests below hold one screen — a deployment with no rating route
 * — to different things, and rendered it twice, a second each (measured 2026-10-04). Different
 * scenarios never share a process.
 */
const renders = new Map<string, Promise<RatingShown>>();
function render(scenario: RatingScenario): Promise<RatingShown> {
  const key = JSON.stringify(scenario);
  let rendering = renders.get(key);
  if (!rendering) {
    rendering = renderAlone(scenario);
    renders.set(key, rendering);
  }
  return rendering;
}

async function renderAlone(scenario: RatingScenario): Promise<RatingShown> {
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
  test("a 좋아요 that never reached the server says so in Korean, not in the browser's words", async () => {
    const shown = await render({
      stored: [],
      ratingsRoute: true,
      steps: "offline",
      note: "",
    });
    expect(shown.offlineAlert).toBe(
      "서버에 닿지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
    // A render in a process of its own, as the three below are, and given the time they are given.
  }, 120_000);

  test("좋아요, then 아쉬워요 with a reason and a note, then 좋아요 again — each drawn once the server has it", async () => {
    const note = "어제 매출을 알려 줬어요";
    const shown = await render({
      stored: [],
      ratingsRoute: true,
      steps: "rate",
      note,
    });

    // Two controls under the Bot's answer, and no more; under the person's own question, nothing.
    expect(shown.controls).toEqual([
      { said: "오늘 매출 얼마야?", buttons: [] },
      {
        said: "오늘 매출은 1,234,000원이에요.",
        buttons: ["이 답장 복사", "더 보기"],
      },
    ]);
    // What the second one opens, in this order.
    expect(shown.menu).toEqual(["인용해 답하기", "좋아요", "아쉬워요"]);
    expect(shown.pressedOnOpen).toEqual({ up: false, down: false });

    // What left the browser: which way, and for 아쉬워요 the reason key and the words. Nothing else.
    expect(shown.puts).toEqual([
      { rating: "up" },
      { rating: "down", reason: "wrong-facts", note },
      { rating: "up" },
    ]);
    expect(JSON.stringify(shown.puts)).not.toContain("1,234,000");

    expect(shown.upStatus).toBe("잘 받았어요. 고마워요.");
    // Said beside the two controls: what a rating came to did not bring a third one back.
    expect(shown.buttonsWhileSaid).toEqual(["이 답장 복사", "더 보기"]);
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
    // Said under the answer, once the server had it, and the popover out of the way.
    expect(shown.receipt).toBe("보냈어요. 앱을 만드는 사람들에게 전달됐어요.");
    expect(shown.popoverClosed).toBe(true);
    // The row that opened it is gone with its menu: the keyboard goes back to the button that stays.
    expect(shown.popoverReturnsTo).toBe("더 보기");
    // The person changed their mind twice, and the menu's rows followed both times.
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

  test("a deployment with no rating route offers neither rating — 복사 stays, and 인용 in the menu", async () => {
    const shown = await render({
      stored: [],
      ratingsRoute: false,
      steps: "none",
      note: "",
    });

    expect(shown.controls).toEqual([
      { said: "오늘 매출 얼마야?", buttons: [] },
      {
        said: "오늘 매출은 1,234,000원이에요.",
        buttons: ["이 답장 복사", "더 보기"],
      },
    ]);
    expect(shown.menu).toEqual(["인용해 답하기"]);
    expect(shown.pressedOnOpen).toBeNull();
    expect(shown.puts).toEqual([]);
  }, 120_000);

  test("on a touch screen the row is shown and in flow; with a pointer it waits for hover or focus", async () => {
    /*
     * First-hour walk, 2026-09-27: copy and rating appeared only on hover, which a finger does not
     * have. happy-dom evaluates no media query, so this holds the classes; on a 375-wide touch
     * emulation the row measured opacity 1, position static, and intersecting no other bubble.
     */
    const shown = await render({
      stored: [],
      ratingsRoute: false,
      steps: "none",
      note: "",
    });
    expect(shown.actionsRow).toContain("pointer-coarse:opacity-100");
    expect(shown.actionsRow).toContain("pointer-coarse:static");
    expect(shown.actionsRow).toContain("opacity-0");
    expect(shown.actionsRow).toContain("group-hover/message:opacity-100");
    expect(shown.actionsRow).toContain("has-focus-visible:opacity-100");
    // And while a control in it is in use — its menu open, a rating being said — with no hover.
    expect(shown.actionsRow).toContain("has-data-[lingering=true]:opacity-100");
  }, 120_000);
});
