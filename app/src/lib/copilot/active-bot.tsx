import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Which Bot the surface in front of you is for.
 *
 * The Bot's tools are registered once for each screen that runs a Bot (`provider.tsx`, which the
 * conversation, the compose screen and the playground each mount), but a grant, a card and a
 * request are one Bot's. The surface says which (`useActiveBot`), and what is drawn under it reads
 * the answer as state (`useDeclaredBotId`), so it is drawn again when the Bot is declared or
 * changes.
 *
 * THERE WAS A SECOND ANSWER, FOR HANDLERS, AND IT IS GONE. While a window carried the Bot's calls
 * out, a tool's handler outlived the render that registered it and read the Bot from a ref that
 * always held a string (`useActiveBotHolder`) — the sentinel `default` until a surface declared.
 * The server carries the calls out and takes the Bot from the turn (`server/src/turns/engine.ts`);
 * the handlers went with the window-driven path (2026-10-05), the holder with them, and the
 * sentinel with its last reader (`useActiveBotId`, which handed it to the row for a mail's code).
 *
 * UNDECLARED IS NOBODY, NOT A DEFAULT. `useDeclaredBotId` is `undefined` until a surface actually
 * says which Bot it is for, because a per-Bot request keyed on a stand-in is a request for a Bot
 * nobody has: the server answers an id this deployment has no Bot for 404 `laf:bot_not_found`
 * (`requireBotAccess`), and `agent-computer` refuses a call that names no Bot
 * (`laf:bot_header_missing`). Measured, when these tools were still mounted on every screen: on
 * Settings, on the admin screens and on the roster with nothing open, the components poll asked
 * `/api/components/for-agent/default` every five seconds and the plugin poll every fifteen, for
 * the life of the tab.
 *
 * AND IT IS UNDECLARED FOR A SURFACE'S WHOLE FIRST COMMIT. `useActiveBot` declares in an effect,
 * and a child's effects run before its parent's, so whatever is drawn under a surface as it mounts
 * renders, and runs its first effects, before the Bot is declared.
 *
 * SO A RENDERER NEVER HANDS A BOT DOWN AS A PROP. `computer-tools.tsx` did, to the help and the
 * secret card. A renderer is registered once and CopilotKit draws it through a memo that compares
 * the call and nothing else, so the string was read when the card was first drawn and never again.
 * Measured 2026-10-05 through the real route (`conversation-return.test.tsx`): a conversation drawn
 * again under a screen that had stayed — its channel could not be read for a moment, then could —
 * had its kept cards (`kept-threads.ts`) in that first commit, and the card asked
 * `/api/computers/default/control`, was told there is no such Bot, and stood with no buttons until
 * the Bot's wait ran out. Coming back from another screen did not do it, and was measured too: the
 * tools are mounted with the screen, so they are registered again in the effects of coming back, by
 * which time the Bot is declared. What needs the Bot while it is drawn reads `useDeclaredBotId`
 * itself and waits for it, as `HelpCard`, `ActivityReportCard` and `WithheldSecrets` do: that is
 * state, and declaring it draws them again.
 */

const ActiveBotValueContext = createContext<{
  declared: string | undefined;
  /** Say which Bot the surface is for; what it returns puts back what it found. */
  declare: (botId: string | undefined) => () => void;
} | null>(null);

export function ActiveBotProvider({ children }: { children: ReactNode }) {
  /** The declared id as a ref, so unmount restores what it found rather than what it rendered with. */
  const held = useRef<string | undefined>(undefined);
  const [declared, setDeclared] = useState<string | undefined>(undefined);

  /*
   * The writes happen here, in the provider, rather than in `useActiveBot` reaching into a context
   * value to change it: what a context hands out is treated as read-only by the compiler, and the
   * provider is the one place that owns the ref.
   */
  const declare = useCallback((botId: string | undefined) => {
    const previousDeclared = held.current;
    held.current = botId;
    setDeclared(botId);
    return () => {
      held.current = previousDeclared;
      setDeclared(previousDeclared);
    };
  }, []);
  const value = useMemo(() => ({ declared, declare }), [declared, declare]);

  return (
    <ActiveBotValueContext.Provider value={value}>
      {children}
    </ActiveBotValueContext.Provider>
  );
}

/**
 * Declare the Bot this surface drives, for as long as it is mounted.
 *
 * Restores what it found on unmount, so leaving a channel does not leave its Bot addressed by
 * whatever mounts next.
 */
export function useActiveBot(botId: string | undefined): void {
  const declare = useContext(ActiveBotValueContext)?.declare;
  useEffect(() => declare?.(botId), [declare, botId]);
}

/**
 * The active Bot, or nothing when no surface has declared one.
 *
 * What a query keys on, and what a card waits for: "is there a Bot in front of the person", which
 * often there is not.
 */
export function useDeclaredBotId(): string | undefined {
  return useContext(ActiveBotValueContext)?.declared;
}
