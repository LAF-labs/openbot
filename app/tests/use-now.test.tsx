import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { createElement } from "react";
import { useNow } from "../src/lib/use-now";
import { mount, unmountAll } from "./support/mount";

/**
 * THE CLOCK AS AN INPUT, WHICH IS WHAT KEEPS A COMPILED LABEL HONEST.
 *
 * Under the React Compiler a label computed from `new Date()` while rendering is kept until its
 * other inputs change, so "오늘" stayed "오늘" past midnight on a screen left open. `useNow` is how
 * those labels read the time now. What matters about it: it hands back the start of the minute,
 * the same object for the whole minute (so nothing redraws for nothing), and a new one once the
 * minute has turned and something looks — here, the window coming back into view.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  await unmountAll();
  setSystemTime();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

/** A component that shows what `useNow` gave it and counts the times it drew. */
function probe() {
  const seen: Date[] = [];
  const Probe = () => {
    const now = useNow();
    seen.push(now);
    return createElement("time", null, now.toISOString());
  };
  return { seen, element: createElement(Probe) };
}

/** The window coming back into view, which is one of the moments `useNow` looks at the clock. */
async function lookAgain() {
  const { act } = await import("react");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

describe("useNow", () => {
  test("is the start of the current minute", async () => {
    setSystemTime(new Date("2026-09-18T14:32:41.500Z"));
    const { element } = probe();
    const view = await mount(element);
    expect(view.host.textContent).toBe("2026-09-18T14:32:00.000Z");
  });

  test("draws nothing new within the minute, and the new minute once it has turned", async () => {
    setSystemTime(new Date("2026-09-18T23:59:10.000Z"));
    const { seen, element } = probe();
    const view = await mount(element);
    const drawn = seen.length;

    setSystemTime(new Date("2026-09-18T23:59:50.000Z"));
    await view.settle();
    await lookAgain();
    await view.settle();
    expect(seen.length).toBe(drawn);

    setSystemTime(new Date("2026-09-19T00:00:05.000Z"));
    await lookAgain();
    await view.settle();
    expect(view.host.textContent).toBe("2026-09-19T00:00:00.000Z");
    expect(seen.at(-1)).not.toBe(seen[drawn - 1]);
  });
});
