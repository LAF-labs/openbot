import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiRequest,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  answering,
  BOT_ID,
  channelServer,
  type RunInput,
  sse,
  THREAD_ID,
} from "./support/channel-server";

/**
 * A CARD THE SERVER REFUSED AT THE MOMENT OF THE CALL IS NOT DRAWN.
 *
 * A card written in the playground is offered to a Bot from a list read once a minute, and whether
 * the Bot may draw it is asked of the server again when it calls (`decideComponent`). The handler
 * keeps the refusal under the call's id and the card's renderer looks it up. Two things were in the
 * way, and either alone was enough (measured 2026-10-02, each put back by itself):
 *
 *  - the renderer read `props.toolCall.id`, which CopilotKit 1.67.1 does not send — a renderer is
 *    given `toolCallId`, flat (upstream OpenBot #402);
 *  - the renderer CopilotKit held was the one registered before the call, whose map of refusals
 *    was the empty one it was made with.
 *
 * So a card switched off since the last read was drawn in the conversation while the model was told
 * it had not been.
 *
 * Driven through the real channel route with the runtime stubbed at the network edge: the card is
 * offered, the call arrives on the stream, this window carries it out, and what is asserted is what
 * is on screen. Only a window carries out such a call — a turn the server owns offers no playground
 * card.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
setDefaultTimeout(20_000);
afterAll(async () => {
  await removeAppDom();
});

const CARD = "custom_weekly_sales";
const CARD_SAYS = "이번 주 매출 카드";
const SWITCHED_OFF =
  "That card is switched off for this Bot. It can be turned back on from the admin screen";

const refused = '[data-testid="component-refused"]';
/** The card itself: CopilotKit draws a playground card in a sandbox frame. */
const drawn = '[role="log"] iframe';

/** The Bot asks this window to draw the card, and the run ends to let it. */
const askingToDraw = ({ runId }: RunInput) =>
  sse([
    { type: "RUN_STARTED", threadId: THREAD_ID, runId },
    {
      type: "TOOL_CALL_START",
      toolCallId: `call_${runId}`,
      toolCallName: CARD,
      parentMessageId: `msg_${runId}`,
    },
    { type: "TOOL_CALL_ARGS", toolCallId: `call_${runId}`, delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: `call_${runId}` },
    { type: "RUN_FINISHED", threadId: THREAD_ID, runId },
  ]);

/**
 * A conversation with a Bot that holds the card, by the list this window read; `decide` is the
 * server's answer each time the card is called.
 *
 * It opens on a question whose turn failed, so the run under test starts from a press — 다시 시도 —
 * made after the window has read both lists. A question sent as the route mounts goes out before
 * the card is registered, and a model is never offered a card that way.
 */
async function conversation(
  channelId: string,
  runs: Array<(input: RunInput) => Response>,
  decide: (call: number) => { allowed: boolean; reason?: string },
) {
  const question = {
    id: "q-card",
    role: "user",
    content: "이번 주 매출 보여줘",
  };
  const server = channelServer({
    channelId,
    history: [question],
    failures: [
      {
        messageId: question.id,
        code: "laf:turn_unreachable",
        at: "2026-10-02T03:00:00.000Z",
      },
    ],
    runs,
  });
  const decisions: unknown[] = [];
  const offered: string[][] = [];
  const api = (request: ApiRequest) => {
    const { pathname } = request;
    if (pathname === "/api/sandboxed/published") {
      return json({
        components: [
          {
            name: CARD,
            html: `<p>${CARD_SAYS}</p>`,
            css: "",
            jsFunctions: "",
            argumentSchema: { type: "object", properties: {} },
          },
        ],
      });
    }
    if (pathname === `/api/components/for-agent/${BOT_ID}`) {
      return json({ components: [{ name: CARD, description: CARD_SAYS }] });
    }
    if (pathname === `/api/components/${CARD}/decision`) {
      decisions.push(request.body);
      return json(decide(decisions.length));
    }
    if (pathname === `/api/copilotkit/agent/${BOT_ID}/run`) {
      const { tools } = request.body as { tools?: { name: string }[] };
      offered.push((tools ?? []).map((tool) => tool.name));
    }
    return server.api(request);
  };
  const view = await mountApp({ path: `/channel/${channelId}`, api });
  await view.waitFor(
    () => view.buttonNamed("Try again") !== undefined,
    "the stored failure and its button",
    8000,
  );
  await view.click(view.buttonNamed("Try again") as Element);
  await view.waitFor(
    () => server.runs.length === runs.length,
    "the run that carries the last call's result back to the Bot",
    8000,
  );
  return { view, decisions, offered };
}

test("a card switched off since the list was read shows the refusal, not the card", async () => {
  const { view, decisions, offered } = await conversation(
    "channel_card-refused",
    [askingToDraw, answering("카드를 보여드릴 수 없었어요.")],
    () => ({ allowed: false, reason: "laf:component_withheld" }),
  );
  // The Bot was offered the card, called it, and this window asked the server as that Bot.
  expect(offered[0]).toContain(CARD);
  expect(decisions).toEqual([{ agentId: BOT_ID, functions: [] }]);

  await view.waitFor(
    () => view.host.querySelector(refused) !== null,
    "the refusal where the card would have been",
    4000,
  );
  expect(view.host.querySelector(refused)?.textContent).toContain(SWITCHED_OFF);
  expect(ko[SWITCHED_OFF]).toBeTruthy();
  expect(view.host.querySelector(drawn)).toBeNull();
  await view.unmount();
});

test("a refusal is that call's: the card drawn before it stays drawn", async () => {
  // Shown once, then switched off, then asked for again in the same turn.
  const { view, decisions } = await conversation(
    "channel_card-then-refused",
    [askingToDraw, askingToDraw, answering("두 번째는 보여드릴 수 없었어요.")],
    (call) =>
      call === 1
        ? { allowed: true }
        : { allowed: false, reason: "laf:component_withheld" },
  );
  expect(decisions).toHaveLength(2);

  await view.waitFor(
    () => view.host.querySelector(refused) !== null,
    "the refusal under the second call",
    4000,
  );
  expect(view.host.querySelectorAll(refused)).toHaveLength(1);
  expect(view.host.querySelectorAll(drawn)).toHaveLength(1);
  await view.unmount();
});
