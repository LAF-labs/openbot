/**
 * The tools a deployment has because the fleet holds a key — assembled, and kept in front of every
 * Bot on the machine.
 *
 * This was the bottom half of `public-data-rest.ts` while there was one such entry. There are more
 * now (the web, searched; the weather, from 기상청), and each is the same four facts — a catalogue
 * entry, the key family behind it, the tools, the transport that spends the key — put through the
 * same boot-time reconciliation: with the key, the row exists, its tools are current and every Bot
 * holds a grant on each; without it, none of that is left standing. A second copy of that loop per
 * vendor would be the copies drifting on the order of a revoke, which is the one thing here that
 * must not.
 */
import type { Whereabouts } from "../../../shared/whereabouts";
import { describeFailure } from "../failure-text";
import { log } from "../log";
import type { DeploymentKeyFamily } from "./catalogue";
import type { PartnerToolSpec } from "./partner-tools";
import { type DeploymentKeyLookup, keyLookupOver } from "./shared-clients";
import type { PluginStore } from "./store";
import type { VendorTransport } from "./transport";

/**
 * Where the person a call is for has said they are — the one fact about a person any of these
 * tools reads, and only the weather does: "오늘 날씨" names no place, and the answer is for theirs.
 * A reader and not the store: a transport that could write a place would be a tool that could.
 */
export type WhereaboutsReader = (
  userId: string,
) => Promise<Pick<Whereabouts, "place" | "coordinates">>;

/** One entry of this kind: what it is called, whose key it spends, what it offers and how. */
export type DeploymentKeyService = {
  /** The catalogue entry the tools live under. Prefixes every tool ref: `public-data/search_bids`. */
  key: string;
  family: DeploymentKeyFamily;
  tools: readonly PartnerToolSpec[];
  /** Built once, and only on a deployment that was given the key. */
  transport: (input: {
    key: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    whereaboutsOf?: WhereaboutsReader;
  }) => VendorTransport;
};

/** The slice of the store the reconciliation needs, so a test hands in exactly that and no more. */
export type DeploymentKeyStore = Pick<
  PluginStore,
  | "ensureCatalogueServer"
  | "refreshTools"
  | "approveToolDefinition"
  | "grant"
  | "revoke"
  | "removeServer"
  | "listServers"
  | "listForAgent"
>;

export type DeploymentKeyRuntime = {
  /** Whether this VM was given the key behind a catalogue entry. False draws no entry and offers no tool. */
  has: (catalogueKey: string) => boolean;
  /** Every tool the keys this VM holds put in front of a Bot, by its bare name. */
  toolNames: string[];
  /** For the catalogue listing, which hides a deployment-key entry whose key is absent. */
  keys: DeploymentKeyLookup;
  /** For `createPluginStore`. A family with no key has no transport, and its entry refuses. */
  transports: Partial<Record<DeploymentKeyFamily, VendorTransport>>;
  /**
   * The row, the tools and a grant on each for every Bot on this machine — or, with no key, every
   * one of those taken back. Run at boot; idempotent; never throws.
   */
  reconcile: (store: DeploymentKeyStore, by: string) => Promise<void>;
  /** A Bot that has just come into being gets the tools, if the key is here. Never throws. */
  offerTo: (
    store: DeploymentKeyStore,
    botId: string,
    by: string,
  ) => Promise<void>;
};

export function createDeploymentKeyRuntime(input: {
  keys: Partial<Record<DeploymentKeyFamily, string>>;
  services: readonly DeploymentKeyService[];
  /** Every live Bot on this deployment, whoever owns it: the set the tools are offered to. */
  listBots: () => Promise<string[]>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Absent in a test that asks about no person; then a call naming no place is told nobody's is known. */
  whereaboutsOf?: WhereaboutsReader;
}): DeploymentKeyRuntime {
  const held = input.services.filter((service) => input.keys[service.family]);
  const transports: Partial<Record<DeploymentKeyFamily, VendorTransport>> = {};
  for (const service of held) {
    transports[service.family] = service.transport({
      key: input.keys[service.family] as string,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.whereaboutsOf ? { whereaboutsOf: input.whereaboutsOf } : {}),
    });
  }

  const refsOf = (service: DeploymentKeyService) =>
    service.tools.map((tool) => `${service.key}/${tool.name}`);

  /** What a Bot holds now, by ref. */
  const heldBy = async (store: DeploymentKeyStore, botId: string) =>
    new Set((await store.listForAgent(botId)).tools.map((tool) => tool.ref));

  /** Only the grants a Bot does not already hold: a boot must not rewrite ten rows of trail. */
  async function grantMissing(
    store: DeploymentKeyStore,
    service: DeploymentKeyService,
    botId: string,
    by: string,
  ) {
    const holding = await heldBy(store, botId);
    for (const ref of refsOf(service)) {
      if (!holding.has(ref)) await store.grant("mcp", ref, botId, by);
    }
  }

  async function revokeHeld(
    store: DeploymentKeyStore,
    service: DeploymentKeyService,
    botId: string,
    by: string,
  ) {
    const holding = await heldBy(store, botId);
    for (const ref of refsOf(service)) {
      if (holding.has(ref)) await store.revoke("mcp", ref, botId, by);
    }
  }

  const failed = (what: string, error: unknown) =>
    log.error("deployment_key_not_reconciled", {
      what,
      reason: describeFailure(error),
    });

  /** One entry, put right. Its own try: a vendor's row that will not reconcile stops no other. */
  async function reconcileOne(
    store: DeploymentKeyStore,
    service: DeploymentKeyService,
    rows: ReadonlySet<string>,
    by: string,
  ) {
    try {
      if (!held.includes(service)) {
        /*
         * A key taken away after the row was made. The grants go first, then the row — the same
         * order a partner disconnect keeps, so no Bot holds a grant on a tool that still exists.
         */
        if (!rows.has(service.key)) return;
        for (const botId of await input.listBots()) {
          await revokeHeld(store, service, botId, by);
        }
        await store.removeServer(service.key, by);
        return;
      }

      await store.ensureCatalogueServer({ key: service.key, by });
      const refreshed = await store.refreshTools(service.key);
      /*
       * A definition that changed since the row was made is paused by the refresh for a person to
       * review — right for somebody else's server, and a dead tool here, because the definition is
       * this repository's own reviewed code and nobody is going to press Approve on every shop
       * owner's machine after every upgrade. The trail still records the change and the
       * acceptance, one row each.
       */
      if ((refreshed.paused ?? 0) > 0) {
        for (const tool of service.tools) {
          await store.approveToolDefinition(service.key, tool.name, by);
        }
      }
      for (const botId of await input.listBots()) {
        await grantMissing(store, service, botId, by);
      }
    } catch (error) {
      failed(`reconcile ${service.key}`, error);
    }
  }

  return {
    has: (catalogueKey) => held.some((service) => service.key === catalogueKey),
    toolNames: held.flatMap((service) =>
      service.tools.map((tool) => tool.name),
    ),
    keys: keyLookupOver(input.keys),
    transports,

    async reconcile(store, by) {
      let rows: Set<string>;
      try {
        rows = new Set((await store.listServers()).map((server) => server.id));
      } catch (error) {
        failed("reconcile", error);
        return;
      }
      for (const service of input.services) {
        await reconcileOne(store, service, rows, by);
      }
    },

    async offerTo(store, botId, by) {
      for (const service of held) {
        try {
          await grantMissing(store, service, botId, by);
        } catch (error) {
          failed(`offer ${service.key} to ${botId}`, error);
        }
      }
    },
  };
}
