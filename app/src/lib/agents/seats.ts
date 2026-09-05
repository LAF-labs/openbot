import { t } from "@/lib/i18n";
import { AGENT_REFUSALS } from "./mutations";

/**
 * HOW MANY BOTS FIT, SAID BEFORE SOMEBODY RUNS OUT.
 *
 * One VM per person and five Bots on it (docs/laf/deployment-model.md). The number was only ever
 * spoken by a refusal: 새 봇 looked exactly the same on an empty account and on a full one, and the
 * first anybody heard of a limit was the sixth press failing. A count in the roster header costs
 * nothing and means the fifth Bot is made on purpose.
 *
 * Its own file, with no imports beyond the dictionary, so `auth/queries.ts` can read the default
 * without importing the roster and the roster can read it without importing the session.
 */

/** What a person gets when the deployment has not said otherwise. */
export const DEFAULT_BOT_SEATS = 5;

export type Seats = {
  /** Bots this person has, hidden ones included: a hidden Bot still occupies its seat. */
  used: number;
  total: number;
  isFull: boolean;
  /** One seat left. What Duplicate has to say out loud before it spends it. */
  isLastSeat: boolean;
};

export function seatsFrom(used: number, total = DEFAULT_BOT_SEATS): Seats {
  return {
    used,
    total,
    isFull: used >= total,
    isLastSeat: used === total - 1,
  };
}

/**
 * The sentence the server would answer with, said before asking rather than after.
 *
 * The same entry the refusal table holds, so being stopped by the screen and being stopped by the
 * server read identically — two sentences for one fact is how a person ends up believing they are
 * two different problems.
 */
export function seatsFullMessage(seats: Seats): string {
  return t(AGENT_REFUSALS["laf:seats_full"] as string, { seats: seats.total });
}
