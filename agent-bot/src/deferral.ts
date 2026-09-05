import type { RunAgentInput } from "@ag-ui/core";
import {
  type BridgeToolName,
  bridgeTools,
  describeResultText,
  isBridgeToolName,
  searchResultText,
  splitExposure,
  TOOL_CALL,
  TOOL_DESCRIBE,
  TOOL_SEARCH,
  unwrapToolCall,
  type WireTool,
} from "../../shared/tools/bridge";

/**
 * Which of the tools this service was handed actually go to the model, and how a call to one of
 * the three bridge tools is answered.
 *
 * The rule itself lives in `shared/tools/bridge.ts`, beside the catalogue it is about. This file is
 * the part that knows the run: the forwarded prop that switches deferral off for a measurement, the
 * shape the provider wants, and the bound on how many times a run may go back to the model for
 * another lookup before it has to act.
 *
 * NOTHING HERE REACHES THE SERVER. A `tool_search` or `tool_describe` is answered from the list the
 * caller already sent; a `tool_call` is turned back into the real tool's own call on the wire, so
 * the surface executes it through exactly the path a direct call takes. The bridge cannot let a call
 * past a boundary because it never holds one.
 */

/**
 * How many times one run may come back asking for lookups before it is made to act.
 *
 * Every lookup round is a full model request with the whole transcript, so an unbounded loop is a
 * Bot searching for a tool that does not exist until the request timeout ends it. Four is search,
 * describe, a second search after a miss, and one more; a model that has not found its tool by
 * then is answered by a round with no bridge at all, so it can only speak or use a core tool.
 */
export const MAX_BRIDGE_ROUNDS = 4;

export type ExposedTools = {
  /** What the model is offered this round. */
  provider: WireTool[];
  /** The same, with the bridge withdrawn — the last round of a run that would not stop searching. */
  withoutBridge: WireTool[];
  /** The tools behind the bridge, for answering lookups. Empty means no bridge was offered. */
  deferred: WireTool[];
};

/**
 * Whether this run defers connected-service tools. On unless the caller says `off`.
 *
 * A per-run switch rather than an environment variable, because the eval arm measures both arms in
 * one process against one model (docs/laf/eval-pack.md). Production never sends it.
 */
export function toolDeferralOf(input: RunAgentInput): boolean {
  const forwarded = input.forwardedProps;
  if (!forwarded || typeof forwarded !== "object") return true;
  return (forwarded as Record<string, unknown>).toolDeferral !== "off";
}

/**
 * The schema a run is offered.
 *
 * With nothing to defer the list goes through untouched — no bridge for a Bot with no connected
 * services, because three tools that can find nothing are three tools' worth of tokens for
 * nothing. With deferral off (the measurement arm) likewise. Otherwise the core tools plus the
 * bridge, whose `tool_search` names the services actually connected this run.
 */
export function exposeTools(
  tools: readonly WireTool[] | undefined,
  deferral: boolean,
): ExposedTools {
  const all = [...(tools ?? [])];
  const { core, deferred } = splitExposure(all);
  if (!deferral || deferred.length === 0) {
    return { provider: all, withoutBridge: all, deferred: [] };
  }
  return {
    provider: [...core, ...bridgeTools(deferred)],
    withoutBridge: core,
    deferred,
  };
}

/** A bridge call by name only when a bridge was actually offered; otherwise every name is forwarded. */
export function isBridgeCall(
  name: string,
  exposed: ExposedTools,
): name is BridgeToolName {
  return exposed.deferred.length > 0 && isBridgeToolName(name);
}

export type BridgeAnswer =
  /** Answered here, from the list. Goes on the wire as the bridge call plus its result. */
  | { kind: "answer"; text: string }
  /** The real call, to go on the wire in the real tool's name. */
  | { kind: "forward"; name: string; args: Record<string, unknown> };

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw.trim() === "" ? "{}" : raw);
  } catch {
    return null;
  }
}

/** What one bridge call becomes. */
export function answerBridgeCall(
  name: BridgeToolName,
  rawArguments: string,
  deferred: readonly WireTool[],
): BridgeAnswer {
  const args = parseArguments(rawArguments);
  const field = (key: string): string => {
    if (!args || typeof args !== "object") return "";
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  };

  if (name === TOOL_SEARCH) {
    return { kind: "answer", text: searchResultText(deferred, field("query")) };
  }
  if (name === TOOL_DESCRIBE) {
    return {
      kind: "answer",
      text: describeResultText(deferred, field("name")),
    };
  }
  if (name === TOOL_CALL) {
    const unwrapped = unwrapToolCall(deferred, args);
    return unwrapped.ok
      ? { kind: "forward", name: unwrapped.name, args: unwrapped.args }
      : { kind: "answer", text: unwrapped.text };
  }
  return { kind: "answer", text: `${name satisfies never}` };
}

/** The provider's shape for a tool list. `undefined` for none, which is what the API wants. */
export function toProviderTools(tools: readonly WireTool[]) {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
  }));
}

/**
 * How many bytes of schema the model reads for a tool list, as the provider is sent it.
 *
 * The number the eval arm reports beside prompt tokens. Bytes of the JSON actually on the wire
 * rather than a token estimate, because a provider's tokeniser is not ours and bytes are exact.
 */
export function schemaBytesOf(tools: readonly WireTool[]): number {
  const sent = toProviderTools(tools);
  return sent ? new TextEncoder().encode(JSON.stringify(sent)).length : 0;
}
