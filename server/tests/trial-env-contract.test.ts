import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ENVIRONMENT, loadConfig, TRIAL_VARIABLES } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * The trial's names, identical in the three places a deployment is stood up from.
 *
 * The fleet writes these four into a VM's `.env` and pushes them again later (self-serve contract
 * §4.5), so the names are a wire contract with another repository, not a private spelling. And a
 * name compose does not hand the server is the scar the compose file itself records: a push that
 * restarts nothing, a setting that exists on a laptop and nowhere else. So the set is read out of
 * `config.ts`, `docker-compose.yml` and `.env.example` and required to be one set.
 */

const root = join(import.meta.dir, "../..");

/** The contract's table, in its order. Changing a name here is changing laf-control too. */
const CONTRACT = [
  "LAF_PLAN",
  "LAF_TRIAL_ENDS_AT",
  "LAF_TRIAL_HOLD_DAYS",
  "LAF_DAILY_TOKEN_BUDGET",
];

/** Anything that looks like a trial's line, so an extra or a misspelt one is caught too. */
const TRIAL_SHAPED = /^(LAF_PLAN|LAF_TRIAL_[A-Z0-9_]+|LAF_DAILY_[A-Z0-9_]+)$/;

const compose = parseYaml(
  readFileSync(join(root, "docker-compose.yml"), "utf8"),
) as { services: { server: { environment: Record<string, unknown> } } };
const passed = compose.services.server.environment;

const example = readFileSync(join(root, ".env.example"), "utf8");
/** `NAME=value` or `# NAME=value`, first spelling wins. */
const offered = new Map<string, string>();
for (const line of example.split("\n")) {
  const found = line.match(/^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/);
  if (found?.[1] && !offered.has(found[1])) {
    offered.set(found[1], (found[2] ?? "").trim());
  }
}

describe("the trial's four names", () => {
  test("config.ts declares exactly the contract's, as values compose passes through", () => {
    expect<string[]>([...TRIAL_VARIABLES]).toEqual(CONTRACT);
    for (const name of CONTRACT) {
      expect([name, ENVIRONMENT[name as keyof typeof ENVIRONMENT]]).toEqual([
        name,
        "compose",
      ]);
    }
  });

  test("compose hands the server every one of them, unset as empty", () => {
    for (const name of CONTRACT) {
      expect([name, passed[name]]).toEqual([name, `\${${name}:-}`]);
    }
  });

  test("the three places name one set and nothing beside it", () => {
    const inCompose = Object.keys(passed)
      .filter((name) => TRIAL_SHAPED.test(name))
      .sort();
    const inExample = [...offered.keys()]
      .filter((name) => TRIAL_SHAPED.test(name))
      .sort();
    const inConfig = Object.keys(ENVIRONMENT)
      .filter((name) => TRIAL_SHAPED.test(name))
      .sort();
    const contract = [...CONTRACT].sort();
    expect({ inCompose, inExample, inConfig }).toEqual({
      inCompose: contract,
      inExample: contract,
      inConfig: contract,
    });
  });

  test("the values .env.example shows are a trial the server accepts", () => {
    // An example an operator copies and the server then refuses is an example that lies.
    const values = Object.fromEntries(
      CONTRACT.map((name) => [name, offered.get(name) ?? ""]),
    );
    expect(loadConfig(testEnvironment(values)).trial).toEqual({
      endsAt: values.LAF_TRIAL_ENDS_AT ?? "",
      holdDays: Number(values.LAF_TRIAL_HOLD_DAYS),
      dailyTokenBudget: Number(values.LAF_DAILY_TOKEN_BUDGET),
    });
  });
});
