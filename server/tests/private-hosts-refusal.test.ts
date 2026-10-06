import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * THE SWITCH THAT SAYS "A DEVELOPER'S STACK" IS REFUSED IN PRODUCTION, AND UNTIL NOW IT WAS ONLY READ.
 *
 * `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` lets this server reach addresses inside its own network,
 * which a laptop needs. Since 2026-10-06 it decides more: where it is set, a Bot may be pointed at
 * an agent somebody hosts themselves, each Bot is dialled where its row says with the key stored
 * for it, and the page for all of that is drawn. Whatever such an agent says is filed as this
 * deployment's fact — what a turn cost, how a run ended.
 *
 * The one thing keeping that off a deployment was that compose never hands the server the variable
 * (`configuration-documents.test.ts` holds that). An API started any other way with the line —
 * a development `.env` carried to a VM, an override somebody wrote — took endpoints, private ones
 * too, with nothing saying so. Its two neighbours already refuse to start that way:
 * `LAF_DEV_NO_AUTH` (`dev-auth-refusal.test.ts`) and `LAF_CLOCK_OFFSET_MS`. This is the third, by
 * the same rule and for the same reason: a server that believes it is hosted when it is not is
 * worse than one that will not boot, because only one of the two gets noticed.
 *
 * `agent-computer` reads the same variable for its own floor and is no part of this: compose does
 * hand it that one, and its own guards are what they were.
 */

/**
 * A production environment that is otherwise valid, as `dev-auth-refusal.test.ts` builds one: the
 * shared fixture's vault key is `.env.example`'s, which production refuses on its own, so every
 * assertion below would pass for the wrong reason without a key of this file's own.
 */
const TOKEN_KEY =
  "5c1e8a3f7b2d4e6a9c0b1d3f5e7a9c2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c";
const production = (overrides: Record<string, string> = {}) =>
  testEnvironment({
    NODE_ENV: "production",
    KEY_ENCRYPTION_KEY: "DRQbIikwNz5FTFNaYWhvdn2Ei5KZoKeutbzDytHY3+Y=",
    LAF_TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
    SIGN_IN_ALLOWED_EMAILS: "owner@laf.test",
    ...overrides,
  });

const COMPUTER = { AGENT_COMPUTER_URL: "http://agent-computer:4100" };
const OPT_IN = { AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true" };
const REFUSAL =
  "AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true cannot be used with NODE_ENV=production";

describe("the private-host opt-in in production", () => {
  test("refuses to start, by name, rather than quietly being a developer's stack", () => {
    expect(() => loadConfig(production({ ...COMPUTER, ...OPT_IN }))).toThrow(
      REFUSAL,
    );
    // The same environment without the line loads, so the throw is about the line — and what
    // loads is hosted in the one sense that decides where a Bot runs.
    expect(loadConfig(production(COMPUTER)).computer?.allowPrivateHosts).toBe(
      false,
    );
  });

  test("refuses with no computer configured too, where the line opens nothing yet", () => {
    // It is read under the computer's configuration, so alone it does nothing — until the day
    // somebody adds the computer's address. The line is what has to be loud, like the pre-rename
    // spelling of the sign-in switch, which enables nothing and still refuses.
    expect(() => loadConfig(production(OPT_IN))).toThrow(REFUSAL);
    expect(loadConfig(production()).computer).toBeUndefined();
  });

  test("is allowed everywhere that is not production", () => {
    for (const nodeEnv of [undefined, "development", "test", "staging"]) {
      const config = loadConfig(
        testEnvironment({
          ...COMPUTER,
          ...OPT_IN,
          // Every environment but a test run carries one (`config.test.ts`).
          LAF_TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
          ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
        }),
      );
      expect(config.computer?.allowPrivateHosts).toBe(true);
    }
  });

  test("only the word turns it on, so only the word is refused", () => {
    // `=1` and `=TRUE` are off, in production as on a laptop: there is nothing there to refuse.
    for (const word of ["false", "1", "TRUE", "yes", ""]) {
      const config = loadConfig(
        production({ ...COMPUTER, AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: word }),
      );
      expect(config.computer?.allowPrivateHosts).toBe(false);
    }
    // And the word with space around it is the word, as every variable here is read.
    expect(() =>
      loadConfig(
        production({
          ...COMPUTER,
          AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: " true ",
        }),
      ),
    ).toThrow(REFUSAL);
  });
});
