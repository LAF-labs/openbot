import { useEffect, useState } from "react";
import { readControl } from "./take-the-wheel";

/**
 * Poll closed screens for control/secret prompts so blocked Bots can surface outside the screen.
 */

const INTERVAL_MS = 3_000;

export function useNeedsYou(botId: string | undefined, when: boolean): boolean {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    if (!botId || !when) {
      setNeeded(false);
      return;
    }

    let live = true;
    const check = async () => {
      const read = await readControl(botId).catch(() => null);
      if (!live) return;
      // A deployment with no computer has no wheel to need anybody at. Stop asking.
      if (read?.absent) {
        clearInterval(timer);
        setNeeded(false);
        return;
      }
      const state = read?.state ?? null;
      setNeeded(
        Boolean(state && (state.requested || state.secretWanted !== undefined)),
      );
    };

    const timer = setInterval(() => void check(), INTERVAL_MS);
    void check();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [botId, when]);

  return needed;
}
