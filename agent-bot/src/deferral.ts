import type { RunAgentInput } from "@ag-ui/core";
import {
  BRIDGE_TOOLS,
  type BridgeToolName,
  isBridgeToolName,
  searchResultText,
  splitExposure,
  TOOL_CALL,
  TOOL_SEARCH,
  unwrapToolCall,
  type WireTool,
} from "../../shared/tools/bridge";
import { NOW_TOOL, NOW_TOOL_NAME } from "../../shared/tools/now";

/**
 * Which of the tools this service was handed actually go to the model, and how a call to one of
 * the two bridge tools is answered.
 *
 * The rule itself lives in `shared/tools/bridge.ts`, beside the catalogue it is about. This file is
 * the part that knows the run: the forwarded prop that switches deferral off for a measurement, the
 * shape the provider wants, and the bound on how many times a run may go back to the model for
 * another lookup before it is told to act.
 *
 * THE LIST THE MODEL IS OFFERED IS THE SAME ON EVERY REQUEST OF EVERY RUN (agent-harness-design row
 * 5, Claude Code's "never add or remove tools mid-session"). The tools are the head of the prompt,
 * so a list that changes re-bills the whole conversation behind it. Three things used to change it:
 * the bridge appeared with the first connected service; a run that would not stop searching, and a
 * question that had spent its budget, were sent a last request with the bridge withdrawn or with no
 * tools at all. Now the bridge is always there, and "act now" or "answer now" is a message appended
 * to the end of that one request (`answerNowMessage` in `./run`) — Claude Code's plan mode, which is
 * a tool and a reminder rather than a different tool list.
 *
 * NOTHING HERE REACHES THE SERVER. A `tool_search` is answered from the list the caller already
 * sent; a `tool_call` is turned back into the real tool's own call on the wire, so the surface
 * executes it through exactly the path a direct call takes. The bridge cannot let a call past a
 * boundary because it never holds one.
 */

/**
 * How many times one run may come back asking for lookups before it is told to act.
 *
 * Every lookup round is a full model request with the whole transcript, so an unbounded loop is a
 * Bot searching for a tool that does not exist until the request timeout ends it. Four is search,
 * a second search after a miss, and two more; a model that has not found its tool by then is told,
 * in a message appended to its next request, to act with what it has or say it cannot.
 */
export const MAX_BRIDGE_ROUNDS = 4;

export type ExposedTools = {
  /** What the model is offered — every request, every round. */
  provider: WireTool[];
  /** The tools behind the bridge, for answering lookups. */
  deferred: WireTool[];
  /** Whether the bridge is on this run's list. Off only in the measurement arm. */
  bridged: boolean;
};

/**
 * Whether this run defers tools behind the bridge. On unless the caller says `off`.
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
 * One order for every list the model is offered: by name, by code point.
 *
 * THE TOOLS ARE THE HEAD OF THE PROMPT. GLM's template renders them before the system message
 * (agent-harness-review §1: a nonce in the first tool's description made the whole prompt a
 * miss), so a list that arrives in a different order is a different prompt from its first byte.
 * Sorted here, at the seam every run passes, it is the same whatever order the surface or the
 * routine loop registered in.
 */
export function sortedTools<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  return [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/**
 * The schema a run is offered: the core tools the caller registered, `now`, and the two bridge
 * tools — whatever is or is not connected, so that connecting a service, or a card being allowed
 * for the Bot, changes nothing at the head of the prompt. What sits behind the bridge is named in
 * the conversation's context layer (`deferredToolsText`), which the server freezes per epoch.
 *
 * With deferral off (the measurement arm) the list goes through as it came, plus `now`.
 *
 * `now` is on every list, answered by this service (`shared/tools/now.ts`). A caller's own tool by
 * that name is dropped rather than offered twice: the answer is this service's either way. So is a
 * caller's tool by a bridge's name — the bridge is this service's.
 */
export function exposeTools(
  tools: readonly WireTool[] | undefined,
  deferral: boolean,
): ExposedTools {
  const all = sortedTools(
    (tools ?? []).filter(
      (tool) => tool.name !== NOW_TOOL_NAME && !isBridgeToolName(tool.name),
    ),
  );
  if (!deferral) {
    return {
      provider: sortedTools([...all, NOW_TOOL]),
      deferred: [],
      bridged: false,
    };
  }
  const { core, deferred } = splitExposure(all);
  return {
    provider: sortedTools([...core, NOW_TOOL, ...BRIDGE_TOOLS]),
    deferred,
    bridged: true,
  };
}

/** A call this service answers itself, from nothing but the clock: `now`. */
export function isServiceCall(name: string): boolean {
  return name === NOW_TOOL_NAME;
}

/** A bridge call by name only when a bridge was actually offered; otherwise every name is forwarded. */
export function isBridgeCall(
  name: string,
  exposed: ExposedTools,
): name is BridgeToolName {
  return exposed.bridged && isBridgeToolName(name);
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
