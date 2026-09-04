/**
 * The partner runtime: which of the two partner vendors this deployment holds a key for, and the
 * modules that answer for them.
 *
 * WHY IT IS ASSEMBLED HERE AND NOT INSIDE THE STORE. A partner's tools are this repository's own
 * code and reach the database through `partner-connections.ts`, which imports `store.ts` for its
 * refusal class. Building the runtime inside the store would close that loop. So the process builds
 * this, hands `transports` to `createPluginStore` and the whole object to the partner routes, and
 * the store learns nothing about 솔라피 or 팝빌 beyond "this entry's transport came from outside".
 *
 * ABSENT IS THE DEFAULT AND IT IS NOT AN ERROR. A fleet VM with no `LAF_ALIMTALK_API_KEY` has no
 * 알림톡: the card is not drawn, the connect route refuses 503, no server row is made and no tool is
 * offered. That is the whole of what "a control that saves and does nothing is worse than no
 * control" means for a connector whose credential belongs to the platform.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";
import {
  type AlimtalkConnect,
  createAlimtalkConnect,
} from "./alimtalk/connect";
import { solapiSettings } from "./alimtalk/solapi";
import { ALIMTALK_TOOLS, createAlimtalkTools } from "./alimtalk/tools";
import type { PartnerFamily } from "./catalogue";
import {
  createPartnerConnections,
  type PartnerConnections,
  type PartnerContext,
} from "./partner-connections";
import type { PartnerToolSpec } from "./partner-tools";
import { createTaxConnect, type TaxConnect } from "./tax/connect";
import { popbillSettings } from "./tax/popbill";
import { createTaxTools, TAX_TOOLS } from "./tax/tools";
import type { VendorTransport } from "./transport";

/** What every partner connector offers a screen, in the shape the routes hand back. */
export type PartnerRuntime = {
  /** The rows, shared by both connectors and by the notification door. */
  connections: PartnerConnections;
  /** Null when this deployment holds no 솔라피 key. */
  alimtalk: AlimtalkConnect | null;
  /** Null when this deployment holds no 팝빌 LinkID. */
  tax: TaxConnect | null;
  /** For `createPluginStore`. Only the partners this deployment can actually reach. */
  transports: Partial<Record<PartnerFamily, VendorTransport>>;
  /** Which partners are configured, in catalogue order. What the 연결 screen may draw. */
  configured: readonly PartnerFamily[];
  /** The tools one partner offers, so a connect can grant them without asking the database. */
  toolsOf: (provider: PartnerFamily) => readonly PartnerToolSpec[];
  /**
   * Every Bot this person owns, deleted ones excluded.
   *
   * Read here rather than through the profile store, because a HIDDEN Bot is still a Bot of theirs
   * and `list()` leaves it out — a person who tidied a Bot off their home screen and then connected
   * 알림톡 would find that one Bot could not send.
   */
  botsOwnedBy: (userId: string) => Promise<string[]>;
};

export function createPartnerRuntime(input: {
  context: PartnerContext;
  database: Database;
  environment?: Record<string, string | undefined>;
}): PartnerRuntime {
  const environment = input.environment ?? process.env;
  const connections = createPartnerConnections(input.context);

  const hasAlimtalk = solapiSettings(environment) !== null;
  const hasTax = popbillSettings(environment) !== null;

  const alimtalk = hasAlimtalk
    ? createAlimtalkConnect(input.context, connections, environment)
    : null;
  const tax = hasTax
    ? createTaxConnect(input.context, connections, environment)
    : null;

  const transports: Partial<Record<PartnerFamily, VendorTransport>> = {
    ...(hasAlimtalk
      ? { "kakao-alimtalk": createAlimtalkTools(connections, environment) }
      : {}),
    ...(hasTax
      ? { "tax-invoice": createTaxTools(connections, environment) }
      : {}),
  };

  return {
    connections,
    alimtalk,
    tax,
    transports,
    configured: Object.freeze(
      (
        [
          "kakao-alimtalk",
          "tax-invoice",
        ] as const satisfies readonly PartnerFamily[]
      ).filter((family) => transports[family] !== undefined),
    ),
    toolsOf: (provider) =>
      provider === "kakao-alimtalk" ? ALIMTALK_TOOLS : TAX_TOOLS,
    botsOwnedBy: async (userId) => {
      if (!userId) return [];
      const rows = await input.database
        .select({ agentId: agentProfiles.agentId })
        .from(agentProfiles)
        .where(
          and(
            eq(agentProfiles.ownerUserId, userId),
            isNull(agentProfiles.deletedAt),
          ),
        );
      return rows.map((row) => row.agentId);
    },
  };
}
