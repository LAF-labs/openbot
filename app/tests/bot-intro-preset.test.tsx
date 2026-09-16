import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement } from "react";
import { AGENT_PRESETS, workPattern } from "../src/lib/agents/presets";
import { agentFixture } from "./support/app-router";
import { stubFetch } from "./support/fetch";
import { mount, unmountAll } from "./support/mount";

/**
 * A KIND-OF-WORK CHIP ON THE INTRO CARD, PRESSED — AND WHAT REACHES THE SERVER.
 *
 * The chip writes a preset's translated title and role onto a Bot made blank a moment before, and
 * until 2026-09-14 that was all: the preset itself was gone the moment its words were written, so
 * "which kinds of work do people pick" had nothing to be counted from. The key rides in the same
 * PATCH now (`agent_profiles.preset_id`, read by the fleet's insights). `bot-profile.test.ts` reads
 * the card's source for the translated words; this presses the chip and reads the request, because
 * a key that the source mentions and the wire never carries is the failure a source walk cannot see.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("the intro card's kind-of-work chips", () => {
  test("a press sends the preset's key beside its words, and a later name edit does not", async () => {
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { BotIntroCard } = await import(
      "../src/components/agents/bot-intro-card"
    );
    const { t } = await import("../src/lib/i18n");

    const bot = agentFixture({ id: "bot-1", name: "초롱" });
    const patches: Record<string, unknown>[] = [];
    globalThis.fetch = stubFetch(async (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      if (init?.method === "PATCH" && String(url) === "/api/agents/bot-1") {
        patches.push(body);
      }
      return new Response(JSON.stringify({ agent: { ...bot, ...body } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const view = await mount(
      createElement(
        QueryClientProvider,
        { client },
        createElement(BotIntroCard, { agent: bot }),
      ),
    );

    const labels = new Set(
      AGENT_PRESETS.map((preset) => t(workPattern(preset.pattern).name)),
    );
    const chip = [...view.host.querySelectorAll("button")].find((button) =>
      labels.has(button.textContent ?? ""),
    );
    if (!chip) throw new Error("no kind-of-work chip on the card");
    await view.press(chip);
    await view.settle(50);

    expect(patches).toHaveLength(1);
    const sent = patches[0] ?? {};
    // The dealt preset under that chip's kind of work, whichever of its four the hand held.
    const preset = AGENT_PRESETS.find(
      (candidate) => candidate.id === sent.presetId,
    );
    expect(preset).toBeDefined();
    expect(t(workPattern(preset?.pattern ?? "stock").name)).toBe(
      chip.textContent ?? "",
    );
    expect(sent).toMatchObject({
      name: "초롱",
      title: t(preset?.title ?? ""),
      roleDescription: t(preset?.roleDescription ?? ""),
      presetId: preset?.id,
    });

    // Renaming the Bot on the same card is not picking a preset again, and must not claim to be.
    const name = view.host.querySelector<HTMLInputElement>("input");
    if (!name) throw new Error("no name field on the card");
    await view.type(name, "정산이");
    const { act } = await import("react");
    await act(async () => {
      name.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
      name.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await view.settle(50);
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({ name: "정산이" });
    expect(patches[1]).not.toHaveProperty("presetId");
  });
});
