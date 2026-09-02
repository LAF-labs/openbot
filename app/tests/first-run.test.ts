import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { authKeys, currentUserQueryOptions } from "../src/lib/auth/queries";

/**
 * THE FIRST BOT IS MADE AND THE SCREEN DOES NOT MOVE.
 *
 * Measured by walking onboarding in a browser: the Bot was created, `onboarded_at` was stamped, and
 * the welcome form stayed on screen with the person's own words still in it — and pressing 시작하기
 * again did nothing at all, because the double-submit guard had already latched. A dead button on
 * the first screen anybody sees.
 *
 * Neither half was wrong on its own. `welcome.tsx` invalidated the current-user query; nothing on
 * that screen OBSERVES it, and `invalidateQueries` refetches active queries only — so the entry was
 * marked stale and left alone. `_authed`'s guard then read it with `ensureQueryData`, which serves
 * cached data rather than revalidating, saw `onboarded: false`, and redirected the navigation
 * straight back to `/welcome`.
 *
 * This is the shape of that, in the two calls that matter. It is deliberately about the CACHE and
 * not about the component: what has to hold is that after onboarding the guard's next read reports
 * a person who is through the door, however the screen arranges to make that true.
 */

type Onboarding = { onboarded: boolean };

function seeded(answers: Onboarding[]) {
  let index = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const options = {
    ...currentUserQueryOptions(),
    queryFn: async () => {
      const answer = answers[Math.min(index, answers.length - 1)] as Onboarding;
      index += 1;
      return {
        id: "someone",
        email: "someone@example.com",
        role: "user" as const,
        onboarded: answer.onboarded,
        deployment: { effort: true, autoReview: true },
      };
    },
  };
  return { client, options, asked: () => index };
}

describe("the first run", () => {
  test("invalidating alone leaves the guard reading the old answer", async () => {
    // The bug, pinned so the fix below is not mistaken for a coincidence. No component observes the
    // current user on the welcome screen, and this is what that costs.
    const { client, options } = seeded([
      { onboarded: false },
      { onboarded: true },
    ]);
    await client.ensureQueryData(options);
    await client.invalidateQueries({ queryKey: authKeys.currentUser() });

    // `toMatchObject`, because the query's declared answer is a union that includes null and
    // "unreachable"; `.onboarded` is not a property of all of it.
    expect(await client.ensureQueryData(options)).toMatchObject({
      onboarded: false,
    });
  });

  test("refetching every copy is what the guard then reads", async () => {
    const { client, options } = seeded([
      { onboarded: false },
      { onboarded: true },
    ]);
    await client.ensureQueryData(options);
    await client.refetchQueries({
      queryKey: authKeys.currentUser(),
      type: "all",
    });

    expect(await client.ensureQueryData(options)).toMatchObject({
      onboarded: true,
    });
  });

  test("the welcome screen is the one doing it", async () => {
    // Cheap, and it is what connects the two tests above to the code they are about: a future edit
    // that puts `invalidateQueries` back here is the bug returning.
    const source = await Bun.file(
      new URL("../src/routes/_authed/welcome.tsx", import.meta.url),
    ).text();
    expect(source).toContain("refetchQueries");
    expect(source).toContain('type: "all"');
  });
});
