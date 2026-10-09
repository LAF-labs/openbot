import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Presence } from "../src/lib/agents/presence";
import { mount, unmountAll } from "./support/mount";

/**
 * THE HEADER SAYS A WORD ONLY WHEN SOMEBODY HAS TO ACT ON IT.
 *
 * Under the Bot's name there was always a pill with a word in it — 준비됨 for most of every day,
 * 생각 중 while the end of the conversation already said so. The owner's complaint was the number
 * of words on the screen (2026-10-04), and the header they chose has a dot. The dot keeps the word
 * as its name; one state keeps the word in sight, because a dot alone does not say what is wanted:
 * the person's turn.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3116/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(unmountAll);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const READY: Presence = {
  kind: "idle",
  label: "Ready",
  tone: "quiet",
};
const THINKING: Presence = {
  ...READY,
  kind: "thinking",
  label: "Thinking",
  tone: "active",
};
const ASKING: Presence = {
  ...READY,
  kind: "approval",
  label: "Needs your OK",
  tone: "attention",
};

async function drawn(presence: Presence) {
  const { PresencePill } = await import(
    "../src/components/channels/bot-header"
  );
  const view = await mount(<PresencePill presence={presence} />);
  const pill = view.host.firstElementChild as HTMLElement;
  /** What somebody looking at the screen reads: everything not kept for a screen reader alone. */
  const seen = [...pill.querySelectorAll("span")]
    .filter((part) => !part.classList.contains("sr-only"))
    .map((part) => part.textContent)
    .join("");
  return { pill, seen };
}

describe("the state beside the Bot's name", () => {
  test("is a dot with no word at rest and while working — the word is its name", async () => {
    for (const presence of [READY, THINKING]) {
      const { pill, seen } = await drawn(presence);
      expect([presence.kind, seen]).toEqual([presence.kind, ""]);
      // Still named, for whoever is read the screen or points at the dot.
      expect(pill.textContent).toBe(presence.label);
      expect(pill.getAttribute("title")).toBe(presence.label);
      // A bare dot: no plate under it.
      expect(pill.className).not.toContain("bg-muted");
      expect(pill.className).not.toContain("bg-primary");
    }
  });

  test("says its word when it is the person's turn, on the amber plate", async () => {
    const { pill, seen } = await drawn(ASKING);
    expect(seen).toBe("Needs your OK");
    expect(pill.className).toContain("text-warning");
  });

  test("only the person's turn says its word", async () => {
    const { saysItsWord } = await import(
      "../src/components/channels/bot-header"
    );
    expect(
      (["quiet", "active", "attention"] as const).map((tone) =>
        saysItsWord({ ...READY, tone }),
      ),
    ).toEqual([false, false, true]);
  });
});
