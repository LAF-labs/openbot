import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { deploymentPackages } from "../src/db/schema";
import {
  createApplicationConfiguration,
  expandEnvironment,
  type LoadedTenantPackage,
  loadTenantPackage,
  recordTenantPackage,
  validateTenantPackage,
  validateThemeCss,
} from "../src/tenant-package";
import { TEST_POOL } from "./support/database";

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);
const createdTenantIds: string[] = [];

afterEach(async () => {
  for (const tenantId of createdTenantIds.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.tenantId, tenantId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function loadedPackage(): LoadedTenantPackage {
  const tenantId = randomUUID();
  createdTenantIds.push(tenantId);
  return {
    tenantId,
    productName: "Package Test",
    stylesheet: null,
    model: {
      provider: "openai",
      credentialSecretRef: "openai-key",
      defaultModel: "gpt-4.1",
      supportsEffort: true,
      reviewModel: "gpt-4.1",
    },
    themeCss: "",
    sourcePath: `/test/${randomUUID()}`,
    checksum: randomUUID(),
  };
}

describe("tenant theme validation", () => {
  test("accepts approved variables in root and dark blocks", () => {
    expect(() =>
      validateThemeCss(`
        :root { --primary: oklch(0.32 0.09 250); }
        .dark { --primary: oklch(0.87 0.03 250); }
      `),
    ).not.toThrow();
  });

  test("rejects imports, selectors, and unsupported variables", () => {
    expect(() =>
      validateThemeCss('@import "https://example.com/theme.css";'),
    ).toThrow("must not contain imports or URLs");
    expect(() => validateThemeCss("body { color: red; }")).toThrow(
      "only define :root and .dark blocks",
    );
    expect(() => validateThemeCss(":root { --made-up: red; }")).toThrow(
      "is not an approved theme variable",
    );
  });
});

describe("tenant YAML validation", () => {
  const packageWithModel = (model: string) =>
    validateTenantPackage({
      brand: "tenant: { id: fintech, product_name: Ledgerline }",
      model,
      themeCss: "",
    });

  /**
   * Whether the deployment's model takes an effort setting.
   *
   * Declared rather than guessed from a model's name, and the values arrive as STRINGS: these come
   * out of YAML with environment substitution in them, so `${BOT_MODEL_EFFORT:-true}` is the string
   * "true" however the variable is set. A parser that only took real booleans would read every
   * deployment's declaration as malformed.
   */
  test("reads effort support as a string or a boolean, and defaults to yes", () => {
    const base =
      "provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1";
    expect(packageWithModel(`model: { ${base} }`).model.supportsEffort).toBe(
      true,
    );
    expect(
      packageWithModel(`model: { ${base}, supports_effort: false }`).model
        .supportsEffort,
    ).toBe(false);
    expect(
      packageWithModel(`model: { ${base}, supports_effort: "false" }`).model
        .supportsEffort,
    ).toBe(false);
    expect(
      packageWithModel(`model: { ${base}, supports_effort: "true" }`).model
        .supportsEffort,
    ).toBe(true);
  });

  test("the review model is its own, and falls back to the main one", () => {
    const base =
      "provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1";
    // Deciding whether one action is read-only is a classification. Measured against this
    // deployment's own reasoning model it took ten to thirty seconds, which is a Bot standing still
    // for longer than a person often takes to press the button.
    expect(
      packageWithModel(`model: { ${base}, review_model: tiny-1 }`).model
        .reviewModel,
    ).toBe("tiny-1");
    // `${REVIEW_MODEL:-}` with nothing set is the empty string, not an absent key, so both have to
    // fall back rather than one of them failing.
    expect(packageWithModel(`model: { ${base} }`).model.reviewModel).toBe(
      "gpt-4.1",
    );
    expect(
      packageWithModel(`model: { ${base}, review_model: "" }`).model
        .reviewModel,
    ).toBe("gpt-4.1");
  });

  test("refuses an effort declaration that is neither", () => {
    // Not read as truthy. "maybe" almost certainly means an environment variable that did not
    // resolve, and reading it as yes would send the parameter to a model that cannot take it.
    expect(() =>
      packageWithModel(
        "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1, supports_effort: maybe }",
      ),
    ).toThrow("model.supports_effort must be true or false");
  });

  test("refuses a provider this deployment cannot call", () => {
    expect(() =>
      packageWithModel(
        "model: { provider: anthropic, credential_secret_ref: key, default_model: claude }",
      ),
    ).toThrow("model.provider must be openai");
  });

  test("refuses a brand with no product name", () => {
    expect(() =>
      validateTenantPackage({
        brand: "tenant: { id: fintech }",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1 }",
        themeCss: "",
      }),
    ).toThrow("tenant.product_name must be a non-empty string");
  });

  test("creates a browser-safe application configuration", () => {
    const configuration = createApplicationConfiguration(
      validateTenantPackage({
        brand:
          "tenant: { id: fintech, product_name: Ledgerline }\nskin: { stylesheet: theme.css }",
        model:
          "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-4.1 }",
        themeCss: ":root { --primary: oklch(0.32 0.09 250); }",
      }),
      ["google"],
    );

    expect(configuration).toEqual({
      brand: {
        tenantId: "fintech",
        productName: "Ledgerline",
      },
      auth: { providers: ["google"] },
    });
  });

  test("loads the mounted LAF package without a theme file", async () => {
    const tenantPackage = await loadTenantPackage(
      new URL("../../tenant/laf", import.meta.url).pathname,
    );

    expect(tenantPackage.tenantId).toBe("openbot");
    expect(tenantPackage.stylesheet).toBeNull();
    expect(tenantPackage.themeCss).toBe("");
    expect(tenantPackage.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(tenantPackage.model.provider).toBe("openai");
    expect(tenantPackage.model.defaultModel).not.toBe("");
  });
});

/**
 * What is left of the synchronise: one row saying which package this deployment booted on.
 *
 * The loops that wrote `agents`, `agent_profiles`, `channels` and `channel_agents` are gone —
 * `agents.yaml` and `channels.yaml` were empty lists and have been deleted — and the one act that
 * had consequences, releasing Bots the package no longer shipped, is done once by migration 0024.
 * This row is not that. It is what `/api/admin/package` reports, and if it stopped being written
 * that endpoint would start answering "no package" about a deployment that plainly has one.
 */
describe("recording which package this deployment booted on", () => {
  test("writes the checksum, and updates it in place on the next boot", async () => {
    const first = loadedPackage();
    const recorded = await recordTenantPackage(database, first);
    expect(recorded.tenantId).toBe(first.tenantId);
    expect(recorded.checksum).toBe(first.checksum);

    const second = { ...first, checksum: randomUUID() };
    const again = await recordTenantPackage(database, second);
    expect(again.id).toBe(recorded.id);
    expect(again.checksum).toBe(second.checksum);

    const rows = await database
      .select()
      .from(deploymentPackages)
      .where(eq(deploymentPackages.tenantId, first.tenantId));
    expect(rows).toHaveLength(1);
  });
});

/**
 * `${NAME}` in a package file.
 *
 * The addresses of the services a package points at belong to the environment rather than to the
 * package, so the same package has to work against a local stack and a deployed one. A name with no
 * value and no default is an error: substituting nothing would point a Bot at an address nobody
 * meant.
 */
describe("expanding a package file against the environment", () => {
  const file = "model.yaml";

  test("takes the value from the environment", () => {
    expect(
      expandEnvironment("default_model: ${BOT_MODEL}", file, {
        BOT_MODEL: "glm-5.3-flash",
      }),
    ).toBe("default_model: glm-5.3-flash");
  });

  test("falls back to the default when the name is not set", () => {
    expect(
      expandEnvironment("default_model: ${BOT_MODEL:-gpt-4.1}", file, {}),
    ).toBe("default_model: gpt-4.1");
  });

  test("prefers the environment over the default", () => {
    expect(
      expandEnvironment("default_model: ${BOT_MODEL:-gpt-4.1}", file, {
        BOT_MODEL: "glm-5.3-flash",
      }),
    ).toBe("default_model: glm-5.3-flash");
  });

  test("treats an empty value as unset", () => {
    expect(
      expandEnvironment("default_model: ${BOT_MODEL:-gpt-4.1}", file, {
        BOT_MODEL: "",
      }),
    ).toBe("default_model: gpt-4.1");
  });

  test("an empty default is allowed and is not an error", () => {
    expect(expandEnvironment("suffix: ${NOTHING:-}", file, {})).toBe(
      "suffix: ",
    );
  });

  test("refuses a name with neither a value nor a default", () => {
    expect(() =>
      expandEnvironment("default_model: ${BOT_MODEL}", file, {}),
    ).toThrow(/model\.yaml refers to \$\{BOT_MODEL\}/);
  });
});
