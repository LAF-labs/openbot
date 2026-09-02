import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Which Bot the surface in front of you is driving.
 *
 * The computer tools are registered once for the whole app, but a computer belongs to a Bot, and a supervisor gives
 * each one its own browser profile and its own egress, and the server picks which by the id in the
 * URL.
 *
 * Tool handlers read the ref because a handler outlives the render that registered it. Components
 * read state because grants and renderers must re-render when the active Bot changes.
 *
 * DECLARED AND HELD ARE TWO DIFFERENT ANSWERS. `useActiveBotHolder` always has a string, because
 * `x-openbot-bot-id` must carry one and `agent-computer` falls back to its own default when it does
 * not. `useDeclaredBotId` is `undefined` until a surface actually says which Bot it drives, because
 * a per-Bot grant query keyed on the sentinel is a request for the grants of a Bot nobody has —
 * measured: on Settings, on the admin screens and on the roster with nothing open, the components
 * poll asked `/api/components/for-agent/default` every five seconds and the plugin poll every
 * fifteen, for the life of the tab.
 */

const DEFAULT_BOT_ID = "default";

type BotHolder = { current: string };

const ActiveBotContext = createContext<BotHolder | null>(null);
const ActiveBotValueContext = createContext<{
  declared: string | undefined;
  /** The declared id as a ref, so unmount restores what it found rather than what it rendered with. */
  held: { current: string | undefined };
  announce: (botId: string | undefined) => void;
} | null>(null);

export function ActiveBotProvider({ children }: { children: ReactNode }) {
  const holder = useRef<BotHolder>({ current: DEFAULT_BOT_ID });
  const held = useRef<string | undefined>(undefined);
  const [declared, setDeclared] = useState<string | undefined>(undefined);
  const value = useRef({ declared, held, announce: setDeclared });
  value.current = { declared, held, announce: setDeclared };

  return (
    <ActiveBotContext.Provider value={holder.current}>
      <ActiveBotValueContext.Provider value={value.current}>
        {children}
      </ActiveBotValueContext.Provider>
    </ActiveBotContext.Provider>
  );
}

/**
 * Declare the Bot this surface drives, for as long as it is mounted.
 *
 * Restores what it found on unmount, so leaving a channel does not leave its Bot addressed by
 * whatever mounts next.
 */
export function useActiveBot(botId: string | undefined): void {
  const holder = useContext(ActiveBotContext);
  const value = useContext(ActiveBotValueContext);
  useEffect(() => {
    if (!holder || !value) return;
    const previousHeld = holder.current;
    const previousDeclared = value.held.current;
    holder.current = botId ?? DEFAULT_BOT_ID;
    value.held.current = botId;
    value.announce(botId);
    return () => {
      holder.current = previousHeld;
      value.held.current = previousDeclared;
      value.announce(previousDeclared);
    };
  }, [holder, value, botId]);
}

/** The holder itself, to be read inside a handler at the moment it runs. */
export function useActiveBotHolder(): BotHolder {
  return useContext(ActiveBotContext) ?? { current: DEFAULT_BOT_ID };
}

/** The active Bot as a value, for anything that has to re-render when it changes. */
export function useActiveBotId(): string {
  return useContext(ActiveBotValueContext)?.declared ?? DEFAULT_BOT_ID;
}

/**
 * The active Bot, or nothing when no surface has declared one.
 *
 * What a query keys on. `useActiveBotId` answers "which computer does this act on", which always
 * has an answer; this answers "is there a Bot in front of the person", which often does not.
 */
export function useDeclaredBotId(): string | undefined {
  return useContext(ActiveBotValueContext)?.declared;
}
