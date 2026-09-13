import { describe, expect, test } from "bun:test";
import {
  COWORKER_REFUSALS,
  coworkerRefusalForModel,
} from "../src/lib/copilot/coworker-refusals";
import { ko } from "../src/lib/i18n-ko";

/**
 * Asking a coworker, refused: the person's line and the asking Bot's instruction.
 *
 * The route used to answer with the sentence the server wrote for the model, and this tool printed
 * it on the person's transcript line — English, and for a coworker that failed, the provider's own
 * words (audit A1-3). The server sends codes and numbers now, and both readers' words live on the
 * surface, so both are walked here against the codes the server can actually send.
 */
async function serverCodes(): Promise<string[]> {
  const call = await Bun.file(
    new URL("../../server/src/agents/coworker-call.ts", import.meta.url),
  ).text();
  return [
    ...new Set(
      [...call.matchAll(/"(laf:[a-z_]+)"/g)].map((match) => match[1] as string),
    ),
  ];
}

describe("the coworker refusal copy", () => {
  test("every code the coworker call can refuse with has words for the person, in Korean", async () => {
    const codes = await serverCodes();
    expect(codes.length).toBeGreaterThan(4);
    expect(codes.filter((code) => !(code in COWORKER_REFUSALS))).toEqual([]);
    expect(
      Object.values(COWORKER_REFUSALS).filter((sentence) => !(sentence in ko)),
    ).toEqual([]);
  });

  test("the asking Bot is told what to do, never handed the code", async () => {
    for (const code of await serverCodes()) {
      const told = coworkerRefusalForModel(code, { length: 9120, limit: 8000 });
      expect({ code, told }).not.toEqual({
        code,
        told: expect.stringContaining("laf:"),
      });
    }
    // The numbers ride beside the code, and reach the sentence.
    expect(
      coworkerRefusalForModel("laf:coworker_question_too_long", {
        length: 9120,
        limit: 8000,
      }),
    ).toContain("9,120 characters, and a coworker takes at most 8,000");
  });
});
