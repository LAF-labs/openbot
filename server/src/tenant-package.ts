import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { desc } from "drizzle-orm";
import { parse } from "yaml";
import type { Database } from "./db/client";
import { deploymentPackages } from "./db/schema";

/**
 * What a deployment's package still says.
 *
 * It once shipped Bots and channels too, and a synchronise loop wrote them into `agents`,
 * `agent_profiles`, `channels` and `channel_agents` on every boot. Both lists have been empty since
 * the product decided a Bot starts with nothing set and belongs to the person who made it, so the
 * loop's only remaining effect was its release step — clearing `package_id` from Bots the package
 * no longer shipped — which a one-shot migration has now done for good. What is left is what is
 * live: who this deployment is, which model it runs on, and how it looks.
 */

const approvedThemeVariables = new Set([
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--border",
  "--input",
  "--ring",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--radius",
  "--sidebar",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-ring",
]);

export function validateThemeCss(css: string) {
  if (/@import|url\s*\(/i.test(css)) {
    throw new Error("Tenant theme must not contain imports or URLs");
  }

  const blocks = [...css.matchAll(/(:root|\.dark)\s*\{([^{}]*)\}/g)];
  const remaining = css.replace(/(:root|\.dark)\s*\{[^{}]*\}/g, "").trim();
  if (!blocks.length || remaining) {
    throw new Error("Tenant theme may only define :root and .dark blocks");
  }

  for (const [, , body] of blocks) {
    for (const declaration of body.split(";")) {
      const trimmed = declaration.trim();
      if (!trimmed) {
        continue;
      }
      const separator = trimmed.indexOf(":");
      const variable = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();

      if (separator < 1 || !value || !approvedThemeVariables.has(variable)) {
        throw new Error(
          `Tenant theme variable ${variable || "(invalid)"} is not an approved theme variable`,
        );
      }
    }
  }
}

type PackageFiles = {
  brand: string;
  model: string;
  themeCss: string;
};

export type TenantPackage = {
  tenantId: string;
  productName: string;
  stylesheet: string | null;
  model: {
    provider: "openai";
    credentialSecretRef: string;
    defaultModel: string;
    /** Whether this model takes an effort setting. See `agent_effort` and `model.yaml`. */
    supportsEffort: boolean;
    /** Which model judges an auto-review instruction. Falls back to `defaultModel`. */
    reviewModel: string;
  };
  themeCss: string;
};

export type LoadedTenantPackage = TenantPackage & {
  sourcePath: string;
  checksum: string;
};

export type PackageStatusReader = {
  active: () => Promise<{
    tenantId: string;
    sourcePath: string;
    checksum: string;
    loadedAt: string;
  } | null>;
};

export type ApplicationConfiguration = {
  brand: {
    tenantId: string;
    productName: string;
  };
  auth: { providers: string[] };
};

export function createApplicationConfiguration(
  tenantPackage: TenantPackage,
  providers: string[],
): ApplicationConfiguration {
  return {
    brand: {
      tenantId: tenantPackage.tenantId,
      productName: tenantPackage.productName,
    },
    auth: { providers },
  };
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

/**
 * A yes/no a package may leave out.
 *
 * The strings as well as the booleans, because these values come out of YAML with environment
 * substitution in them: `${BOT_MODEL_EFFORT:-true}` is the string "true" however the variable is
 * set, and a parser that only accepted real booleans would read every one of them as malformed.
 */
function asBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function yaml(value: string, filename: string): Record<string, unknown> {
  try {
    return asRecord(parse(value), filename);
  } catch (error) {
    throw new Error(
      `${filename} is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

/**
 * `${NAME}` in a package file, resolved from the environment.
 *
 * A package describes a deployment, and the addresses of the services behind it belong to the
 * environment rather than to the package: the same package has to be usable against a local stack,
 * a staging one and production. An unset name is an error rather than an empty string.
 */
export function expandEnvironment(
  value: string,
  filename: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name: string, fallback: string | undefined) => {
      const resolved = environment[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error(
        `${filename} refers to \${${name}}, which is not set in this environment.`,
      );
    },
  );
}

export function validateTenantPackage(files: PackageFiles): TenantPackage {
  if (files.themeCss.trim()) {
    validateThemeCss(files.themeCss);
  }
  const brand = yaml(files.brand, "brand.yaml");
  const modelYaml = yaml(files.model, "model.yaml");
  const tenant = asRecord(brand.tenant, "brand.tenant");
  const skin =
    brand.skin === undefined ? undefined : asRecord(brand.skin, "brand.skin");
  const model = asRecord(modelYaml.model, "model");
  if (model.provider !== "openai") {
    throw new Error("model.provider must be openai");
  }

  return {
    tenantId: requiredString(tenant.id, "tenant.id"),
    productName: requiredString(tenant.product_name, "tenant.product_name"),
    stylesheet: skin
      ? requiredString(skin.stylesheet, "skin.stylesheet")
      : null,
    model: {
      provider: "openai",
      credentialSecretRef: requiredString(
        model.credential_secret_ref,
        "model.credential_secret_ref",
      ),
      defaultModel: requiredString(model.default_model, "model.default_model"),
      // Absent reads as yes: the product's own model has one, and a package that says nothing about
      // effort is far more likely to be an older package than a deployment on a model without it.
      supportsEffort: asBoolean(
        model.supports_effort,
        true,
        "model.supports_effort",
      ),
      // Empty falls back rather than failing: `${REVIEW_MODEL:-}` with nothing set is the empty
      // string, and a deployment that has not chosen one should run on the model it already has.
      reviewModel:
        typeof model.review_model === "string" && model.review_model.trim()
          ? model.review_model.trim()
          : requiredString(model.default_model, "model.default_model"),
    },
    themeCss: files.themeCss,
  };
}

export async function loadTenantPackage(
  sourcePath: string,
): Promise<LoadedTenantPackage> {
  const filenames = ["brand.yaml", "model.yaml"] as const;
  const contents = await Promise.all(
    filenames.map(async (filename) =>
      expandEnvironment(
        await readFile(join(sourcePath, filename), "utf8"),
        filename,
      ),
    ),
  );
  const [brand, model] = contents;
  const themeCss = await readFile(join(sourcePath, "theme.css"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const tenantPackage = validateTenantPackage({
    brand,
    model,
    themeCss,
  });

  return {
    ...tenantPackage,
    sourcePath,
    checksum: createHash("sha256").update(contents.join("\n")).digest("hex"),
  };
}

/**
 * Which package this deployment booted on, written down so the admin surface can say.
 *
 * All that is left of `synchronizeTenantPackage`. The loops it ran over `agents`, `agent_profiles`,
 * `channels` and `channel_agents` had nothing to iterate — both lists have been empty for a while —
 * and its one act with consequences, releasing Bots the package had stopped shipping, is done once
 * and for all by migration 0024. This row is not that: it is the checksum `/api/admin/package`
 * reports, and it must keep being written or that endpoint starts answering "no package" about a
 * deployment that plainly has one.
 */
export async function recordTenantPackage(
  database: Database,
  tenantPackage: LoadedTenantPackage,
) {
  const [deploymentPackage] = await database
    .insert(deploymentPackages)
    .values({
      tenantId: tenantPackage.tenantId,
      sourcePath: tenantPackage.sourcePath,
      checksum: tenantPackage.checksum,
    })
    .onConflictDoUpdate({
      target: deploymentPackages.tenantId,
      set: {
        sourcePath: tenantPackage.sourcePath,
        checksum: tenantPackage.checksum,
        loadedAt: new Date(),
      },
    })
    .returning();

  if (!deploymentPackage) {
    throw new Error("Tenant package could not be recorded");
  }

  return deploymentPackage;
}

export function createPackageStatusReader(
  database: Database,
): PackageStatusReader {
  return {
    active: async () => {
      const [tenantPackage] = await database
        .select()
        .from(deploymentPackages)
        .orderBy(desc(deploymentPackages.loadedAt))
        .limit(1);
      return tenantPackage
        ? {
            tenantId: tenantPackage.tenantId,
            sourcePath: tenantPackage.sourcePath,
            checksum: tenantPackage.checksum,
            loadedAt: tenantPackage.loadedAt.toISOString(),
          }
        : null;
    },
  };
}
