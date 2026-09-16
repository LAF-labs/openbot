import { afterEach, describe, expect, test } from "bun:test";
import { createSignInAllowlist } from "../src/auth/allowlist";
import { loadConfig } from "../src/config";
import { recentLines } from "../src/log";
import { testEnvironment } from "./support/environment";

/**
 * ONE ACCOUNT PER DEPLOYMENT, AT BOOT.
 *
 * The owner's decision (2026-09-16): "1계정 1VM을 코드로 강제한다." Until it, the only thing between a
 * VM and a second person was `SIGN_IN_ALLOWED_EMAILS`, and it failed open — unset, anybody the
 * provider authenticated got an account (audit 2026-09-16 R9-04), and set, it admitted a list (R1-01).
 * Since every Bot on a deployment shares one browser profile (`bc5bf3e`), a second account's Bots
 * browse inside the first person's logins. So a production deployment refuses to start unless the two
 * sign-in lines, together, name exactly one address — and that one address closes the door even when
 * it is only written as the administrator.
 *
 * Outside production the door may stay open, because a laptop and the test suites are not somebody's
 * shop — and the boot says so out loud.
 */

/**
 * A production environment that is otherwise valid.
 *
 * The shared fixture's keys are `.env.example`'s, which production refuses for reasons of their own;
 * replaced here so the only thing left to refuse is the sign-in list (the same care
 * `dev-auth-refusal.test.ts` takes).
 */
const production = (overrides: Record<string, string | undefined> = {}) =>
  testEnvironment({
    NODE_ENV: "production",
    KEY_ENCRYPTION_KEY: "DRQbIikwNz5FTFNaYWhvdn2Ei5KZoKeutbzDytHY3+Y=",
    LAF_TOKEN_ENCRYPTION_KEY:
      "5c1e8a3f7b2d4e6a9c0b1d3f5e7a9c2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c",
    ...overrides,
  });

const RESTORE: Array<[string, string | undefined]> = [];

/** `loadConfig()` with no argument reads `process.env`; put every name back after each test. */
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

/** How many times the boot has said the door is open, in this process's log tail. */
const openDoorLines = () =>
  recentLines
    .lines()
    .filter((line) => line.includes('"event":"sign_in_door_open"')).length;

describe("a production deployment names the one account it belongs to", () => {
  test("refuses to start with no address at all: the door would be open", () => {
    expect(() => loadConfig(production())).toThrow(
      "must name the one account it belongs to",
    );
    // Blank entries are no address, on either line.
    expect(() =>
      loadConfig(
        production({
          SIGN_IN_ALLOWED_EMAILS: " , ",
          INITIAL_ADMIN_EMAILS: ",",
        }),
      ),
    ).toThrow("must name the one account it belongs to");
  });

  test("refuses to start with two, on one line or across both", () => {
    for (const lines of [
      { SIGN_IN_ALLOWED_EMAILS: "owner@laf.test,staff@laf.test" },
      {
        SIGN_IN_ALLOWED_EMAILS: "owner@laf.test",
        INITIAL_ADMIN_EMAILS: "someone-else@laf.test",
      },
      { INITIAL_ADMIN_EMAILS: "owner@laf.test, partner@laf.test" },
    ]) {
      expect(() => loadConfig(production(lines))).toThrow(
        "belongs to exactly one account",
      );
    }
  });

  test("the refusal says how many, never who", () => {
    let said = "";
    try {
      loadConfig(
        production({
          SIGN_IN_ALLOWED_EMAILS: "owner@laf.test,staff@laf.test",
        }),
      );
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    // A boot refusal lands in the operator's log; the addresses stay in `.env`.
    expect(said).toContain("2 addresses");
    expect(said).not.toContain("owner@laf.test");
    expect(said).not.toContain("staff@laf.test");
  });

  test("starts with one, however the two lines spell it", () => {
    for (const lines of [
      { SIGN_IN_ALLOWED_EMAILS: "owner@laf.test" },
      { INITIAL_ADMIN_EMAILS: "owner@laf.test" },
      // The fleet writes the owner on both lines; that is one address, not two.
      {
        SIGN_IN_ALLOWED_EMAILS: "owner@laf.test",
        INITIAL_ADMIN_EMAILS: "owner@laf.test",
      },
      // Compared the way the sign-in list compares: trimmed and case-insensitive, nothing more.
      {
        SIGN_IN_ALLOWED_EMAILS: " Owner@LAF.test ,",
        INITIAL_ADMIN_EMAILS: "owner@laf.test",
      },
    ]) {
      const config = loadConfig(production(lines));
      expect(config.auth?.allowlistEnforced).toBe(true);
    }
  });

  test("the one address closes the door even when only INITIAL_ADMIN_EMAILS names it", () => {
    const config = loadConfig(
      production({ INITIAL_ADMIN_EMAILS: "owner@laf.test" }),
    );
    if (!config.auth) throw new Error("the fixture has sign-in");
    const door = createSignInAllowlist(config.auth);

    expect(door.enforced).toBe(true);
    expect(door.admits("owner@laf.test")).toBe(true);
    expect(door.admits(" OWNER@laf.test")).toBe(true);
    expect(door.admits("stranger@laf.test")).toBe(false);
  });

  test("a production deployment with no sign-in configured has no door to hold open", () => {
    // What the fleet provisions before a domain exists: no provider, so no account can be made and
    // the list is not read. `config.test.ts` boots exactly this shape in production.
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
      KEY_ENCRYPTION_KEY: "DRQbIikwNz5FTFNaYWhvdn2Ei5KZoKeutbzDytHY3+Y=",
      LAF_TOKEN_ENCRYPTION_KEY:
        "5c1e8a3f7b2d4e6a9c0b1d3f5e7a9c2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c",
      MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    });
    expect(config.auth).toBeUndefined();
  });

  test("and through the process environment, which is what boot passes", () => {
    for (const [name, value] of Object.entries(
      production({ SIGN_IN_ALLOWED_EMAILS: "owner@laf.test,staff@laf.test" }),
    )) {
      if (value !== undefined) stub(name, value);
    }
    stub("INITIAL_ADMIN_EMAILS", undefined);

    expect(() => loadConfig()).toThrow("belongs to exactly one account");
  });
});

describe("outside production", () => {
  test("the door may stay open, and the boot says so", () => {
    const before = openDoorLines();
    const config = loadConfig(testEnvironment());
    if (!config.auth) throw new Error("the fixture has sign-in");

    expect(config.auth.allowlistEnforced).toBe(false);
    expect(createSignInAllowlist(config.auth).admits("anybody@laf.test")).toBe(
      true,
    );
    expect(openDoorLines()).toBe(before + 1);
  });

  test("a list is a closed door, and nothing is said about it", () => {
    const before = openDoorLines();
    const config = loadConfig(
      testEnvironment({ SIGN_IN_ALLOWED_EMAILS: "owner@laf.test" }),
    );
    expect(config.auth?.allowlistEnforced).toBe(true);
    expect(openDoorLines()).toBe(before);
  });

  test("more than one address still loads, for the suites that model leftover accounts", () => {
    // Whether a SECOND ACCOUNT can be made is decided at sign-in, in every environment
    // (`one-account-sign-in.integration.test.ts`); only the boot refusal is production's.
    const config = loadConfig(
      testEnvironment({
        SIGN_IN_ALLOWED_EMAILS: "owner@laf.test,staff@laf.test",
      }),
    );
    expect(config.auth?.allowedEmails).toEqual([
      "owner@laf.test",
      "staff@laf.test",
    ]);
  });
});
