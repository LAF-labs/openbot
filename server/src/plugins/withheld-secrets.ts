import { randomInt } from "node:crypto";
import type { WithheldKind } from "../../../shared/tools/withheld";

/**
 * The codes and account links taken out of a mail, kept a short while for the one person who can
 * be shown them.
 *
 * IN MEMORY ON PURPOSE. One API process per VM (docs/laf/deployment-model.md), so the process that
 * withheld a value is the process the owner's 보기 reaches; and a restart losing everything here is
 * the right failure — a one-time code is worth minutes, and a reset link that outlives the process
 * that saw it is a key nobody needs lying around. Nothing here is written to a disk, a log or a row.
 *
 * Every value is kept for the Bot that read the mail AND the person whose call it was, and read back
 * only by both: a colleague who can name the id — it is in the conversation — gets nothing, and so
 * does the same person asking as another Bot.
 */

/**
 * The one answer to a reveal that finds nothing: expired, never kept, or not this person's to see.
 * One code for all three, so the answer does not say which ids exist for somebody else.
 */
export const WITHHELD_GONE = "laf:withheld_gone";

/** How long a withheld value can be shown. A code is usually dead in three to ten minutes. */
export const WITHHELD_TTL_MS = 15 * 60_000;

/** How many are held at once. The oldest go first; nobody reads mail at that rate on purpose. */
const MAX_KEPT = 500;

/** A reference: twelve letters and digits, so no code can ever be found inside one. */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const mintReference = () =>
  Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
    "",
  );

type Kept = {
  botId: string;
  actorId: string;
  kind: WithheldKind;
  value: string;
  expiresAt: number;
};

export type WithheldSecrets = {
  /** Hold one value for this Bot and this person; the reference the mark in the result carries. */
  keep(input: {
    botId: string;
    actorId: string;
    kind: WithheldKind;
    value: string;
  }): string;
  /** The value, for exactly the Bot and person it was kept for, while it lasts; otherwise null. */
  reveal(
    id: string,
    who: { botId: string; actorId: string },
  ): { kind: WithheldKind; value: string; expiresAt: string } | null;
};

export function createWithheldSecrets(
  options: { ttlMs?: number; max?: number; now?: () => number } = {},
): WithheldSecrets {
  const ttl = options.ttlMs ?? WITHHELD_TTL_MS;
  const max = options.max ?? MAX_KEPT;
  const now = options.now ?? Date.now;
  const kept = new Map<string, Kept>();

  const sweep = (at: number) => {
    for (const [id, item] of kept) {
      if (item.expiresAt <= at) kept.delete(id);
    }
  };

  return {
    keep(input) {
      const at = now();
      sweep(at);
      // A Map iterates in insertion order, so the first key is the oldest.
      while (kept.size >= max) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) break;
        kept.delete(oldest);
      }
      let id = mintReference();
      while (kept.has(id)) id = mintReference();
      kept.set(id, { ...input, expiresAt: at + ttl });
      return id;
    },

    reveal(id, who) {
      const item = kept.get(id);
      if (!item) return null;
      if (item.expiresAt <= now()) {
        kept.delete(id);
        return null;
      }
      if (item.botId !== who.botId || item.actorId !== who.actorId) {
        return null;
      }
      return {
        kind: item.kind,
        value: item.value,
        expiresAt: new Date(item.expiresAt).toISOString(),
      };
    },
  };
}
