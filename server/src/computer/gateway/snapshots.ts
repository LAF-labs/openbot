/**
 * What this server believes is on each computer's screen, and the two reads that tell it.
 *
 * The refs a Bot sends mean something only against the snapshot this process took, so this is the
 * state every decision about an element or a page is made against — and the state a restart
 * empties. It is kept apart from the decision itself because the decision's most important refusal,
 * the blind action, is a question about this state rather than a part of it.
 */
import type { AuditStore } from "../../audit";
import { log } from "../../log";
import type { ComputerClient } from "../client";
import type {
  ReadOptions,
  ReadResult,
  SnapshotElement,
  SnapshotResult,
} from "../schema";
import type { ActionActor } from "./caller";
import { writeSnapshotRow } from "./trail";

/**
 * The last snapshot the server took, per computer.
 *
 * In memory. It describes the live contents of a browser window, so it is
 * meaningless the moment the process holding that window restarts. Persisting it would create a cache
 * that can disagree with the page, which is worse than not having one: the refs would resolve to names
 * that are no longer on screen and the policy would decide on fiction.
 */
export type CachedSnapshot = {
  snapshotId: number;
  elements: Map<string, SnapshotElement>;
  url: string;
  /**
   * The browser has moved since this was taken, and only the address is still believed.
   *
   * THE CACHE WAS NEVER INVALIDATED. `snapshots.set` ran in exactly one place — `snapshot()` — and
   * nothing else touched it: not a navigation, not a click that followed a link, not a tab switch.
   * So `page.host`, the audit row's `page` and the scope printed on an "always allow" button all
   * described whatever page was last SNAPSHOTTED, however many pages ago that was. Measured as a
   * sequence: snapshot on example.com, navigate to a bank, press Enter with no ref — the money-host
   * rule looked at `example.com` and let it through.
   *
   * A stale entry keeps the address the browser reported and no elements, so a rule about the host
   * sees the right host and an action that needs the screen is refused as blind until the Bot
   * looks again — which is what the tool results already tell it to do.
   */
  stale: boolean;
};

export function createSnapshotCache() {
  const snapshots = new Map<string, CachedSnapshot>();

  /**
   * The browser is somewhere else now: keep the address, forget the elements.
   *
   * Called with every URL an action or a navigation reports back, so the cache follows the browser
   * rather than the last snapshot. The same address as the cache holds is not a move — unless the
   * computer says the page's generation moved under it (`NavigateResult.generation`): a tab that
   * opened on the same address, a document reloaded in place, a hand-back after a takeover. The
   * generation the computer named is kept, because it is the one the next ref-less key is held to.
   */
  function pageMoved(
    computerId: string,
    url: string,
    generation?: number,
  ): void {
    const cached = snapshots.get(computerId);
    if (
      cached &&
      cached.url === url &&
      (generation === undefined || generation === cached.snapshotId)
    ) {
      return;
    }
    snapshots.set(computerId, {
      snapshotId: generation ?? cached?.snapshotId ?? 0,
      url,
      elements: new Map(),
      stale: true,
    });
  }

  /**
   * What the server believed about the screen may be wrong now, and it does not know what is right:
   * a person handed the wheel back, the Bot's tabs were closed, or the computer refused a key held to
   * this generation. The address is kept for the trail; the elements are not trusted until the Bot
   * looks again.
   */
  function invalidate(computerId: string): void {
    const cached = snapshots.get(computerId);
    if (!cached || cached.stale) return;
    snapshots.set(computerId, { ...cached, elements: new Map(), stale: true });
  }

  /**
   * Resolve a ref against the snapshot the server holds.
   *
   * Returns undefined for an unknown ref rather than throwing, because the policy still has to run:
   * an action on an element we cannot identify must still receive a policy decision.
   * A deny rule written against a page a Bot has not snapshotted should still refuse it.
   */
  function resolve(
    computerId: string,
    ref: string | undefined,
  ): SnapshotElement | undefined {
    if (!ref) return undefined;
    return snapshots.get(computerId)?.elements.get(ref);
  }

  return {
    get: (computerId: string) => snapshots.get(computerId),
    set: (computerId: string, entry: CachedSnapshot) => {
      snapshots.set(computerId, entry);
    },
    pageMoved,
    invalidate,
    /**
     * Forget the computer's page altogether. After a reset the computer counts its generations from
     * nothing again, so a number kept from before would name a page that never existed there.
     */
    forget: (computerId: string) => {
      snapshots.delete(computerId);
    },
    resolve,
  };
}

export type SnapshotCache = ReturnType<typeof createSnapshotCache>;

export function createPageReads(deps: {
  /** The computer, addressed as the Bot that is asking. See `createComputerGateway`. */
  as: (botId: string) => ComputerClient;
  /** Where a look that could not see into a frame is written down. See `writeSnapshotRow`. */
  auditStore: AuditStore;
  snapshots: SnapshotCache;
  /**
   * The elements as they may enter this process, with the value of every secret field blanked.
   *
   * Handed in rather than imported, because what counts as a secret field includes the boxes a
   * person has typed one into, and that is the secret bookkeeping's to know. See `secrets.ts`.
   */
  withoutSecrets: (
    computerId: string,
    result: SnapshotResult,
  ) => SnapshotElement[];
}) {
  const { as, auditStore, snapshots, withoutSecrets } = deps;

  /**
   * Read-only, so it passes straight through. Nothing has changed and there is nothing to decide.
   *
   * `caller` is who looked, for the one kind of look the trail keeps: one that could not see into a
   * frame. Optional, because a look with nobody to name — a test, a warm-up — has nothing to write.
   */
  async function snapshot(
    computerId: string,
    caller?: { botId: string; actor: ActionActor },
  ): Promise<SnapshotResult> {
    const result = await as(computerId).snapshot();
    const elements = withoutSecrets(computerId, result);
    snapshots.set(computerId, {
      snapshotId: result.snapshotId,
      url: result.url,
      elements: new Map(elements.map((element) => [element.ref, element])),
      stale: false,
    });
    if (caller && (result.opaqueFrames ?? 0) > 0) {
      /*
       * Awaited and swallowed, like the repeat row: an observation must never refuse the look it is
       * about, and a trail that could not be reached is no reason for a Bot to be told its screen
       * could not be read.
       */
      try {
        await writeSnapshotRow(auditStore, {
          botId: caller.botId,
          actor: caller.actor,
          computerId,
          pageUrl: result.url,
          opaqueFrames: result.opaqueFrames ?? 0,
        });
      } catch (error) {
        log.error("computer_snapshot_row_lost", {
          bot: caller.botId,
          opaqueFrames: result.opaqueFrames,
          reason: error,
        });
      }
    }
    return { ...result, elements };
  }

  async function read(
    botId: string,
    options: ReadOptions = {},
  ): Promise<ReadResult> {
    const { generation, ...result } = await as(botId).read(options);
    snapshots.pageMoved(botId, result.url, generation);
    return result;
  }

  return { snapshot, read };
}
