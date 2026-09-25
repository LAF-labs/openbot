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
 * A STATUS LINE IS THERE BEFORE IT SPEAKS.
 *
 * A screen reader announces a change inside a live region it already knows. A line mounted in the
 * same commit as its words — `{saved ? <p role="status">저장됨</p> : null}` — has no "before" for
 * the change to be measured against, and most screen readers read out nothing. What is held here is
 * the one property that fixes it: the element that carries the words is the SAME element that was
 * in the document while it was empty, with its live role already on it.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await unmountAll();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function region(tone?: "status" | "alert") {
  const { LiveRegion } = await import("../src/components/layout/live-region");
  const view = await mount();
  const draw = (words: string | null) =>
    view.render(
      createElement(
        LiveRegion,
        { className: "text-sm", ...(tone ? { tone } : {}) },
        words,
      ),
    );
  return { view, draw };
}

describe("a live region", () => {
  test("is in the document while it is empty, and the words land in that same element", async () => {
    const { view, draw } = await region();
    await draw(null);

    const empty = view.host.querySelector('[role="status"]');
    expect(empty).not.toBeNull();
    expect(empty?.getAttribute("aria-live")).toBe("polite");
    expect(empty?.textContent).toBe("");
    // Out of the layout while it has nothing to say, and still in the accessibility tree.
    expect(empty?.className).toBe("sr-only");

    await draw("저장됨");
    const filled = view.host.querySelector('[role="status"]');
    expect(filled).toBe(empty);
    expect(filled?.textContent).toBe("저장됨");
    expect(filled?.className).toBe("text-sm");

    // And back: the region stays for the next thing it has to say.
    await draw(null);
    expect(view.host.querySelector('[role="status"]')).toBe(empty);
    expect(empty?.textContent).toBe("");
  });

  test("a failure is an alert, mounted just as early", async () => {
    const { view, draw } = await region("alert");
    await draw("");

    const empty = view.host.querySelector('[role="alert"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe("");

    await draw("전달되지 않았어요. 다시 시도하세요.");
    expect(view.host.querySelector('[role="alert"]')).toBe(empty);
    expect(empty?.textContent).toBe("전달되지 않았어요. 다시 시도하세요.");
    // Assertive is the alert's own; a status line never interrupts.
    expect(view.host.querySelector('[role="status"]')).toBeNull();
  });

  test("counts a list of nothing as nothing", async () => {
    const { LiveRegion } = await import("../src/components/layout/live-region");
    const view = await mount(createElement(LiveRegion, null, null, false, ""));
    expect(view.host.querySelector('[role="status"]')?.className).toBe(
      "sr-only",
    );
  });
});
