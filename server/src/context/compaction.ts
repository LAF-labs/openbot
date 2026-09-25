/**
 * Compaction: what a long conversation stops carrying, decided once, at a token threshold, and
 * applied to every request after it (agent-harness-design row 9).
 *
 * A CACHE-SAFE FORK, CLAUDE CODE'S WAY. Nothing here rewrites history on its own schedule. When a
 * conversation's prompt crosses the threshold, one decision is made about which OLD tool calls and
 * results it still needs; it is stored with the conversation (`laf_conversation_contexts.compaction`)
 * and a new epoch is begun (`beginEpoch(…, "compaction")`), so the frozen context layer reloads at
 * the same moment the prefix breaks anyway. From then on:
 *
 *   A kept message is the SAME object, byte for byte. Only the calls the decision names are touched.
 *   A dropped call is removed together with its result — no result is ever left without its call.
 *   A dropped result keeps its call, and its content becomes a fixed stub: the first characters of
 *   the result and one line saying it was emptied (`laf:tool_result_compacted`). Deterministic, so
 *   the replacement is the same bytes on every request after.
 *   The decision is never recomputed. A later compaction adds to it; nothing un-drops.
 *
 * Person and assistant TEXT is never dropped: Jev decides about tool calls only, and so does the
 * rule below. (A summary of old text — the design's third step — is not built; see the eval notes.)
 *
 * THREE WAYS TO DECIDE, measured against each other by `bun run eval:compaction` (docs/laf/eval-pack.md):
 *
 *   `latest-snapshot` — deterministic, no model: of the page reads and element snapshots of one tab,
 *                       only the newest of each kind keeps its content. The baseline.
 *   `decisions`       — fast-jev-compaction (vendored, `./vendor/fast-jev-compaction`), asking Jev
 *                       when the privacy switch is on and the deployment's GLM in the same shape when
 *                       it is off or fails. With `excerpts`, each result is shown to the judge as a
 *                       redacted excerpt (`./judge-redaction`); without, upstream's blind note.
 *
 * A decision that fails — Jev down, the fallback down, a history too big to judge — falls back to
 * the deterministic rule. Compaction must never be the reason a conversation stops working.
 */

import type { AbstractAgent } from "@ag-ui/client";
import { toolResultText } from "../../../shared/prompt/tool-results.ko";
import { redactedInput, redactText, resultExcerpt } from "./judge-redaction";
import {
  type CallDecision,
  collectToolCalls,
  compact,
  type JevAsker,
  type Message as UpstreamMessage,
  type ToolCall,
} from "./vendor/fast-jev-compaction/index";

type AgentMessage = Parameters<AbstractAgent["run"]>[0]["messages"][number];

export type CompactionAction = "drop_call" | "drop_result";

/** What one compaction decided, by tool-call id. Persisted; only ever added to. */
export type CompactionPlan = Record<string, CompactionAction>;

/** How compaction decides. `off` never compacts. */
export type CompactionMode = "off" | "latest-snapshot" | "decisions";

/** The newest messages no compaction touches. Upstream's own default. */
export const PRESERVE_RECENT_MESSAGES = 6;

/** How much of an emptied result stays: enough to know what it was (a URL, a title). */
export const DROPPED_RESULT_HEAD = 300;

/** An emptied result, as every request after the compaction carries it. */
export function droppedResultText(content: string): string {
  const head = content.slice(0, DROPPED_RESULT_HEAD);
  return `${head}${content.length > DROPPED_RESULT_HEAD ? "…" : ""}\n${toolResultText("laf:tool_result_compacted")}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

type Call = { id: string; function: { name: string; arguments: string } };

function callsOf(message: AgentMessage): Call[] {
  if (message.role !== "assistant") return [];
  const calls = (message as { toolCalls?: unknown }).toolCalls;
  return Array.isArray(calls) ? (calls as Call[]) : [];
}

function argumentsOf(call: Call): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The conversation with a plan applied. Pure: the same messages and the same plan are always the
 * same output, and every message the plan does not name comes back as the very object it was.
 */
export function applyCompaction(
  messages: readonly AgentMessage[],
  plan: CompactionPlan,
): AgentMessage[] {
  if (Object.keys(plan).length === 0) return [...messages];
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const id = (message as { toolCallId?: string }).toolCallId ?? "";
      const action = plan[id];
      if (action === "drop_call") continue;
      if (action === "drop_result") {
        out.push({
          ...message,
          content: droppedResultText(textOf(message.content)),
        } as AgentMessage);
        continue;
      }
      out.push(message);
      continue;
    }
    const calls = callsOf(message);
    if (calls.some((call) => plan[call.id] === "drop_call")) {
      const kept = calls.filter((call) => plan[call.id] !== "drop_call");
      const text = textOf((message as { content?: unknown }).content);
      if (kept.length === 0 && !text.trim()) continue;
      out.push({ ...message, toolCalls: kept } as AgentMessage);
      continue;
    }
    out.push(message);
  }
  return out;
}

/** A later decision added to an earlier one. A call once dropped stays dropped. */
export function mergePlans(
  earlier: CompactionPlan,
  later: CompactionPlan,
): CompactionPlan {
  const merged: CompactionPlan = { ...earlier };
  for (const [id, action] of Object.entries(later)) {
    if (merged[id] === "drop_call") continue;
    merged[id] = action;
  }
  return merged;
}

/* ------------------------------------------------------------------------------------------ */
/* The deterministic rule: the newest snapshot per tab                                        */
/* ------------------------------------------------------------------------------------------ */

/** Tools whose result is what one tab showed — its text, or its elements. */
const PAGE_TEXT_TOOLS = new Set(["computer_navigate", "computer_read"]);
const PAGE_ELEMENT_TOOLS = new Set(["computer_snapshot"]);

/**
 * Which tab a result is about: the active one in a result that lists tabs, otherwise the one the
 * Bot last moved to. A new conversation starts on the first tab.
 */
function activeTabIn(result: string): number | null {
  try {
    const parsed = JSON.parse(result) as { tabs?: unknown };
    if (!Array.isArray(parsed.tabs)) return null;
    const active = parsed.tabs.find(
      (tab) =>
        tab && typeof tab === "object" && (tab as { active?: unknown }).active,
    ) as { index?: unknown } | undefined;
    return typeof active?.index === "number" ? active.index : null;
  } catch {
    return null;
  }
}

/**
 * The baseline: for each tab, only the newest page text and the newest element snapshot keep their
 * content; older ones are emptied, their calls kept. Nothing in the newest
 * {@link PRESERVE_RECENT_MESSAGES} messages is touched, and nothing that is not a page read.
 */
export function latestSnapshotPlan(
  messages: readonly AgentMessage[],
  preserveRecent = PRESERVE_RECENT_MESSAGES,
): CompactionPlan {
  const results = new Map<string, { at: number; text: string }>();
  messages.forEach((message, at) => {
    if (message.role !== "tool") return;
    const id = (message as { toolCallId?: string }).toolCallId;
    if (id) results.set(id, { at, text: textOf(message.content) });
  });

  let tab = 0;
  /** The newest result of each kind, per tab: `text:0`, `elements:1`. */
  const newest = new Map<string, string>();
  const reads: Array<{ id: string; key: string; at: number }> = [];
  messages.forEach((message) => {
    for (const call of callsOf(message)) {
      const name = call.function.name;
      if (name === "computer_switch_tab") {
        const index = argumentsOf(call).index;
        if (typeof index === "number") tab = index;
        continue;
      }
      const kind = PAGE_TEXT_TOOLS.has(name)
        ? "text"
        : PAGE_ELEMENT_TOOLS.has(name)
          ? "elements"
          : null;
      const result = results.get(call.id);
      if (!kind || !result) continue;
      tab = activeTabIn(result.text) ?? tab;
      const key = `${kind}:${tab}`;
      newest.set(key, call.id);
      reads.push({ id: call.id, key, at: result.at });
    }
  });

  const cutoff = messages.length - preserveRecent;
  const plan: CompactionPlan = {};
  for (const read of reads) {
    if (read.at >= cutoff) continue;
    if (newest.get(read.key) !== read.id) plan[read.id] = "drop_result";
  }
  return plan;
}

/* ------------------------------------------------------------------------------------------ */
/* Decisions: fast-jev-compaction                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * The conversation in fast-jev-compaction's shape, redacted for the judge.
 *
 * Its `Message` is Claude-Code-shaped (tool uses on the assistant message, results on a user
 * message, joined by `tool_use_id`); ours is OpenAI's (`toolCalls`, `role: "tool"`, joined by
 * `toolCallId`). The ids go through unchanged, which is how a decision finds its way back.
 */
export function toUpstreamMessages(
  messages: readonly AgentMessage[],
): UpstreamMessage[] {
  const out: UpstreamMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({
        role: "user",
        text: redactText(textOf(message.content)),
        toolUses: [],
      });
      continue;
    }
    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        text: redactText(textOf((message as { content?: unknown }).content)),
        toolUses: callsOf(message).map((call) => ({
          tool_use_id: call.id,
          tool: call.function.name,
          input: redactedInput(call.function.name, argumentsOf(call)),
        })),
      });
      continue;
    }
    if (message.role === "tool") {
      // The judge never sees the raw result: `describeResult` decides what stands for it.
      const content = textOf(message.content);
      out.push({
        role: "user",
        text: "",
        toolUses: [],
        toolResults: [
          {
            tool_use_id: (message as { toolCallId?: string }).toolCallId ?? "",
            text: content,
            isError: /^\s*\{\s*"ok"\s*:\s*false/.test(content),
          },
        ],
      });
    }
  }
  return out;
}

/** What `compact` needs, beside the asker. */
export type DecisionOptions = {
  /** Show each result as a redacted excerpt (ours), or upstream's blind `ok, N chars` note. */
  excerpts: boolean;
  keepThreshold?: number;
  preserveRecent?: number;
};

/**
 * Jev's decisions — or the fallback asker's — as a plan. Throws when the asker fails; the caller
 * falls back to the deterministic rule.
 */
export async function decisionPlan(
  messages: readonly AgentMessage[],
  asker: JevAsker,
  options: DecisionOptions,
): Promise<{ plan: CompactionPlan; decisions: CallDecision[] }> {
  const upstream = toUpstreamMessages(messages);
  const preserve = options.preserveRecent ?? PRESERVE_RECENT_MESSAGES;
  const excerpts = new Map<string, string>();
  if (options.excerpts) {
    for (const message of upstream) {
      for (const result of message.toolResults ?? []) {
        excerpts.set(result.tool_use_id, resultExcerpt(result.text));
      }
    }
  }
  const result = await compact(upstream, asker, {
    preserveRecentMessages: preserve,
    ...(options.keepThreshold === undefined
      ? {}
      : { keepThreshold: options.keepThreshold }),
    ...(options.excerpts
      ? {
          describeResult: (call: ToolCall) =>
            `${call.isError ? "error" : "ok"}, ${call.resultChars} chars. excerpt: ${excerpts.get(call.tool_use_id) ?? ""}`,
        }
      : {}),
  });
  const calls = collectToolCalls(upstream, preserve);
  const byShortId = new Map(calls.map((call) => [call.id, call.tool_use_id]));
  const plan: CompactionPlan = {};
  for (const decision of result.decisions) {
    const id = byShortId.get(decision.id);
    if (!id || decision.action === "keep") continue;
    plan[id] = decision.action;
  }
  return { plan, decisions: result.decisions };
}

/* ------------------------------------------------------------------------------------------ */
/* The compactor a conversation store is handed                                               */
/* ------------------------------------------------------------------------------------------ */

/** Which rule actually decided, for the log and the eval. */
export type CompactionArm = "latest-snapshot" | "decisions" | "fallback";

export type Compactor = (
  messages: readonly AgentMessage[],
) => Promise<{ plan: CompactionPlan; arm: CompactionArm }>;

/**
 * The compactor for a mode. `decisions` needs an asker — Jev with the stand-in behind it, or the
 * stand-in alone when the privacy switch is off (`server-model-calls.ts`) — and falls back to the
 * deterministic rule when that asker cannot answer. Null for `off`.
 */
export function createCompactor(options: {
  mode: CompactionMode;
  asker?: JevAsker;
  excerpts?: boolean;
  onFallback?: (reason: string) => void;
}): Compactor | null {
  if (options.mode === "off") return null;
  const asker = options.asker;
  if (options.mode === "latest-snapshot" || !asker) {
    return async (messages) => ({
      plan: latestSnapshotPlan(messages),
      arm: "latest-snapshot",
    });
  }
  return async (messages) => {
    try {
      const { plan } = await decisionPlan(messages, asker, {
        excerpts: options.excerpts ?? true,
      });
      return { plan, arm: "decisions" };
    } catch (error) {
      options.onFallback?.(
        error instanceof Error ? error.message.slice(0, 60) : "failed",
      );
      return { plan: latestSnapshotPlan(messages), arm: "fallback" };
    }
  };
}
