/**
 * A REGISTERED TOOL'S PARAMETERS, AS THE JSON SCHEMA THE TURN IS SENT.
 *
 * The server hashes the list a window sends (`toolsFingerprint`, `server/src/copilot.ts`): one
 * byte moving opens a new epoch and bills the whole conversation again. So this writes what
 * `@copilotkit/core` 1.67.1 wrote (`createToolSchema`), key for key and in the same order, and
 * `tests/tool-list-bytes.test.tsx` holds the result to the bytes windows were sending under it.
 * What it does, none of which is free to change:
 *
 * 1. The schema describes itself. A zod object does through Standard JSON Schema
 *    (`~standard.jsonSchema.input`, asked for draft-07); the catalogue's face
 *    (`shared/tools/standard-schema.ts`) through `toJSONSchema()`, which hands back the catalogue's
 *    own schema untouched.
 * 2. `$schema` is dropped.
 * 3. `type` is `"object"` unless it is already some string, and `properties` is an object — each
 *    added at the END when it was missing, which is where a key added to an object goes.
 * 4. Every `additionalProperties` is removed, at every depth — a parameter that is itself NAMED
 *    `additionalProperties` included. That last is a fault in what was copied, and it is copied:
 *    mending it here is a different list for whichever tool has one.
 */

/** What a tool's parameters are registered as: a zod object, or the catalogue's face. */
export type ToolSchema<Output = unknown> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?:
      | { readonly input: unknown; readonly output: Output }
      | undefined;
  };
};

export type ToolJsonSchema = Record<string, unknown>;

type DescribesItself = {
  "~standard"?: {
    jsonSchema?: { input?: (options: { target: string }) => unknown } | null;
  } | null;
  toJSONSchema?: () => unknown;
};

function describe(schema: DescribesItself): unknown {
  const standard = schema["~standard"]?.jsonSchema;
  if (standard && typeof standard.input === "function") {
    return standard.input({ target: "draft-07" });
  }
  if (typeof schema.toJSONSchema === "function") return schema.toJSONSchema();
  /*
   * Nothing registered here is anything else. Refused out loud rather than sent as "takes
   * nothing": a tool whose arguments silently vanished is called with none.
   */
  throw new Error("A tool's parameters do not describe themselves as JSON.");
}

/**
 * A copy with every `additionalProperties` left out. A copy, where what this replaces deleted in
 * place: the catalogue's schema is handed over as it is, and it is not this file's to change.
 */
function withoutAdditionalProperties(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(withoutAdditionalProperties);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, inner]) =>
          !(key === "additionalProperties" && inner !== undefined),
      )
      .map(([key, inner]) => [key, withoutAdditionalProperties(inner)]),
  );
}

export function toolJsonSchema(parameters: unknown): ToolJsonSchema {
  if (!parameters) return { type: "object", properties: {} };
  const raw = describe(parameters as DescribesItself);
  if (!raw || typeof raw !== "object")
    return { type: "object", properties: {} };
  const { $schema: _dropped, ...schema } = raw as ToolJsonSchema;
  if (typeof schema.type !== "string") schema.type = "object";
  if (typeof schema.properties !== "object" || schema.properties === null) {
    schema.properties = {};
  }
  return withoutAdditionalProperties(schema) as ToolJsonSchema;
}
