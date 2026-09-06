/**
 * What a partner connector offers a Bot, and how those tools reach the one path a call takes.
 *
 * THE TOOL LIST IS THIS CODE, NOT A SERVER'S ANSWER. Like the Drive adapter, and unlike MCP: there
 * is nobody to ask. That is why `listNeedsCredential` is false — assuming otherwise once made
 * setting a connector up a round trip through somebody's personal settings page for a token that was
 * then discarded.
 *
 * THE ANNOTATIONS ARE THE POINT. Every tool here declares what it does in the same vocabulary a
 * custom server declares it in (docs/laf/mcp-contract.md): `x-laf/effect: external` for a message
 * that leaves the business, `readOnlyHint` for a listing. The declaration is what
 * {@link ./laf-contract#classifyDeclaredTool} turns into a guard floor, and the floor is what makes
 * a person answer for the exact call however permissive the written policy is.
 *
 * A CATALOGUE ENTRY USUALLY HAS NO FLOOR, AND THESE DO. `call.ts` reads a first-party entry's tools
 * as the reviewed catalogue's word and sets no guard, which is right for a vendor whose tool list
 * arrives over the wire and whose risk was reviewed once. These tools are written here, in this
 * repository, and their declaration is reviewed in the same way the catalogue is — so the reviewed
 * word for them INCLUDES the floor, and {@link partnerToolGuard} is what says so at both places the
 * guard is computed.
 */
import { classifyDeclaredTool, type LafGuard } from "./laf-contract";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";
import { PluginRefusedError } from "./store";
import type { VendorTransport } from "./transport";

/** One tool a partner connector offers, declaration included. */
export type PartnerToolSpec = McpTool & {
  /** Never null here: a partner tool that declared nothing would be a floor of `unannotated`. */
  annotations: Record<string, unknown>;
};

/** What a tool actually does. Returns the text a model reads, or throws a refusal. */
export type PartnerToolRun = (input: {
  toolName: string;
  args: Record<string, unknown>;
  /** The person the call is for. Empty is refused before this is reached. */
  actorId: string;
  botId: string;
}) => Promise<string>;

/**
 * What can be known about a call from its arguments alone. Throws a refusal, or returns.
 *
 * PURE, ON PURPOSE. It runs before a person is asked and before any row is written, so it may
 * read nothing but what it is handed: no database, no vendor, no environment. Everything a send
 * needs beyond that — is the channel connected, is the template approved — is `run`'s to check,
 * after the person has said yes.
 */
export type PartnerToolValidate = (input: {
  toolName: string;
  args: Record<string, unknown>;
  actorId: string;
  botId: string;
}) => Promise<void> | void;

/**
 * The guard a partner tool's own declaration asks for, or null when it declares a plain read.
 *
 * Derived from the annotations rather than written beside them, so there is one source: a tool whose
 * annotation says `external` cannot have a table somewhere else saying it needs no floor.
 */
export function guardOfSpec(spec: PartnerToolSpec): LafGuard | null {
  return classifyDeclaredTool(spec.annotations).guard;
}

/**
 * A transport for a connector whose tools are this repository's own code.
 *
 * `truncated` is reported honestly rather than always false: a listing that runs long can go past
 * what a model should be handed, and a result silently cut in half is worse than one that says it
 * was cut.
 */
export function partnerTransport(input: {
  tools: readonly PartnerToolSpec[];
  run: PartnerToolRun;
  /**
   * The checks that need only the arguments, run by the call path before anybody is asked.
   *
   * Absent means the connector can tell nothing in advance and the first look at the arguments
   * is `run`'s — which is what every connector did until 2026-09-06, and what spent two
   * approvals on an 알림톡 that could never go out. See `VendorTransport.validateArgs`.
   */
  validate?: PartnerToolValidate;
  /** The fact a call with nobody attributed to it is refused with. */
  anonymousFact: string;
}): VendorTransport {
  const { validate } = input;
  return {
    listNeedsCredential: false,
    listTools: async () =>
      input.tools.map((tool) => ({
        ...tool,
        annotations: { ...tool.annotations },
      })),
    ...(validate
      ? {
          validateArgs: async (connection, toolName, args) => {
            // Not the anonymous check: who the call is for is a fact about the run, and refusing
            // it here would be refusing before the boundary has a row to write it in.
            await validate({
              toolName,
              args,
              actorId: connection.actorId ?? "",
              botId: connection.botId ?? "",
            });
          },
        }
      : {}),
    callTool: async (connection, toolName, args): Promise<McpCallResult> => {
      /*
       * A call nobody is attributed to is refused before anything is looked up.
       *
       * A partner connection is one person's registration, and there is deliberately no fallback:
       * picking whichever row sorted first would send a message from somebody else's 카카오톡 채널,
       * which is the one failure this whole design exists to make impossible.
       */
      const actorId = connection.actorId ?? "";
      if (!actorId) throw new PluginRefusedError(input.anonymousFact, null);

      const text = await input.run({
        toolName,
        args,
        actorId,
        botId: connection.botId ?? "",
      });
      return text.length <= MAX_RESULT_CHARS
        ? { text, isError: false, truncated: false }
        : {
            text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: ${text.length} characters]`,
            isError: false,
            truncated: true,
          };
    },
  };
}

/** A refusal a Bot reads as Korean, through the one table both tool paths share. */
export function refuse(fact: string): never {
  throw new PluginRefusedError(fact, null, fact);
}

/** A required string argument, or the refusal for its absence. */
export function requiredString(
  args: Record<string, unknown>,
  name: string,
  fact: string,
): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) refuse(fact);
  return String(value).trim();
}
