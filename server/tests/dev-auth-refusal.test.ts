import { afterEach, describe, expect, test } from "bun:test";
import { devAuthEnabled } from "../src/auth/dev-actor";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * THE ONE LOCK THAT HAS TO HOLD IN PRODUCTION, AND NOTHING TESTED IT.
 *
 * `LAF_DEV_NO_AUTH=true` mounts a guard that admits everybody as a fixed administrator. It exists so
 * the product can be run on a laptop without Google credentials, and every route in the server —
 * the boundary policy, the audit trail, somebody's conversations — is behind it.
 *
 * A deployment that carried a development `.env` to a VM would then be wide open with no sign that
 * anything was wrong, so the flag REFUSES TO START rather than being ignored. Refusing to start is
 * the deliberate choice: a server believing it has authentication when it has none is worse than a
 * server that will not boot, because only one of the two gets noticed.
 *
 * The pre-rename spelling still refuses too. A `.env` that has not been updated since the rename
 * means "no auth" to the person who wrote it, and quietly enabling authentication instead of
 * refusing would be a change nobody asked for made silently.
 */

/**
 * `process.env` is the default argument of `loadConfig`, so one test reads it for real. Recorded and
 * put back per test, because bun runs every file in this workspace in one process and a leaked
 * NODE_ENV would change what an unrelated suite loads.
 */
const RESTORE: Array<[string, string | undefined]> = [];

/**
 * A production environment that is otherwise valid.
 *
 * The shared fixture's `KEY_ENCRYPTION_KEY` is `.env.example`'s, which production refuses on its own
 * — a real second lock, and one that would have made every assertion below pass for the wrong
 * reason. Replaced with a key of this file's own so the only thing left to refuse is the flag.
 */
const production = (overrides: Record<string, string> = {}) =>
  testEnvironment({
    NODE_ENV: "production",
    KEY_ENCRYPTION_KEY: "DRQbIikwNz5FTFNaYWhvdn2Ei5KZoKeutbzDytHY3+Y=",
    ...overrides,
  });

function stub(name: string, value: string | undefined) {
  RESTORE.push([name, process.env[name]]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of RESTORE.splice(0).reverse()) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("development sign-in in production", () => {
  test("refuses to start, rather than quietly ignoring the flag", () => {
    expect(() =>
      devAuthEnabled({ LAF_DEV_NO_AUTH: "true", NODE_ENV: "production" }),
    ).toThrow("Refusing to start without authentication");
  });

  test("the pre-rename spelling refuses too", () => {
    // It no longer ENABLES anything, so a deployment that still sets it has authentication on — and
    // whoever wrote that line believed the opposite. The mismatch is what has to be loud.
    expect(() =>
      devAuthEnabled({ OPENBOT_DEV_NO_AUTH: "true", NODE_ENV: "production" }),
    ).toThrow("Refusing to start without authentication");
    expect(devAuthEnabled({ OPENBOT_DEV_NO_AUTH: "true" })).toBe(false);
  });

  test("is allowed everywhere that is not production", () => {
    for (const nodeEnv of [undefined, "development", "test", "staging"]) {
      expect(
        devAuthEnabled({
          LAF_DEV_NO_AUTH: "true",
          ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
        }),
      ).toBe(true);
    }
  });

  test("production without the flag is untouched", () => {
    expect(devAuthEnabled({ NODE_ENV: "production" })).toBe(false);
    // And a value that is not the word: only "true" turns it on, so `LAF_DEV_NO_AUTH=1` is off
    // rather than on, in production as everywhere else.
    expect(
      devAuthEnabled({ LAF_DEV_NO_AUTH: "1", NODE_ENV: "production" }),
    ).toBe(false);
  });

  test("the refusal reaches boot, through the configuration the server actually loads", () => {
    // Not `devAuthEnabled` alone: what has to fail is `loadConfig`, which is the first thing
    // `index.ts` calls and the only place this check is wired in.
    expect(() => loadConfig(production({ LAF_DEV_NO_AUTH: "true" }))).toThrow(
      "Refusing to start without authentication",
    );

    // The same environment without the flag loads, so the throw above is about the flag rather than
    // about an environment that was never valid.
    expect(loadConfig(production()).devNoAuth).toBe(false);
  });

  test("and through the real process environment, which is what boot passes", () => {
    for (const [name, value] of Object.entries(
      production({ LAF_DEV_NO_AUTH: "true" }),
    )) {
      if (value !== undefined) stub(name, value);
    }

    // `loadConfig()` with no argument reads `process.env`, which is exactly how `index.ts` calls it.
    expect(() => loadConfig()).toThrow(
      "Refusing to start without authentication",
    );
  });
});
