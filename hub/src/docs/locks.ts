import { HUB_DOC_LOCK_TTL_MS } from "../../../shared/hub/protocol";

/**
 * WHO IS WRITING IN WHICH BLOCK ("쓰는 중"), IN MEMORY.
 *
 * Not a table: a hold lives fifteen seconds unless its editor renews it every five, so a table would
 * take a write every five seconds for every person with a block open — on a hub with one core, for
 * a fact nobody needs after a restart. The hub is one process (as a person's VM is,
 * `docs/laf/deployment-model.md`), so one map is every hold there is. A restart forgets them, and
 * nothing is lost: each editor's next renewal, at most five seconds later, takes its hold again, and
 * a save never depended on a hold — it carries the version its writer read.
 *
 * Expired holds are not swept on a timer. Each read drops what it finds expired, so the map holds
 * at most the blocks touched in the last fifteen seconds plus whatever was never read again — a
 * handful per person.
 */
export type DocHold = { member: string; name: string | null; until: number };

export type TakeResult =
  | { ok: true; hold: DocHold }
  | { ok: false; holder: DocHold };

export function createDocLocks(now: () => number = Date.now) {
  const docs = new Map<string, Map<string, DocHold>>();

  const live = (doc: string, block: string): DocHold | null => {
    const blocks = docs.get(doc);
    const hold = blocks?.get(block);
    if (!blocks || !hold) return null;
    if (hold.until <= now()) {
      blocks.delete(block);
      if (blocks.size === 0) docs.delete(doc);
      return null;
    }
    return hold;
  };

  return {
    /** Takes or renews `member`'s hold; refused while somebody else's stands. */
    take(
      doc: string,
      block: string,
      member: string,
      name: string | null,
    ): TakeResult {
      const held = live(doc, block);
      if (held && held.member !== member) return { ok: false, holder: held };
      const hold = { member, name, until: now() + HUB_DOC_LOCK_TTL_MS };
      let blocks = docs.get(doc);
      if (!blocks) {
        blocks = new Map();
        docs.set(doc, blocks);
      }
      blocks.set(block, hold);
      return { ok: true, hold };
    },
    /** Lets go of `member`'s own hold; true when there was one. Somebody else's is left standing. */
    release(doc: string, block: string, member: string): boolean {
      const held = live(doc, block);
      if (!held || held.member !== member) return false;
      docs.get(doc)?.delete(block);
      if (docs.get(doc)?.size === 0) docs.delete(doc);
      return true;
    },
    /** The standing hold on a block, or null. */
    holder(doc: string, block: string): DocHold | null {
      return live(doc, block);
    },
    /** Every standing hold in a document. */
    standing(doc: string): { block: string; hold: DocHold }[] {
      const blocks = docs.get(doc);
      if (!blocks) return [];
      const out: { block: string; hold: DocHold }[] = [];
      for (const block of [...blocks.keys()]) {
        const hold = live(doc, block);
        if (hold) out.push({ block, hold });
      }
      return out;
    },
    /** A deleted block or document holds nothing. */
    forget(doc: string, block?: string): void {
      if (block === undefined) docs.delete(doc);
      else docs.get(doc)?.delete(block);
    },
  };
}

export type DocLocks = ReturnType<typeof createDocLocks>;
