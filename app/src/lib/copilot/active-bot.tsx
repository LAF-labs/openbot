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
  /** Point the holder at a Bot and announce it; what it returns puts back what it found. */
  declare: (botId: string | undefined) => () => void;
} | null>(null);

export function ActiveBotProvider({ children }: { children: ReactNode }) {
  /*
   * The holder IS the ref, handed down as it is. It used to be an object kept inside a ref and read
   * out of it while rendering, and the declared value was rebuilt into a ref on every render — reads
   * and writes of `.current` during render, which the React Compiler refuses to compile. The ref
   * object is the same object for the provider's whole life, so passing it on reads nothing.
   */
  const holder = useRef(DEFAULT_BOT_ID);
  /** The declared id as a ref, so unmount restores what it found rather than what it rendered with. */
  const held = useRef<string | undefined>(undefined);
  const [declared, setDeclared] = useState<string | undefined>(undefined);

  /*
   * The writes happen here, in the provider, rather than in `useActiveBot` reaching into a context
   * value to change it: what a context hands out is treated as read-only by the compiler, and the
   * provider is the one place that owns these refs.
   */
  const declare = useCallback((botId: string | undefined) => {
    const previousHeld = holder.current;
    const previousDeclared = held.current;
    holder.current = botId ?? DEFAULT_BOT_ID;
    held.current = botId;
    setDeclared(botId);
    return () => {
      holder.current = previousHeld;
      held.current = previousDeclared;
      setDeclared(previousDeclared);
    };
  }, []);
  const value = useMemo(() => ({ declared, declare }), [declared, declare]);

  return (
    <ActiveBotContext.Provider value={holder}>
      <ActiveBotValueContext.Provider value={value}>
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
  const declare = useContext(ActiveBotValueContext)?.declare;
  useEffect(() => declare?.(botId), [declare, botId]);
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

/**
 * Which conversation the surface in front of you is in, for the acting calls to name.
 *
 * A module-level holder rather than a context, because the two readers are `fetch` wrappers —
 * the computer's and the plugin call's — that run inside tool handlers with no render to read a
 * context from. The same reason the Bot is a ref: a handler outlives the render that registered
 * it. What it buys is the middle answer on the approval card: the server binds "for this
 * conversation" to the thread named here, and offers it only when one was.
 *
 * Undefined when no channel is open — the roster, Settings — and then no header is sent and every
 * question is asked in the standing terms alone, which is what every question was before.
 */
const conversation: { current: string | undefined } = { current: undefined };

/** Declare the conversation this surface is in, for as long as it is mounted. */
export function useActiveConversation(threadId: string | undefined): void {
  useEffect(() => {
    const previous = conversation.current;
    conversation.current = threadId;
    return () => {
      conversation.current = previous;
    };
  }, [threadId]);
}

/**
 * The header the server reads the current conversation from, so an answer can be "for this
 * conversation". Sent on every acting call the surface makes while a channel is open; absent, the
 * question is asked in the standing terms alone. Mirrors `THREAD_HEADER` in
 * `server/src/computer/gateway/caller.ts`.
 */
const THREAD_HEADER = "x-openbot-thread-id";

/** The conversation the surface in front of you is in, or undefined outside one. */
export function activeConversationId(): string | undefined {
  return conversation.current;
}

/** The header naming the conversation, or nothing when no surface has declared one. */
export function activeConversationHeaders(): Record<string, string> {
  return conversation.current ? { [THREAD_HEADER]: conversation.current } : {};
}
