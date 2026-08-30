import { afterEach, describe, expect, test } from "bun:test";
import { openConsent } from "../src/components/plugins/connections";

/**
 * Where a vendor's consent screen opens, which is two different answers on two surfaces.
 *
 * The failure this prevents is only visible on the installed app: a consent opened INSIDE the
 * webview is refused outright by some vendors, and even where it is not, it replaces the app with
 * somebody else's sign-in page. Both directions are silent — nothing throws, the person simply ends
 * up somewhere they cannot finish — so the decision is a function and this is the tether.
 */

type WindowWithTauri = typeof globalThis & { __TAURI__?: unknown };

const opened: string[] = [];

function inShell(): void {
  (globalThis as WindowWithTauri).__TAURI__ = {
    core: {
      invoke: async (command: string, args: { url?: string }) => {
        if (command === "open_external" && args?.url) opened.push(args.url);
      },
    },
  };
}

afterEach(() => {
  (globalThis as WindowWithTauri).__TAURI__ = undefined;
  opened.length = 0;
});

const CONSENT = "https://mcp.notion.com/authorize?client_id=abc&state=sealed";

describe("handing over a consent screen", () => {
  test("in a browser tab this window goes to the vendor", async () => {
    const navigated: string[] = [];
    const where = await openConsent(CONSENT, (url) => navigated.push(url));

    expect(where).toBe("here");
    expect(navigated).toEqual([CONSENT]);
    expect(opened).toEqual([]);
  });

  test("in the desktop shell the browser gets it and this window stays put", async () => {
    inShell();
    const navigated: string[] = [];
    const where = await openConsent(CONSENT, (url) => navigated.push(url));

    expect(where).toBe("browser");
    expect(opened).toEqual([CONSENT]);
    // The assertion that matters: the app is still on screen. A shell that both opened the browser
    // and navigated itself would leave the person's app showing a page they are not going to use.
    expect(navigated).toEqual([]);
  });

  test("a shell that refuses falls back to this window rather than nowhere", async () => {
    (globalThis as WindowWithTauri).__TAURI__ = {
      core: {
        invoke: async () => {
          throw new Error("the shell said no");
        },
      },
    };
    const navigated: string[] = [];
    const where = await openConsent(CONSENT, (url) => navigated.push(url));

    expect(where).toBe("here");
    expect(navigated).toEqual([CONSENT]);
  });
});
