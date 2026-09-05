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
import { confirms } from "../src/routes/_authed/settings/account";

/**
 * The rows on Settings, and whether a person can act on each of them.
 *
 * All three of these were rows that told somebody something and then could not be used: a
 * Notifications heading with no control under it, a Delete button that went live on one character
 * before anyone had been told what to type, and a download link that gave no sign it had been
 * pressed. None of the three is a broken function — they all worked exactly as written — so none of
 * them was visible from a green gate.
 */

const APP = join(import.meta.dir, "../src");
const read = (relative: string) => readFileSync(join(APP, relative), "utf8");

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Notifier = { permission: string; requestPermission?: () => unknown };

/** What the browser says it will allow. Absent is the state this screen used to draw nothing for. */
function browserAnswers(permission: string | null): void {
  const scope = globalThis as { Notification?: Notifier };
  if (permission === null) {
    delete scope.Notification;
    return;
  }
  scope.Notification = { permission };
}

afterEach(() => {
  browserAnswers(null);
});

async function mounted() {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render: async (element: React.ReactElement) => {
      await act(async () => {
        root.render(element);
      });
    },
    click: async (target: Element) => {
      await act(async () => {
        target.dispatchEvent(new Event("click", { bubbles: true }));
      });
    },
    settle: async (ms: number) => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    },
  };
}

describe("the Notifications row", () => {
  test("says so where notifications cannot be turned on at all", async () => {
    /*
     * THE FAILURE THIS REPLACES. The heading and its paragraph were drawn unconditionally and the
     * control returned null, so on a surface with no `Notification` — WKWebView, which is the
     * installed app — a person read a description of a feature followed by nothing. No way to tell
     * whether the control had failed to load or had never existed.
     */
    browserAnswers(null);
    const { host, render } = await mounted();
    const { NotificationPermission } = await import(
      "../src/components/notifications/notification-permission"
    );
    await render(
      createElement(NotificationPermission, {
        grantedNote: "on",
        unsupportedNote: "not here",
      }),
    );
    expect(host.textContent).toBe("not here");
  });

  test("still draws nothing beside a Bot's own switch", async () => {
    // That row is about the Bot, and a browser that cannot notify is not something the Bot did.
    // `agent-profile.tsx` passes no `unsupportedNote`, and this is what keeps that meaning "quiet".
    browserAnswers(null);
    const { host, render } = await mounted();
    const { NotificationPermission } = await import(
      "../src/components/notifications/notification-permission"
    );
    await render(createElement(NotificationPermission, { grantedNote: "on" }));
    expect(host.textContent).toBe("");
  });

  test("offers the ask when the browser has not been asked", async () => {
    browserAnswers("default");
    const { host, render } = await mounted();
    const { NotificationPermission } = await import(
      "../src/components/notifications/notification-permission"
    );
    await render(
      createElement(NotificationPermission, {
        grantedNote: "on",
        unsupportedNote: "not here",
      }),
    );
    expect(host.querySelector("button")).not.toBeNull();
  });

  test("stops rather than offering a button that would do nothing", async () => {
    // A `denied` permission cannot be re-prompted by any API.
    browserAnswers("denied");
    const { host, render } = await mounted();
    const { NotificationPermission } = await import(
      "../src/components/notifications/notification-permission"
    );
    await render(
      createElement(NotificationPermission, {
        grantedNote: "on",
        unsupportedNote: "not here",
      }),
    );
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).not.toBe("not here");
    expect(host.textContent?.length).toBeGreaterThan(0);
  });

  test("says it is on once there is nothing left to ask for", async () => {
    browserAnswers("granted");
    const { host, render } = await mounted();
    const { NotificationPermission } = await import(
      "../src/components/notifications/notification-permission"
    );
    await render(
      createElement(NotificationPermission, {
        grantedNote: "on",
        unsupportedNote: "not here",
      }),
    );
    expect(host.textContent).toBe("on");
  });

  test("the Settings row is the one that asks for the unsupported sentence", () => {
    expect(read("routes/_authed/settings/index.tsx")).toContain(
      "unsupportedNote",
    );
  });
});

describe("the Delete button", () => {
  /*
   * The gate is the browser's copy of the server's rule (`server/src/account/routes.ts` trims and
   * lower-cases both sides), and the danger of having a copy at all is that it drifts STRICTER —
   * a grey button in front of somebody who typed something the server would have taken. So the
   * cases below are mostly about what it must still accept.
   */
  test("waits for the whole address, not for one character", () => {
    expect(confirms("", "dev@laf.local")).toBe(false);
    expect(confirms("d", "dev@laf.local")).toBe(false);
    expect(confirms("dev@laf.loca", "dev@laf.local")).toBe(false);
  });

  test("accepts the address", () => {
    expect(confirms("dev@laf.local", "dev@laf.local")).toBe(true);
  });

  test("accepts what the server would accept, and nothing narrower", () => {
    expect(confirms("  dev@laf.local  ", "dev@laf.local")).toBe(true);
    expect(confirms("DEV@LAF.LOCAL", "dev@laf.local")).toBe(true);
    expect(confirms("dev@laf.local", "  Dev@LAF.local ")).toBe(true);
  });

  test("refuses a different address, and one with something appended", () => {
    expect(confirms("someone@else.com", "dev@laf.local")).toBe(false);
    expect(confirms("dev@laf.localx", "dev@laf.local")).toBe(false);
  });

  test("refuses everything while the address is not known yet", () => {
    // `/api/me` in flight, and no refusal from the server yet. There is nothing to compare against,
    // so there is nothing to press.
    expect(confirms("dev@laf.local", null)).toBe(false);
    expect(confirms("", null)).toBe(false);
    expect(confirms("   ", "   ")).toBe(false);
  });

  test("the address is shown, so the first press is not what teaches it", () => {
    const source = read("routes/_authed/settings/account.tsx");
    expect(source).toContain("expects ?? currentUser?.email");
    expect(source).toContain("Type {email} to confirm.");
    // The server still decides: the POST is unchanged and `expects` outranks the session's copy.
    expect(source).toContain("/api/me/delete");
  });
});

describe("the Take a copy button", () => {
  test("says the press was heard, then comes back", async () => {
    // It was a bare link. Pressed, nothing visibly happened while the server walked the account,
    // and the second and third press each started another export of the same thing.
    const { click, host, render, settle } = await mounted();
    const { ExportButton } = await import(
      "../src/components/settings/export-button"
    );
    await render(createElement(ExportButton, { holdMs: 30 }));
    const link = host.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/api/me/export");
    expect(link?.getAttribute("aria-disabled")).toBe("false");
    const before = host.textContent;

    if (link) await click(link);
    expect(host.querySelector("a")?.getAttribute("aria-disabled")).toBe("true");
    expect(host.textContent).not.toBe(before);

    await settle(60);
    expect(host.querySelector("a")?.getAttribute("aria-disabled")).toBe(
      "false",
    );
    expect(host.textContent).toBe(before);
  });

  test("is held by a class, because `disabled` on an anchor is ignored", async () => {
    const { click, host, render } = await mounted();
    const { ExportButton } = await import(
      "../src/components/settings/export-button"
    );
    await render(createElement(ExportButton, { holdMs: 5000 }));
    const link = host.querySelector("a");
    if (link) await click(link);
    expect(host.querySelector("a")?.className).toContain("pointer-events-none");
  });
});

describe("the Account row", () => {
  test("is held at its height while /api/me is in flight", () => {
    // It rendered an empty title and no email until the answer came back, so the screen jumped on
    // every load and briefly showed a blank row with a 로그아웃 button beside it.
    expect(read("routes/_authed/settings/index.tsx")).toContain("Skeleton");
  });

  test("does not carry a second way to 연결", () => {
    // The rail carries it and, below `lg`, so does the row at the top of the pane. A third copy on
    // the page itself is a person wondering which of them is the different one.
    expect(read("routes/_authed/settings/index.tsx")).not.toContain(
      "/settings/connected-accounts",
    );
  });
});
