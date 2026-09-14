import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  ENVIRONMENT,
  TENANT_PACKAGE_VARIABLES,
  type VariableName,
  type VariableSource,
} from "../src/config";

/**
 * The three documents a deployment is stood up from, held to the one list of what the server reads.
 *
 * An operator copies `.env.example`, reads the table in `docs/laf/deploying.md`, and runs a compose
 * file that decides what reaches the container. Each was written by hand beside `config.ts`, and
 * each had drifted from it in the way that costs most: compose's own comment records four settings
 * the server read and compose never passed — "settings that exist on a laptop and nowhere else". So
 * every variable `ENVIRONMENT` declares is checked against all three, in the direction that matters
 * for each.
 */

const root = join(import.meta.dir, "../..");
const declared = Object.entries(ENVIRONMENT) as [
  VariableName,
  VariableSource,
][];
const named = (...sources: VariableSource[]) =>
  declared
    .filter(([, source]) => sources.includes(source))
    .map(([name]) => name)
    .sort();

describe(".env.example", () => {
  const example = readFileSync(join(root, ".env.example"), "utf8");
  /** Every name the file offers, set or commented out: `NAME=` or `# NAME=` at the start of a line. */
  const offered = new Set(
    example
      .split("\n")
      .map((line) => line.match(/^#?\s*([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((name): name is string => Boolean(name)),
  );

  test("lists every variable the server reads, set or commented out", () => {
    const missing = named("operator", "compose", "development").filter(
      (name) => !offered.has(name),
    );
    // Add the variable to .env.example, with what it does and what happens when it is wrong.
    expect(missing).toEqual([]);
  });

  test("does not offer a retired spelling as something to set", () => {
    // A retired name is read only to refuse it. Listing it would invite the setting it refuses.
    expect(named("retired").filter((name) => offered.has(name))).toEqual([]);
  });
});

describe("the deploying guide's table", () => {
  const guide = readFileSync(join(root, "docs/laf/deploying.md"), "utf8");
  const marker = guide.indexOf("server/tests/configuration-documents.test.ts");

  /**
   * The names in the first column of the table after the marker. `<PROVIDER>` is how the table writes
   * one pair for every direct provider, so it stands for each declared name it matches.
   */
  const inTable = () => {
    const lines = guide.slice(marker).split("\n");
    const start = lines.findIndex((line) => line.startsWith("|"));
    const end = lines.findIndex(
      (line, index) => index > start && !line.startsWith("|"),
    );
    const names = new Set<string>();
    for (const row of lines.slice(start, end)) {
      const firstColumn = row.split("|")[1] ?? "";
      for (const [, token = ""] of firstColumn.matchAll(/`([^`]+)`/g)) {
        if (!token.includes("<PROVIDER>")) {
          names.add(token);
          continue;
        }
        const pattern = new RegExp(
          `^${token.replace("<PROVIDER>", "[A-Z]+")}$`,
        );
        for (const [name] of declared) {
          if (pattern.test(name)) names.add(name);
        }
      }
    }
    return [...names].sort();
  };

  test("is found where the marker says", () => {
    expect(marker).toBeGreaterThan(0);
    expect(inTable().length).toBeGreaterThan(0);
  });

  test('names exactly the variables config.ts marks "operator"', () => {
    // A variable with no usable default that the table does not name is one an operator finds out
    // about from a refusal; a name in the table the server does not read is advice about nothing.
    expect(inTable()).toEqual(named("operator"));
  });
});

describe("the compose file", () => {
  const compose = parseYaml(
    readFileSync(join(root, "docker-compose.yml"), "utf8"),
  ) as { services: { server: { environment: Record<string, unknown> } } };
  const passed = new Set(Object.keys(compose.services.server.environment));

  test("hands the server every variable a deployment can set", () => {
    // Not passed, a setting exists on a laptop and nowhere else: on a VM it is permanently the
    // built-in default, whatever the operator's .env says.
    expect(
      named("operator", "compose").filter((name) => !passed.has(name)),
    ).toEqual([]);
  });

  test("never hands it one that belongs only to development", () => {
    // PORT is what Caddy and the healthcheck expect; LAF_DEV_NO_AUTH and
    // AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS would make a VM unsafe on the strength of one line.
    expect(named("development").filter((name) => passed.has(name))).toEqual([]);
  });
});

describe("the tenant package", () => {
  test("names only the variables config.ts hands it", () => {
    const directory = join(root, "tenant/laf");
    const referenced = new Set<string>();
    for (const file of readdirSync(directory)) {
      const text = readFileSync(join(directory, file), "utf8");
      for (const [, name] of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (name) referenced.add(name);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    // A package file that names a variable config.ts does not declare fails at boot with "is not
    // set in this environment" however it is set. Declare it in ENVIRONMENT and
    // TENANT_PACKAGE_VARIABLES.
    expect([...referenced].sort()).toEqual(
      [...TENANT_PACKAGE_VARIABLES].sort(),
    );
  });
});
