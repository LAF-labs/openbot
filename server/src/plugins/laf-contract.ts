/**
 * The LAF side of the plugin contract: what a tool's declared annotations are
 * worth, and how consent to a definition is pinned.
 *
 * Upstream treats every tool on a custom server as a write, because nothing
 * reviewed the server. The contract (docs/laf/mcp-contract.md) replaces that
 * blanket distrust with a bargain: a server may declare its tools' risk with
 * standard annotations and be believed — because the definition a person
 * consented to is hashed, and a definition that changes afterwards loses the
 * consent instead of inheriting it. Trust the declaration, pin the
 * declaration, and a quiet downgrade becomes a pause instead of an escalation.
 *
 * Pure functions only, so every rule here is pinned by tests.
 */

import type { AskGuard } from "../computer/approvals";

export type ToolAnnotations = Record<string, unknown> | null | undefined;

/**
 * Why a call must stop for a person even when the written policy allows it.
 *
 * One list, defined where it travels: a guard goes out on the approval, and the surface writes the
 * sentence for it, so {@link ../computer/approvals#AskGuard} holds the four names and this is the
 * contract's own word for the same thing. Two spellings of one list is the shape that drifts.
 */
export type LafGuard = AskGuard;

export type LafClassification = {
  /** What the policy engine is told; the honest read/write split. */
  effect: "read" | "write";
  /** Non-null means a person answers for this exact call, every time. */
  guard: LafGuard | null;
};

/*
 * `guardQuestion` WAS HERE, and what it was is worth the note.
 *
 * Four Korean sentences, written on the server, put into the approval's `question` field — the same
 * field the browser path filled with English ones assembled by `describeAsk`. One field, two
 * languages, depending on which subsystem had stopped the Bot (docs/laf/redesign-2026-09.md §3.1).
 * The guard now travels as a fact on the subject and `app/src/lib/approvals.ts` writes the sentence,
 * in the one place a person's language is known.
 */

/**
 * Classify a custom-server tool from its own declaration.
 *
 * Order matters: the x-laf effect classes outrank everything (a read-only tool
 * that says it moves money is a contradiction resolved in favour of caution),
 * destructive outranks read-only for the same reason, and only an explicit
 * `readOnlyHint: true` earns the unguarded read path.
 */
export function classifyDeclaredTool(
  annotations: ToolAnnotations,
): LafClassification {
  if (!annotations || Object.keys(annotations).length === 0) {
    return { effect: "write", guard: "unannotated" };
  }
  const effectClass = annotations["x-laf/effect"];
  if (effectClass === "money") {
    return { effect: "write", guard: "money" };
  }
  if (effectClass === "external") {
    return { effect: "write", guard: "external" };
  }
  if (annotations.destructiveHint === true) {
    return { effect: "write", guard: "destructive" };
  }
  if (annotations.readOnlyHint === true) {
    return { effect: "read", guard: null };
  }
  // A declared, non-destructive write: the policy decides, no floor.
  return { effect: "write", guard: null };
}

/** JSON with object keys sorted at every depth, so equal values hash equally. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(
        ([key, entryValue]) =>
          `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
};

/**
 * The definition a person consents to, as one hash.
 *
 * The description is included on purpose: it is model-facing text, and a
 * description that quietly changes is the classic tool-poisoning move — the
 * schema stays identical while the words start carrying instructions.
 */
export async function definitionHashOf(tool: ToolDefinition): Promise<string> {
  const canonical = stableStringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? null,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
