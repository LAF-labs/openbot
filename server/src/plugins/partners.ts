/**
 * The partner runtime: whether this deployment holds the key for a partner vendor, and the modules
 * that answer for it.
 *
 * ONE VENDOR, AND THE SHAPE IS STILL PLURAL. 전자세금계산서 (팝빌) was the second one and was dropped
 * on 2026-09-05; 알림톡 is what is left. The runtime keeps its per-family shape — a transport table,
 * a configured list — because that is what `createPluginStore` and the routes read, and because
 * collapsing it to one vendor's name is the change that has to be undone the day a second lands.
 *
 * WHY IT IS ASSEMBLED HERE AND NOT INSIDE THE STORE. A partner's tools are this repository's own
 * code and reach the database through `partner-connections.ts`, which imports `store.ts` for its
 * refusal class. Building the runtime inside the store would close that loop. So the process builds
 * this, hands `transports` to `createPluginStore` and the whole object to the partner routes, and
 * the store learns nothing about 솔라피 beyond "this entry's transport came from outside".
 *
 * ABSENT IS THE DEFAULT AND IT IS NOT AN ERROR. A fleet VM with no `LAF_ALIMTALK_API_KEY` has no
 * 알림톡: the card is not drawn, the connect route refuses 503, no server row is made and no tool is
 * offered. That is the whole of what "a control that saves and does nothing is worse than no
 * control" means for a connector whose credential belongs to the platform.
 */
import type { Database } from "../db/client";
import { log } from "../log";
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
import { botsOwnedBy } from "./skills-and-grants";
import type { PluginStore } from "./store";
import type { VendorTransport } from "./transport";

/** The slice of the store a grant needs, so a caller — or a test — hands in exactly that. */
export type PartnerGrantStore = Pick<PluginStore, "grant" | "listForAgent">;

/** What every partner connector offers a screen, in the shape the routes hand back. */
export type PartnerRuntime = {
  /** The rows, shared by the connector and by the notification door. */
  connections: PartnerConnections;
  /** Null when this deployment holds no 솔라피 key. */
  alimtalk: AlimtalkConnect | null;
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
  /**
   * One partner's tools, granted to one Bot — the one definition of what a partner gives a Bot.
   *
   * The connect route calls it for every Bot the person owns at that moment, and {@link offerTo}
   * for a Bot made afterwards, so the two cannot drift. Only the refs the Bot does not already
   * hold are written, the same rule as the public-data grants: a reconnect must not rewrite rows
   * of trail. Throws, because the callers are in the middle of different acts and each decides
   * what a grant that did not land means for its own.
   */
  grantTo: (
    store: PartnerGrantStore,
    provider: PartnerFamily,
    botId: string,
    by: string,
  ) => Promise<void>;
  /**
   * A Bot that has just come into being gets the tools of every partner its owner has connected.
   *
   * MEASURED 2026-09-06: a connect granted to the Bots that existed at that moment and to no
   * other, so a Bot made the next day could not send 알림톡 until the person reconnected a channel
   * that had never been disconnected. This is the other half of the connect, run from the create
   * route. Never throws — the Bot exists by the time this runs, and a grant that did not land is
   * repaired by pressing 연결 again.
   */
  offerTo: (
    store: PartnerGrantStore,
    botId: string,
    ownerUserId: string,
    by: string,
  ) => Promise<void>;
};

export function createPartnerRuntime(input: {
  context: PartnerContext;
  database: Database;
  environment?: Record<string, string | undefined>;
}): PartnerRuntime {
  const environment = input.environment ?? process.env;
  const connections = createPartnerConnections(input.context);

  const hasAlimtalk = solapiSettings(environment) !== null;

  const alimtalk = hasAlimtalk
    ? createAlimtalkConnect(input.context, connections, environment)
    : null;

  const transports: Partial<Record<PartnerFamily, VendorTransport>> = {
    ...(hasAlimtalk
      ? { "kakao-alimtalk": createAlimtalkTools(connections, environment) }
      : {}),
  };

  const configured: readonly PartnerFamily[] = Object.freeze(
    (["kakao-alimtalk"] as const satisfies readonly PartnerFamily[]).filter(
      (family) => transports[family] !== undefined,
    ),
  );
  const toolsOf: PartnerRuntime["toolsOf"] = () => ALIMTALK_TOOLS;

  const grantTo: PartnerRuntime["grantTo"] = async (
    store,
    provider,
    botId,
    by,
  ) => {
    const held = new Set(
      (await store.listForAgent(botId)).tools.map((tool) => tool.ref),
    );
    for (const tool of toolsOf(provider)) {
      const ref = `${provider}/${tool.name}`;
      if (!held.has(ref)) await store.grant("mcp", ref, botId, by);
    }
  };

  return {
    connections,
    alimtalk,
    transports,
    configured,
    toolsOf,
    // The one definition, shared with the OAuth callback's own grant path: two expressions of
    // "their Bots" is how one of them quietly stops including hidden ones.
    botsOwnedBy: (userId) => botsOwnedBy(input.database, userId),
    grantTo,
    async offerTo(store, botId, ownerUserId, by) {
      for (const provider of configured) {
        try {
          // The registration is the person's own decision, and without one there is nothing to
          // extend: a configured key alone must not put 알림톡 in front of a Bot whose owner never
          // connected a channel.
          if (!(await connections.find(provider, ownerUserId))) continue;
          await grantTo(store, provider, botId, by);
        } catch (error) {
          log.error("partner_tools_not_offered", {
            provider,
            bot: botId,
            reason: error,
          });
        }
      }
    },
  };
}
