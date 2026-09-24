import { useEffect, useState } from "react";
import { watchControl } from "./control-poll";
import type { ControlState } from "./take-the-wheel";

/**
 * Who has the wheel of a Bot's browser, on the one shared loop (`control-poll.ts`).
 *
 * `computerId` undefined is "not looking": nothing polls. `isLive` keeps the loop at its full pace
 * — a request for help that is waiting, a screen somebody is watching — instead of letting it
 * settle.
 */
export function useControl(
  computerId: string | undefined,
  isLive: boolean,
): ControlState | null {
  const [state, setState] = useState<ControlState | null>(null);
  useEffect(() => {
    if (!computerId) return;
    return watchControl(computerId, {
      isLive: () => isLive,
      onState: setState,
    });
  }, [computerId, isLive]);
  return computerId ? state : null;
}
