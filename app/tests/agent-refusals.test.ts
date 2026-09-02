import { describe, expect, test } from "bun:test";
import { AGENT_REFUSALS } from "../src/lib/agents/mutations";
import { ko } from "../src/lib/i18n-ko";

/**
 * The agents API's refusals, which the roster and the new-Bot form render straight into the screen.
 *
 * The sixth Bot was refused with the server's own sentence — "This account's computer seats five
 * Bots, and all five seats are taken." — English, in a Korean product, with the number written into
 * the prose while `BOT_SEATS_PER_ACCOUNT` is a setting a deployment can change. The server sends a
 * fact code and the seat count now and this table owns the words, which puts `t()` on a variable and
 * so out of `i18n-coverage.test.ts`'s sight; the table is checked in and finite, so it is walked.
 */
describe("the agents refusal copy", () => {
  test("every refusal in the table has Korean", () => {
    const missing = Object.values(AGENT_REFUSALS).filter(
      (sentence) => !(sentence in ko),
    );
    expect(missing).toEqual([]);
  });

  test("the table names every code the server can send", async () => {
    /*
     * The server is the source of truth for WHICH codes exist. Read out of its source rather than
     * copied, so a code added there fails here until somebody decides what it says in Korean — the
     * failure mode being a refusal that falls through to the server's English sentence, which is
     * exactly what this pair was written to end.
     */
    const store = await Bun.file(
      new URL("../../server/src/agents/profile-store.ts", import.meta.url),
    ).text();
    const routes = await Bun.file(
      new URL("../../server/src/agents/routes.ts", import.meta.url),
    ).text();
    const codes = new Set(
      [...`${store}${routes}`.matchAll(/"(laf:[a-z_]+)"/g)].map(
        (match) => match[1] as string,
      ),
    );

    expect(codes.size).toBeGreaterThan(0);
    expect([...codes].sort()).toEqual(Object.keys(AGENT_REFUSALS).sort());
  });

  test("the seat count reaches the sentence", () => {
    // The whole point of the code: the number comes from the deployment, not from the prose. A
    // template that lost its placeholder would render "이 계정의 봇 자리 개가 모두 찼습니다".
    const sentence = AGENT_REFUSALS["laf:seats_full"] as string;
    expect(sentence).toContain("{seats}");
    expect(ko[sentence]).toContain("{seats}");
  });
});
