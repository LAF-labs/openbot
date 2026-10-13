import type { Tool } from "@ag-ui/core";
import {
  type ComponentType,
  createContext,
  createElement,
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { partialJSONParse } from "./partial-json";
import { type ToolSchema, toolJsonSchema } from "./tool-schema";

/**
 * THE WINDOW'S TOOLS AND WHAT DRAWS THEIR CALLS — THE APP'S OWN (2026-10-13).
 *
 * `@copilotkit/react-core` held this until then, and by then it held nothing else: a turn is the
 * server's (`server/src/turns/engine.ts`), no tool's handler runs in the page, and the client it
 * shipped — a runtime connection, a chat, a GraphQL client, an inspector — was 815 kB loaded on
 * the way to every conversation to keep two lists. These are the two lists:
 *
 * - THE TOOLS a turn is told this window offers (`buildFrontendTools`, read by
 *   `server-channel-chat.tsx` as a message is sent);
 * - THE RENDERERS the transcript draws a call through (`useRenderToolCall`,
 *   `chat-transcript.tsx`).
 *
 * The hooks keep the names and the behaviour they had, so what registers a tool reads as it did.
 * The behaviour is the contract, oddities included, because two things ride on it that nothing
 * may move: the bytes of the tool list (`tool-schema.ts`, `tests/tool-list-bytes.test.tsx`) and
 * what a person sees drawn. The oddities, each one measured against the library before it left:
 *
 * A REGISTRATION IS READ WHEN ITS NAME OR ITS `available` CHANGES, AND NOT OTHERWISE. A tool's
 * description, schema and renderer are the ones it had when it was last registered; a later render
 * with other words does not reach the list. That is what keeps a conversation's tools still while
 * a deployment edits a card's published description — the list a Bot was given at its head is the
 * list it keeps — so it is not "fixed" by listing the tool among the effect's dependencies.
 *
 * A TOOL REGISTERED AGAIN GOES TO THE END OF THE LIST. A card taken back from a Bot and given
 * again is offered last, after the cards that were never taken back.
 *
 * A RENDERER OUTLIVES ITS TOOL. A tool that leaves is no longer offered, and a call of it already
 * in the conversation is still drawn — except a decision's, which leaves with it.
 *
 * WHAT IS HANDED TO REACT IS NEVER CHANGED IN PLACE. The renderers a component reads are a new
 * list each time one is registered (`useSyncExternalStore`), so a component the React Compiler
 * memoises sees that it changed (CLAUDE.md, "The React Compiler compiles the app").
 */

/** Where a call stands: its arguments still arriving, or answered. */
export type ToolCallStatus = "inProgress" | "executing" | "complete";

/** What a call's renderer is handed. `args` are partial until the call is complete. */
export type ToolCallRenderProps<T> =
  | {
      name: string;
      toolCallId: string;
      args: Partial<T>;
      status: "inProgress";
      result: undefined;
    }
  | {
      name: string;
      toolCallId: string;
      args: T;
      status: "executing";
      result: undefined;
    }
  | {
      name: string;
      toolCallId: string;
      args: T;
      status: "complete";
      result: string;
    };

export type FrontendTool<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  name: string;
  description?: string;
  parameters?: ToolSchema<T>;
  /** False keeps the registration and leaves the tool out of what a turn is offered. */
  available?: boolean;
  /** Drawn as a component, so it may use hooks. */
  render?: ComponentType<ToolCallRenderProps<T>>;
};

/** A decision card: a tool whose renderer is also told its own name and description. */
export type HumanInTheLoopTool<
  T extends Record<string, unknown> = Record<string, unknown>,
> = Omit<FrontendTool<T>, "render"> & {
  // biome-ignore lint/suspicious/noExplicitAny: the cards take the props whole and read them themselves.
  render: ComponentType<any>;
};

// biome-ignore lint/suspicious/noExplicitAny: the registry holds tools of every argument shape.
type AnyTool = FrontendTool<any>;
// biome-ignore lint/suspicious/noExplicitAny: and their renderers.
type AnyRender = ComponentType<any>;

type Renderer = { readonly name: string; readonly render: AnyRender };

export type ToolRegistry = {
  hasTool: (name: string) => boolean;
  addTool: (tool: AnyTool) => void;
  removeTool: (name: string) => void;
  setRenderer: (name: string, render: AnyRender) => void;
  removeRenderer: (name: string) => void;
  /** The renderers as they stand: the same list until one changes, then a new one. */
  renderers: () => readonly Renderer[];
  subscribe: (changed: () => void) => () => void;
  /** The tools a turn is offered, as the server is sent them. */
  buildFrontendTools: (agentId?: string) => Tool[];
};

export function createToolRegistry(): ToolRegistry {
  let tools: readonly AnyTool[] = [];
  /** Keyed by name; a name registered again keeps its place. */
  const byName = new Map<string, Renderer>();
  let renderers: readonly Renderer[] = [];
  const listeners = new Set<() => void>();

  const renderersChanged = () => {
    renderers = Object.freeze([...byName.values()]);
    for (const changed of [...listeners]) changed();
  };

  return {
    hasTool: (name) => tools.some((tool) => tool.name === name),
    addTool: (tool) => {
      if (tools.some((held) => held.name === tool.name)) return;
      tools = [...tools, tool];
    },
    removeTool: (name) => {
      tools = tools.filter((tool) => tool.name !== name);
    },
    setRenderer: (name, render) => {
      byName.set(name, { name, render });
      renderersChanged();
    },
    removeRenderer: (name) => {
      if (byName.delete(name)) renderersChanged();
    },
    renderers: () => renderers,
    subscribe: (changed) => {
      listeners.add(changed);
      return () => {
        listeners.delete(changed);
      };
    },
    buildFrontendTools: () =>
      tools
        .filter((tool) => tool.available !== false)
        .map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters: toolJsonSchema(tool.parameters),
        })),
  };
}

const RegistryContext = createContext<ToolRegistry | null>(null);

/** One registry for the screens under it, made once and kept for as long as they are mounted. */
export function ToolRegistryProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(createToolRegistry);
  return (
    <RegistryContext.Provider value={registry}>
      {children}
    </RegistryContext.Provider>
  );
}

function useRegistry(): ToolRegistry {
  const registry = useContext(RegistryContext);
  if (!registry) {
    throw new Error("The tool registry is read outside its provider.");
  }
  return registry;
}

/**
 * The registry, for asking which tools this window offers. Named as it was, and shaped as it was
 * (`copilotkit.buildFrontendTools`), for the one screen that asks.
 */
export function useCopilotKit(): { copilotkit: ToolRegistry } {
  const registry = useRegistry();
  return useMemo(() => ({ copilotkit: registry }), [registry]);
}

const NO_DEPS: ReadonlyArray<unknown> = [];

/**
 * Offer a tool, and draw its calls with `render` when it has one.
 *
 * Read again only when the name, `available` or `deps` change (see the head of this file).
 */
export function useFrontendTool<
  T extends Record<string, unknown> = Record<string, unknown>,
>(tool: FrontendTool<T>, deps?: ReadonlyArray<unknown>): void {
  const registry = useRegistry();
  const extra = JSON.stringify(deps ?? NO_DEPS);
  const { name, available } = tool;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the registration is read when its name or `available` changes and not otherwise — see the head of this file. `tool` is a new object on every render, and following it would move a conversation's tool list mid-conversation.
  useEffect(() => {
    if (registry.hasTool(name)) {
      console.warn(
        `The tool ${name} is registered twice; the later registration is the one offered.`,
      );
      registry.removeTool(name);
    }
    registry.addTool(tool);
    if (tool.render) registry.setRenderer(name, tool.render);
    return () => {
      registry.removeTool(name);
    };
  }, [name, available, registry, extra]);
}

/**
 * Draw the calls of a tool this window does not offer — one answered somewhere else, like `now`.
 * The renderer stays for as long as the registry does, so a call in the history is still drawn.
 */
export function useRenderTool<S extends ToolSchema>(
  config: {
    name: string;
    parameters: S;
    render: (props: {
      name: string;
      toolCallId: string;
      /** The call's arguments, as far as they have been written. */
      parameters: Record<string, unknown>;
      status: ToolCallStatus;
      result: string | undefined;
    }) => ReactElement;
  },
  deps?: ReadonlyArray<unknown>,
): void {
  const registry = useRegistry();
  const extra = JSON.stringify(deps ?? NO_DEPS);
  const { name } = config;
  // biome-ignore lint/correctness/useExhaustiveDependencies: registered once per name, as a tool is — see the head of this file.
  useEffect(() => {
    const render = config.render;
    registry.setRenderer(
      name,
      (props: ToolCallRenderProps<Record<string, unknown>>) =>
        render({ ...props, parameters: props.args }),
    );
  }, [name, registry, extra]);
}

/**
 * Offer a decision card. It is a tool like any other — the answer goes to the server by the
 * card's own door (`@/lib/turns/answers`), never through a handler in the page — whose renderer is
 * also told the tool's name and description, and whose renderer leaves when the card does.
 *
 * `respond` is always undefined here: it was a way to answer a tool the page itself was running,
 * and the page runs none.
 */
export function useHumanInTheLoop<
  T extends Record<string, unknown> = Record<string, unknown>,
>(tool: HumanInTheLoopTool<T>, deps?: ReadonlyArray<unknown>): void {
  const registry = useRegistry();
  const { name, description, render: Card } = tool;
  const Render = useCallback(
    (props: ToolCallRenderProps<T>) =>
      createElement(Card, {
        ...props,
        name,
        description: description || "",
        agentId: undefined,
        respond: undefined,
      }),
    [Card, name, description],
  );
  useFrontendTool<T>({ ...tool, render: Render }, deps);
  useEffect(() => {
    return () => {
      registry.removeRenderer(name);
    };
  }, [registry, name]);
}

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
/** A call's answer. Only its words are read; the rest is the message it came in. */
type ToolMessage = {
  id?: string;
  role?: string;
  toolCallId?: string;
  content: string;
};

type CallProps = {
  toolCall: ToolCall;
  toolMessage?: ToolMessage | undefined;
  Render: AnyRender;
};

/**
 * One call, drawn. Its arguments are read as far as they have been written (`partial-json.ts`):
 * a card grows as the Bot writes it. Drawn again only when what it shows has changed — a
 * transcript of five hundred rows is not redrawn for one row's next chunk.
 */
const DrawnCall = memo(
  function DrawnCall({ toolCall, toolMessage, Render }: CallProps) {
    const written = toolCall.function.arguments;
    const args = useMemo(() => partialJSONParse(written), [written]);
    return (
      <Render
        args={args}
        name={toolCall.function.name}
        result={toolMessage ? toolMessage.content : undefined}
        status={toolMessage ? "complete" : "inProgress"}
        toolCallId={toolCall.id}
      />
    );
  },
  (before, after) =>
    before.toolCall.id === after.toolCall.id &&
    before.toolCall.function.name === after.toolCall.function.name &&
    before.toolCall.function.arguments === after.toolCall.function.arguments &&
    before.toolMessage?.content === after.toolMessage?.content &&
    before.Render === after.Render,
);

/**
 * What draws a call: the renderer registered under its name, or nothing — and then the transcript
 * draws its own plain line (`chat-transcript.tsx`).
 */
export function useRenderToolCall(): (call: {
  toolCall: ToolCall;
  toolMessage?: ToolMessage | undefined;
}) => ReactElement | null {
  const registry = useRegistry();
  const renderers = useSyncExternalStore(
    registry.subscribe,
    registry.renderers,
    registry.renderers,
  );
  return useCallback(
    ({ toolCall, toolMessage }) => {
      const found = renderers.find(
        (renderer) => renderer.name === toolCall.function.name,
      );
      if (!found) return null;
      return (
        <DrawnCall
          key={toolCall.id}
          Render={found.render}
          toolCall={toolCall}
          toolMessage={toolMessage}
        />
      );
    },
    [renderers],
  );
}
