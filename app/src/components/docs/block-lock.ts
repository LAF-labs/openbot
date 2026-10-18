/**
 * "쓰는 중": the hold this person has on the one block they are writing in (design §5).
 *
 * TAKEN ON FOCUS, RENEWED EVERY FIVE SECONDS, LET GO ON LEAVE. The hub keeps a hold only a short
 * while past its last renewal, so a closed laptop or a crashed tab frees the block on its own; a
 * tab that is still open says so every `RENEW_MS`. Moving to another block lets go of the first
 * before taking the second — a person holds at most one block — and leaving the document (blur,
 * unmount, the page hidden) lets go of whatever is held.
 *
 * A HOLD CAN BE LOST. A renewal that is refused (somebody else holds it now: the tab slept past
 * the hold's end) says so through `onLost`, and the editor stops writing in that block rather than
 * saving over a colleague. A renewal that simply fails (the hub is not answering) keeps trying on
 * the next tick: the save carries the block's version, so nothing can be overwritten meanwhile.
 *
 * The clock is handed in so a test can drive it (`app/tests/doc-block-lock.test.ts`).
 */
export const RENEW_MS = 5_000;

export type LockAnswer = "held" | "busy" | "gone" | "failed";

export type LockDoors = {
  acquire: (blockId: string) => Promise<LockAnswer>;
  release: (blockId: string) => Promise<void>;
};

export type LockClock = {
  setInterval: (run: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

const REAL_CLOCK: LockClock = {
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

export type BlockLock = {
  /** Hold `blockId`, letting go of any other first. Answers what the hub said. */
  hold: (blockId: string) => Promise<LockAnswer>;
  /** Let go of whatever is held. */
  release: () => void;
  /** The block held now, or null. */
  held: () => string | null;
};

export function createBlockLock(
  doors: LockDoors,
  onLost: (blockId: string) => void,
  clock: LockClock = REAL_CLOCK,
): BlockLock {
  let current: string | null = null;
  let timer: unknown = null;
  /** Bumped on every hold and release, so an answer that arrives late for an old hold is ignored. */
  let turn = 0;

  const stop = () => {
    if (timer !== null) clock.clearInterval(timer);
    timer = null;
  };

  const release = () => {
    turn += 1;
    stop();
    const was = current;
    current = null;
    if (was) void doors.release(was).catch(() => {});
  };

  const hold = async (blockId: string): Promise<LockAnswer> => {
    if (current === blockId && timer !== null) return "held";
    release();
    const mine = turn;
    current = blockId;
    const answer = await doors.acquire(blockId).catch(() => "failed" as const);
    if (mine !== turn) {
      // Released or moved on while the hub answered: a hold won meanwhile is given back.
      if (answer === "held") void doors.release(blockId).catch(() => {});
      return answer;
    }
    if (answer === "busy" || answer === "gone") {
      current = null;
      return answer;
    }
    // "failed" keeps trying: the hub may be back on the next tick, and saving still checks version.
    timer = clock.setInterval(() => {
      if (mine !== turn) return;
      void doors
        .acquire(blockId)
        .catch(() => "failed" as const)
        .then((renewed) => {
          if (mine !== turn) return;
          if (renewed === "busy" || renewed === "gone") {
            stop();
            current = null;
            onLost(blockId);
          }
        });
    }, RENEW_MS);
    return answer;
  };

  return { hold, release, held: () => current };
}
