import { describe, expect, test } from "bun:test";
import { DEV_ACTOR } from "../src/auth/dev-actor";

/**
 * Four route modules compare against the dev actor's email through a LITERAL,
 * deliberately not an import — they must not depend on the authentication
 * module's internals. The copies drifted the day the email was renamed, and a
 * stale copy does not fail loudly: it writes the dev actor's id into a column
 * with a foreign key and silently loses the audit row. This walks the copies.
 */
const FILES_WITH_A_COPY = [
  "src/agents/routes.ts",
  "src/components/routes.ts",
  "src/computer/routes.ts",
  "src/computer/approval-routes.ts",
];

describe("the dev actor email copies", () => {
  test.each(FILES_WITH_A_COPY)("%s matches auth/dev-actor", async (file) => {
    const source = await Bun.file(
      new URL(`../${file}`, import.meta.url),
    ).text();
    const literal = source.match(/const DEV_ACTOR_EMAIL = "([^"]+)"/)?.[1];
    expect(literal).toBe(DEV_ACTOR.email);
  });
});
