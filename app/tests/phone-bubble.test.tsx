import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createElement } from "react";
import { mount, unmountAll } from "./support/mount";

/**
 * THE BOT'S BUBBLE ON A PHONE.
 *
 * First-hour walk, 2026-09-27: at 375 wide the Bot's answer sat in 261px — `min(88%, 640px,
 * 100% - 82px)`, whose 82px gutter is empty on a phone — and a table scrolled inside a 217px box.
 * happy-dom lays nothing out, so this holds the class that makes the exception; the widths were
 * measured in the browser (261 → 319 at 375, 640 unchanged at 1280).
 *
 * THE BUBBLE IS THE GREETING'S NOW. Since 2026-10-04 a Bot's answer in the conversation is words
 * on the page with no bubble, the whole row wide on a phone (`plain-answer.test.tsx`). The `agent`
 * bubble is still what the Bot's greeting is drawn in, and this is still its width there.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(unmountAll);
afterAll(() => GlobalRegistrator.unregister());

async function bubble(variant: "agent" | "user") {
  const { Bubble } = await import("../src/components/ui/bubble");
  const view = await mount(createElement(Bubble, { variant }, "안녕하세요"));
  return view.host.querySelector("[data-slot=bubble]")?.className ?? "";
}

describe("the bubble's width", () => {
  test("the Bot's takes the phone's width below sm, and keeps the measured cap above it", async () => {
    const classes = await bubble("agent");
    expect(classes).toContain("max-sm:max-w-[calc(100%-24px)]");
    expect(classes).toContain("max-w-[min(88%,640px,calc(100%-82px))]");
  });

  test("the person's keeps the cap everywhere", async () => {
    const classes = await bubble("user");
    expect(classes).not.toContain("max-sm:max-w-");
    expect(classes).toContain("max-w-[min(88%,640px,calc(100%-82px))]");
  });
});
