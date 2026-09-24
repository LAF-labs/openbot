import { useEffect, useState } from "react";
import { watchControl } from "./control-poll";
import {
  type ControlState,
  lastControlState,
  onControlAnswered,
  rememberControlState,
} from "./take-the-wheel";

/**
 * Who has the wheel of a Bot's browser, on the one shared loop (`control-poll.ts`).
 *
 * `computerId` undefined is "not looking": nothing polls. `isLive` keeps the loop at its full pace
 * — a request for help that is waiting, a screen somebody is watching — instead of letting it
 * settle.
 *
 * AND WITHOUT WAITING FOR THE LOOP, where this tab already knows. A view starts from the last state
 * this tab was told, and hears a take or a release the moment it is answered (`take-the-wheel.ts`):
 * 직접 하기 in a card opens the screen, and the screen that mounts has to know at once that it is
 * being driven, or it is drawn watching and then swapped out under the person a second later.
 */
export function useControl(
  computerId: string | undefined,
  isLive: boolean,
): ControlState | null {
  const [state, setState] = useState<ControlState | null>(() =>
    computerId ? lastControlState(computerId) : null,
  );
  useEffect(() => {
    if (!computerId) return;
    const stopWatching = watchControl(computerId, {
      isLive: () => isLive,
      onState: (next) => {
        rememberControlState(computerId, next);
        setState(next);
      },
    });
    const stopHearing = onControlAnswered(computerId, setState);
    return () => {
      stopWatching();
      stopHearing();
    };
  }, [computerId, isLive]);
  return computerId ? state : null;
}
