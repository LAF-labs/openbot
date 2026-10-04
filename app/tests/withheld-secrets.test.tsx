import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { withheldMark } from "@shared/tools/withheld";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  removeAppDom,
} from "./support/app-router";
import { stubFetch } from "./support/fetch";
import { json, mount, unmountAll } from "./support/mount";

/**
 * THE OWNER'S 보기 ON A MAIL TOOL'S LINE: the value comes from the server when pressed, for this
 * Bot, and is shown nowhere before that — the line's text says only that something was hidden.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await removeAppDom();
});

const BOT = "agent_4b9d2c1e-0000-4000-8000-00000000a11c";
const RESULT = `제목: 인증번호 안내\n인증번호: ${withheldMark("code", "Ab12Cd34Ef56")}\n${withheldMark("reset_link")}`;

/**
 * The row as a conversation draws it: under a surface that says which Bot it is for, through a
 * renderer made once. `Line` takes no props, as a renderer's closure takes none after it is
 * registered — whatever it knew of the Bot then is all it will ever be told.
 */
async function surface() {
  const { createElement, memo } = await import("react");
  const { ActiveBotProvider, useActiveBot } = await import(
    "../src/lib/copilot/active-bot"
  );
  const { WithheldSecrets } = await import(
    "../src/components/channels/withheld-secrets"
  );
  const Line = memo(function Line() {
    return createElement(WithheldSecrets, { text: RESULT });
  });
  function Conversation({ botId }: { botId: string | undefined }) {
    useActiveBot(botId);
    return createElement(Line);
  }
  const drawn = (botId: string | undefined) =>
    createElement(
      ActiveBotProvider,
      null,
      createElement(Conversation, { botId }),
    );
  return { drawn };
}

async function line() {
  const { drawn } = await surface();
  const view = await mount(drawn(BOT));
  await view.settle(10);
  return view;
}

const showButton = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Show me",
  );

describe("what a mail held, on its line", () => {
  test("a kept code is fetched when pressed and shown; a routine's is said to be kept nowhere", async () => {
    const asked: string[] = [];
    globalThis.fetch = stubFetch(async (url) => {
      asked.push(String(url));
      return json({ kind: "code", value: "482913", expiresAt: "" });
    });
    const view = await line();
    expect(view.host.textContent).not.toContain("482913");
    expect(view.host.textContent).toContain(
      "This mail had a one-time code. Only you can see it.",
    );
    expect(view.host.textContent).toContain(
      "Not kept: it was read while nobody was watching.",
    );
    const show = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Show me",
    );
    if (!show) throw new Error("no 보기 button");
    await view.press(show);
    await view.settle(30);
    expect(asked).toEqual([`/api/plugins/for/${BOT}/withheld/Ab12Cd34Ef56`]);
    expect(view.host.textContent).toContain("482913");
  });

  test("a code that has run out says so, and says what to do", async () => {
    globalThis.fetch = stubFetch(async () =>
      json({ error: "laf:withheld_gone", code: "laf:withheld_gone" }, 404),
    );
    const view = await line();
    const show = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Show me",
    );
    if (!show) throw new Error("no 보기 button");
    await view.press(show);
    await view.settle(30);
    expect(view.host.textContent).toContain(
      "It is no longer kept. Ask the site to send a new one.",
    );
  });
});

/*
 * WHOSE CODE IT IS, READ BY THE ROW ITSELF. The plugin tools' renderer handed the row the Bot it was
 * registered for (`botId={botId}`), and a renderer is registered when its tool is first offered and
 * not again: on an account from before 2026-09-24 with several Bots holding the same connected
 * tool, opening the second Bot's conversation left the row asking the first Bot's door for the
 * second Bot's code — which answers only the Bot the call was made for. The same fault as the help
 * card's (`help-card-reload.test.tsx`), one step removed: never the sentinel, but stale.
 */
describe("whose code the row asks for", () => {
  test("the Bot the conversation names now, not the one it was first drawn for", async () => {
    const asked: string[] = [];
    globalThis.fetch = stubFetch(async (url) => {
      asked.push(String(url));
      return json({ kind: "code", value: "482913", expiresAt: "" });
    });
    const OTHER = "agent_7c1f0a2b-0000-4000-8000-00000000b22d";
    const { drawn } = await surface();
    const view = await mount(drawn(BOT));
    await view.settle(10);
    // The same screen, now the other Bot's conversation: the renderer is not made again.
    await view.render(drawn(OTHER));
    await view.settle(10);
    const show = showButton(view.host);
    if (!show) throw new Error("no 보기 button");
    await view.press(show);
    await view.settle(30);
    expect(asked).toEqual([`/api/plugins/for/${OTHER}/withheld/Ab12Cd34Ef56`]);
  });

  test("nobody, before a conversation has named its Bot: the press waits rather than asks", async () => {
    const asked: string[] = [];
    globalThis.fetch = stubFetch(async (url) => {
      asked.push(String(url));
      return json({ kind: "code", value: "482913", expiresAt: "" });
    });
    const { drawn } = await surface();
    const view = await mount(drawn(undefined));
    await view.settle(10);
    const show = showButton(view.host);
    // Drawn, so the line still says a code was held — and not pressable for a Bot nobody named.
    expect(show?.hasAttribute("disabled")).toBe(true);
    if (show) await view.press(show);
    await view.settle(30);
    expect(asked).toEqual([]);
    expect(view.host.textContent).not.toContain("could not be shown");

    // Named: the same row asks, for that Bot.
    await view.render(drawn(BOT));
    await view.settle(10);
    const ready = showButton(view.host);
    expect(ready?.hasAttribute("disabled")).toBe(false);
    if (ready) await view.press(ready);
    await view.settle(30);
    expect(asked).toEqual([`/api/plugins/for/${BOT}/withheld/Ab12Cd34Ef56`]);
  });
});
