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

async function line() {
  const { createElement } = await import("react");
  const { WithheldSecrets } = await import(
    "../src/components/channels/withheld-secrets"
  );
  return mount(createElement(WithheldSecrets, { botId: BOT, text: RESULT }));
}

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
