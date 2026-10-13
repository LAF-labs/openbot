import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as z from "zod";
import { type Mounted, mount, unmountAll } from "./support/mount";

/**
 * THE APP'S OWN TOOL REGISTRY (`src/lib/copilot/tool-registry.tsx`).
 *
 * It replaced `@copilotkit/react-core` on 2026-10-13 behind the same hooks, and what it does is
 * held here as behaviour: which tools a turn is offered and in what order, what a call is drawn
 * with while its arguments arrive and once it is answered, and what stays when a tool leaves. The
 * bytes of the list for the real tools are `tool-list-bytes.test.tsx`'s.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3113/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(unmountAll);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Registry = typeof import("../src/lib/copilot/tool-registry");
const registry = (): Promise<Registry> =>
  import("../src/lib/copilot/tool-registry");

const TAKES_A_TITLE = z.object({ title: z.string() });

type Offer = { name: string; description?: string; available?: boolean };

/** A screen that offers `tools`, draws `calls`, and hands out what a turn would be sent. */
async function screen(
  first: Offer[],
  calls: { id: string; name: string; args: string; result?: string }[] = [],
) {
  const {
    ToolRegistryProvider,
    useCopilotKit,
    useFrontendTool,
    useRenderToolCall,
  } = await registry();
  const sent: { list: () => { name: string; description: string }[] } = {
    list: () => [],
  };
  let draws = 0;

  function Tool({ offer }: { offer: Offer }) {
    useFrontendTool({
      ...offer,
      parameters: TAKES_A_TITLE,
      render: ({ args, status, result }) => {
        draws += 1;
        return (
          <p data-call={offer.name}>
            {`${offer.description ?? ""}|${status}|${String(args.title ?? "")}|${result ?? ""}`}
          </p>
        );
      },
    });
    return null;
  }
  function Ask() {
    const { copilotkit } = useCopilotKit();
    sent.list = () =>
      copilotkit.buildFrontendTools("bot") as {
        name: string;
        description: string;
      }[];
    return null;
  }
  function Calls() {
    const draw = useRenderToolCall();
    return (
      <>
        {calls.map((call) => (
          <div data-row={call.id} key={call.id}>
            {draw({
              toolCall: {
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.args },
              },
              ...(call.result === undefined
                ? {}
                : { toolMessage: { content: call.result } }),
            }) ?? "no renderer"}
          </div>
        ))}
      </>
    );
  }
  const tree = (tools: Offer[]) => (
    <ToolRegistryProvider>
      {tools.map((offer) => (
        <Tool key={offer.name} offer={offer} />
      ))}
      <Ask />
      <Calls />
    </ToolRegistryProvider>
  );
  const view: Mounted = await mount(tree(first));
  return {
    view,
    names: () => sent.list().map((tool) => tool.name),
    list: () => sent.list(),
    row: (id: string) =>
      view.host.querySelector(`[data-row="${id}"]`)?.textContent ?? null,
    again: (tools: Offer[]) => view.render(tree(tools)),
    draws: () => draws,
  };
}

describe("the tools a turn is offered", () => {
  test("are the registered ones, in the order they were registered", async () => {
    const on = await screen([
      { name: "second_alphabetically", description: "B" },
      { name: "first_alphabetically", description: "A" },
    ]);
    expect(on.list()).toEqual([
      {
        name: "second_alphabetically",
        description: "B",
        parameters: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
      {
        name: "first_alphabetically",
        description: "A",
        parameters: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    ] as never);
  });

  test("leave out one that is registered and not available, and a missing description is empty", async () => {
    const on = await screen([
      { name: "held" },
      { name: "taken_back", available: false },
    ]);
    expect(
      on.list().map(({ name, description }) => [name, description]),
    ).toEqual([["held", ""]]);
  });

  test("a tool made available again goes to the end of the list", async () => {
    const on = await screen([{ name: "a" }, { name: "b" }, { name: "c" }]);
    expect(on.names()).toEqual(["a", "b", "c"]);
    await on.again([
      { name: "a", available: false },
      { name: "b" },
      { name: "c" },
    ]);
    expect(on.names()).toEqual(["b", "c"]);
    await on.again([{ name: "a" }, { name: "b" }, { name: "c" }]);
    expect(on.names()).toEqual(["b", "c", "a"]);
  });

  test("keep the description a tool was registered with: a later render's words do not move the list", async () => {
    const on = await screen([{ name: "card", description: "as published" }]);
    await on.again([{ name: "card", description: "edited since" }]);
    expect(on.list()[0]?.description).toBe("as published");
    // Registered again — taken back and given — it is read again.
    await on.again([
      { name: "card", description: "edited since", available: false },
    ]);
    await on.again([{ name: "card", description: "edited since" }]);
    expect(on.list()[0]?.description).toBe("edited since");
  });

  test("lose a tool whose screen has left", async () => {
    const on = await screen([{ name: "stays" }, { name: "leaves" }]);
    await on.again([{ name: "stays" }]);
    expect(on.names()).toEqual(["stays"]);
  });
});

describe("a call is drawn by the renderer registered under its name", () => {
  test("with its arguments as far as they are written, then with its answer", async () => {
    const on = await screen(
      [{ name: "showCard", description: "d" }],
      [
        { id: "growing", name: "showCard", args: '{"title":"다음 주 예' },
        {
          id: "answered",
          name: "showCard",
          args: '{"title":"이번 주"}',
          result: "on screen",
        },
        { id: "empty", name: "showCard", args: "" },
      ],
    );
    expect(on.row("growing")).toBe("d|inProgress|다음 주 예|");
    expect(on.row("answered")).toBe("d|complete|이번 주|on screen");
    expect(on.row("empty")).toBe("d|inProgress||");
  });

  test("and a call of a tool nothing registered is nothing, for the transcript to draw its own line", async () => {
    const on = await screen(
      [{ name: "showCard" }],
      [{ id: "unknown", name: "mystery_tool", args: "{}" }],
    );
    expect(on.row("unknown")).toBe("no renderer");
  });

  test("a call already in the conversation is still drawn after its tool has left", async () => {
    const calls = [
      { id: "kept", name: "leaves", args: '{"title":"t"}', result: "r" },
    ];
    const on = await screen([{ name: "leaves", description: "d" }], calls);
    expect(on.row("kept")).toBe("d|complete|t|r");
    await on.again([]);
    expect(on.names()).toEqual([]);
    expect(on.row("kept")).toBe("d|complete|t|r");
  });

  test("a row is not drawn again when another tool is registered", async () => {
    const on = await screen(
      [{ name: "showCard" }],
      [{ id: "one", name: "showCard", args: '{"title":"t"}', result: "r" }],
    );
    const before = on.draws();
    expect(before).toBeGreaterThan(0);
    await on.again([{ name: "showCard" }, { name: "another" }]);
    expect(on.names()).toEqual(["showCard", "another"]);
    expect(on.draws()).toBe(before);
  });
});

describe("the renderers a component is handed", () => {
  test("are a new list on every change, and the list before is as it was", async () => {
    const { createToolRegistry } = await registry();
    const held = createToolRegistry();
    let told = 0;
    const stop = held.subscribe(() => {
      told += 1;
    });
    const none = held.renderers();
    const First = () => null;
    const Second = () => null;
    held.setRenderer("a", First);
    const one = held.renderers();
    held.setRenderer("b", Second);
    const two = held.renderers();

    expect(none).toEqual([]);
    expect(one).toEqual([{ name: "a", render: First }]);
    expect(two.map((renderer) => renderer.name)).toEqual(["a", "b"]);
    expect(one).not.toBe(two);
    expect(Object.isFrozen(two)).toBe(true);
    // Unchanged between changes: what `useSyncExternalStore` needs to not loop.
    expect(held.renderers()).toBe(two);
    expect(told).toBe(2);

    // A name registered again keeps its place and takes the new renderer.
    held.setRenderer("a", Second);
    expect(held.renderers()).toEqual([
      { name: "a", render: Second },
      { name: "b", render: Second },
    ]);
    stop();
    held.removeRenderer("a");
    expect(told).toBe(3);
    expect(held.renderers().map((renderer) => renderer.name)).toEqual(["b"]);
  });
});

describe("a decision card", () => {
  test("is told its own name and description, is never handed a way to answer in the page, and its renderer leaves with it", async () => {
    const { ToolRegistryProvider, useHumanInTheLoop, useRenderToolCall } =
      await registry();
    function Card(props: Record<string, unknown>) {
      return (
        <p data-card>
          {`${String(props.name)}|${String(props.description)}|${String(props.status)}|${typeof props.respond}|${String((props.args as { title?: string }).title)}`}
        </p>
      );
    }
    function Decision() {
      useHumanInTheLoop({
        name: "askSomething",
        description: "Ask the person.",
        parameters: TAKES_A_TITLE,
        render: Card,
      });
      return null;
    }
    function Row() {
      const draw = useRenderToolCall();
      return (
        <div data-row>
          {draw({
            toolCall: {
              id: "c1",
              type: "function",
              function: {
                name: "askSomething",
                arguments: '{"title":"점심은?"}',
              },
            },
          }) ?? "no renderer"}
        </div>
      );
    }
    const tree = (asking: boolean) => (
      <ToolRegistryProvider>
        {asking ? <Decision /> : null}
        <Row />
      </ToolRegistryProvider>
    );
    const view = await mount(tree(true));
    const row = () => view.host.querySelector("[data-row]")?.textContent;
    expect(row()).toBe(
      "askSomething|Ask the person.|inProgress|undefined|점심은?",
    );
    await view.render(tree(false));
    expect(row()).toBe("no renderer");
  });
});

describe("a renderer for a tool this window does not offer", () => {
  test("draws its calls and puts nothing on the list", async () => {
    const {
      ToolRegistryProvider,
      useCopilotKit,
      useRenderTool,
      useRenderToolCall,
    } = await registry();
    let offered: unknown[] = [{ name: "not asked yet" }];
    function Line() {
      useRenderTool({
        name: "now",
        parameters: TAKES_A_TITLE,
        render: ({ status, result }) => <p>{`${status}|${result ?? ""}`}</p>,
      });
      const { copilotkit } = useCopilotKit();
      offered = copilotkit.buildFrontendTools();
      const draw = useRenderToolCall();
      return (
        <div data-row>
          {draw({
            toolCall: {
              id: "n1",
              type: "function",
              function: { name: "now", arguments: "{}" },
            },
            toolMessage: { content: "19:00" },
          }) ?? "no renderer"}
        </div>
      );
    }
    const view = await mount(
      <ToolRegistryProvider>
        <Line />
      </ToolRegistryProvider>,
    );
    expect(view.host.querySelector("[data-row]")?.textContent).toBe(
      "complete|19:00",
    );
    expect(offered).toEqual([]);
  });
});

describe("a tool's parameters as the turn is sent them", () => {
  test("drop $schema, and every additionalProperties at every depth", async () => {
    const { toolJsonSchema } = await import("../src/lib/copilot/tool-schema");
    const catalogue = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: { type: "string" },
            properties: { label: { type: "string" } },
          },
        },
      },
      required: ["rows"],
    };
    const face = { toJSONSchema: () => catalogue };
    expect(JSON.stringify(toolJsonSchema(face))).toBe(
      '{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string"}}}}},"required":["rows"]}',
    );
    // The catalogue's own schema is not this code's to change.
    expect(catalogue.additionalProperties).toBe(false);
    expect(catalogue.properties.rows.items.additionalProperties).toEqual({
      type: "string",
    });
  });

  test("say an object of properties where the schema did not, each added at the end", async () => {
    const { toolJsonSchema } = await import("../src/lib/copilot/tool-schema");
    expect(
      JSON.stringify(
        toolJsonSchema({ toJSONSchema: () => ({ description: "anything" }) }),
      ),
    ).toBe('{"description":"anything","type":"object","properties":{}}');
    expect(JSON.stringify(toolJsonSchema(undefined))).toBe(
      '{"type":"object","properties":{}}',
    );
  });

  test("a zod object describes itself as draft-07, and one that takes anything is an object of nothing", async () => {
    const { toolJsonSchema } = await import("../src/lib/copilot/tool-schema");
    expect(
      JSON.stringify(
        toolJsonSchema(
          z.object({
            title: z.string().describe("What it is"),
            count: z.number().optional(),
          }),
        ),
      ),
    ).toBe(
      '{"type":"object","properties":{"title":{"type":"string","description":"What it is"},"count":{"type":"number"}},"required":["title"]}',
    );
    expect(
      JSON.stringify(toolJsonSchema(z.object({}).catchall(z.unknown()))),
    ).toBe('{"type":"object","properties":{}}');
    // Draft-07 and no later: a pair is `items` as a list there, and `prefixItems` after it.
    expect(
      JSON.stringify(
        toolJsonSchema(z.object({ pair: z.tuple([z.string(), z.number()]) })),
      ),
    ).toBe(
      '{"type":"object","properties":{"pair":{"type":"array","items":[{"type":"string"},{"type":"number"}],"additionalItems":false,"minItems":2,"maxItems":2}},"required":["pair"]}',
    );
  });

  test("parameters that cannot describe themselves are refused, not sent as nothing", async () => {
    const { toolJsonSchema } = await import("../src/lib/copilot/tool-schema");
    expect(() => toolJsonSchema({ "~standard": { vendor: "other" } })).toThrow(
      "do not describe themselves",
    );
  });
});
