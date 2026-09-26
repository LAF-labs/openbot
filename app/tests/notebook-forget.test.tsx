import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";

/**
 * 수첩's forget takes two presses. Since 0.5.5 a forgotten line also leaves the day's summary and
 * cannot be written back, so there is no undo; the 0.5.5 QA found one press forgot at once.
 */

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("수첩's forget button", () => {
  test("the first press only arms it; the second forgets", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ForgetButton } = await import(
      "../src/components/notebook/notebook"
    );
    const { t } = await import("../src/lib/i18n");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let forgotten = 0;
    await act(async () => {
      root.render(
        createElement(ForgetButton, {
          disabled: false,
          label: "잊기",
          onConfirm: () => {
            forgotten += 1;
          },
        }),
      );
    });
    const button = () => host.querySelector("button") as HTMLButtonElement;
    expect(button().textContent).toBe("잊기");

    await act(async () => button().click());
    expect(forgotten).toBe(0);
    expect(button().textContent).toBe(t("Press again to forget"));

    await act(async () => button().click());
    expect(forgotten).toBe(1);
    expect(button().textContent).toBe("잊기");

    await act(async () => root.unmount());
    host.remove();
  });
});
