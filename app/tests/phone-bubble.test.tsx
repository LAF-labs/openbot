import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { mount, unmountAll } from "./support/mount";

/**
 * THE BUBBLE'S WIDTH — THE PERSON'S, WHICH IS THE ONLY BUBBLE LEFT.
 *
 * First-hour walk, 2026-09-27: at 375 wide the Bot's answer sat in 261px — `min(88%, 640px,
 * 100% - 82px)`, whose 82px gutter is empty on a phone — and a table scrolled inside a 217px box.
 * So the Bot's bubble was given the phone's width below `sm`, and this file held the class that
 * made the exception (measured in the browser: 261 → 319 at 375, 640 unchanged at 1280).
 *
 * THE BOT HAS NO BUBBLE NOW, AND SO NO EXCEPTION. Since 2026-10-04 its answer is words on the page,
 * the whole row wide on a phone (`plain-answer.test.tsx`), and its greeting followed the same day
 * (`greeting-head.test.tsx`). The `agent` variant, its grey and its phone width went with them.
 * What is held here is what is left: the person's bubble keeps the measured cap at every width,
 * and the Bot's grey is not a colour a class could ask for.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(unmountAll);
afterAll(() => GlobalRegistrator.unregister());

async function bubble(variant: "user") {
  const { Bubble } = await import("../src/components/ui/bubble");
  const view = await mount(createElement(Bubble, { variant }, "안녕하세요"));
  return view.host.querySelector("[data-slot=bubble]")?.className ?? "";
}

describe("the bubble's width", () => {
  test("the person's keeps the cap everywhere", async () => {
    const classes = await bubble("user");
    expect(classes).not.toContain("max-sm:max-w-");
    expect(classes).toContain("max-w-[min(88%,640px,calc(100%-82px))]");
  });
});

describe("the Bot's bubble", () => {
  test("is not a colour of the theme any more, in either palette or as a class's name", () => {
    const styles = readFileSync(
      join(import.meta.dir, "../src/styles.css"),
      "utf8",
    );
    // The person's is still declared: twice as a value, light and dark, and once as a name.
    expect(styles.match(/--sand-fill-bubble-user\s*:/g)?.length).toBe(2);
    expect(styles.match(/--color-bubble-user\s*:/g)?.length).toBe(1);
    // The Bot's was declared the same three times. A class that named it would draw nothing.
    expect(styles.match(/--sand-fill-bubble-agent\s*:/g) ?? []).toEqual([]);
    expect(styles.match(/--color-bubble-agent\s*:/g) ?? []).toEqual([]);
  });

  test("is not a variant the bubble has", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/components/ui/bubble.tsx"),
      "utf8",
    );
    // Its comments still say what there was. No class string does.
    expect(source).toContain("bg-bubble-user");
    expect(source).not.toContain("bg-bubble-agent");
    expect(/^\s*agent\s*:/m.test(source)).toBe(false);
  });
});
