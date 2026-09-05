/**
 * The deferral arm: what the bridge saves, measured on the schema a Bot is actually handed.
 *
 * The scenarios in `./scenarios.ts` each carry a small hand-picked tool list, which is right for
 * judging whether a model picks the right tool and wrong for judging what the bridge is worth: the
 * saving is in the tools a turn does NOT use, and a scenario with three tools has none. So this arm
 * runs the same scenarios behind the REALISTIC toolset — every computer tool, every self tool, and
 * every connected-service tool this repository's own adapters offer, named exactly as the server
 * names them — once with the bridge and once without, and reports schema bytes and prompt tokens
 * for both.
 *
 * The connected-service tools come from the adapters themselves (`server/src/plugins/*-rest.ts`,
 * the alimtalk partner module), not from a copy: the words are what the model reads, and a copy is
 * the drift `tests/tool-catalogue.test.ts` exists to stop.
 */
import { exposeTools, schemaBytesOf } from "../agent-bot/src/deferral";
import { ALIMTALK_TOOLS } from "../server/src/plugins/alimtalk/tools";
import { listTools as cafe24Tools } from "../server/src/plugins/cafe24-rest";
import { listTools as gmailTools } from "../server/src/plugins/gmail-rest";
import { listTools as businessTools } from "../server/src/plugins/google-business-rest";
import { listTools as calendarTools } from "../server/src/plugins/google-calendar-rest";
import { listTools as driveTools } from "../server/src/plugins/google-drive-rest";
import { listTools as sheetsTools } from "../server/src/plugins/google-sheets-rest";
import type { McpTool } from "../server/src/plugins/mcp";
import { toolNameFor } from "../server/src/plugins/store";
import type { WireTool } from "../shared/tools/bridge";
import { COMPUTER_TOOLS } from "../shared/tools/computer";
import { SELF_TOOLS } from "../shared/tools/self";

/** The adapters list their tools from code; none of them reads the connection to do it. */
const NO_CONNECTION = { url: "" };

/**
 * Every connected-service tool this deployment can offer, as the surface registers it.
 *
 * Named through `toolNameFor`, so the prefix that makes a tool deferrable is the server's own. The
 * description carries the server's key in brackets because that is what `plugin-tools.tsx` sends:
 * a model choosing between two servers that both offer "search" needs to know which is which.
 */
export async function connectedServiceTools(): Promise<WireTool[]> {
  const families: Array<[string, readonly McpTool[]]> = [
    ["google-drive", await driveTools(NO_CONNECTION)],
    ["google-sheets", await sheetsTools(NO_CONNECTION)],
    ["gmail", await gmailTools(NO_CONNECTION)],
    ["google-calendar", await calendarTools(NO_CONNECTION)],
    ["google-business-profile", await businessTools(NO_CONNECTION)],
    ["cafe24", await cafe24Tools(NO_CONNECTION)],
    ["kakao-alimtalk", ALIMTALK_TOOLS],
  ];
  return families.flatMap(([key, tools]) =>
    tools.map((tool) => ({
      name: toolNameFor(`${key}/${tool.name}`),
      description: `${tool.description} (${key})`,
      parameters: tool.inputSchema,
    })),
  );
}

/** What a chat Bot with everything connected is handed: the product's whole schema. */
export const REALISTIC_TOOLSET: readonly WireTool[] = [
  ...COMPUTER_TOOLS,
  ...SELF_TOOLS,
  ...(await connectedServiceTools()),
];

export type SchemaMeasure = {
  /** Tools the Bot was handed. */
  tools: number;
  /** Of those, behind the bridge. */
  deferred: number;
  /** Bytes of tool schema on the wire to the model, bridge off. */
  bytes: number;
  /** The same, bridge on: core tools plus the three bridge tools. */
  bytesDeferred: number;
  /** What the three bridge tools themselves cost, in bytes. */
  bytesBridge: number;
  /**
   * The same two, in characters.
   *
   * Reported beside the bytes because the descriptions are Korean, and a Korean character is three
   * bytes of UTF-8 to a tokeniser's roughly one token: bytes overstate the core tools three to one
   * against the English-named ones. Characters are the nearer proxy for what a model pays; the
   * real number is the prompt-token column the model arm fills in.
   */
  chars: number;
  charsDeferred: number;
};

const charsOf = (tools: readonly WireTool[]) =>
  JSON.stringify(exposeTools(tools, false).provider).length;

/** The static half of the measurement: bytes and characters, which need no model. */
export function measureSchema(tools: readonly WireTool[]): SchemaMeasure {
  const off = exposeTools(tools, false);
  const on = exposeTools(tools, true);
  const bytesDeferred = schemaBytesOf(on.provider);
  return {
    tools: tools.length,
    deferred: on.deferred.length,
    bytes: schemaBytesOf(off.provider),
    bytesDeferred,
    bytesBridge: bytesDeferred - schemaBytesOf(on.withoutBridge),
    chars: charsOf(off.provider),
    charsDeferred: charsOf(on.provider),
  };
}

/** "−56%" for 47.4 KB → 21.0 KB. Rounded to whole percent; a sign, so a regression reads as one. */
export function savingOf(before: number, after: number): string {
  if (before === 0) return "0%";
  const percent = Math.round(((after - before) / before) * 100);
  return `${percent > 0 ? "+" : percent < 0 ? "−" : ""}${Math.abs(percent)}%`;
}
