import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import {
  BotIdRefusedError,
  browserOf,
  computerIdOf,
  computerOf,
  isBrowserName,
} from "../src/computer/bot-id";
import {
  BROWSER_HEADER,
  type ComputerClient,
  createComputerClient,
  WorkspaceRequestError,
} from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";

/**
 * WHICH OF THE BOT'S BROWSERS A CALL IS FOR (2026-10-10, `docs/laf/redesign-2026-10.md` §5, piece
 * 5-3, the server's half).
 *
 * The computer holds a main browser and a few background ones (`agent-computer/src/browsers.ts`).
 * What is held here is the server's part of that: that a call says which browser it is for and
 * says nothing where it is the main one; that what the gateway keeps beside a browser — the page
 * it last saw, a person's yes, a value put in — is that browser's and not another's; and that a
 * computer's id naming somebody else's browser reaches nothing.
 */

describe("a computer's id", () => {
  test("is the Bot's for its main browser, and the Bot's and a name for another", () => {
    expect(computerIdOf("bot-1")).toBe("bot-1");
    expect(computerIdOf("bot-1", null)).toBe("bot-1");
    expect(computerIdOf("bot-1", "run-7")).toBe("bot-1@run-7");
    expect(computerOf("bot-1")).toEqual({ botId: "bot-1", browser: null });
    expect(computerOf("bot-1@run-7")).toEqual({
      botId: "bot-1",
      browser: "run-7",
    });
  });

  test.each([
    // The main browser, whatever the caller calls it: an id with no browser in it.
    { computerId: "bot-1", botId: "bot-1", browser: null },
    { computerId: "default", botId: "bot-1", browser: null },
    { computerId: "bot-1@run-7", botId: "bot-1", browser: "run-7" },
    {
      computerId: "bot-1@routine.7f3c_2",
      botId: "bot-1",
      browser: "routine.7f3c_2",
    },
  ])(
    "$computerId, acting as $botId, is browser $browser",
    ({ computerId, botId, browser }) => {
      expect(browserOf(computerId, botId)).toBe(browser);
    },
  );

  test.each([
    // Another Bot's browser.
    { computerId: "bot-2@run-7", botId: "bot-1" },
    // A browser's name that is not one: a path, nothing, a second `@`.
    { computerId: "bot-1@../profiles", botId: "bot-1" },
    { computerId: "bot-1@", botId: "bot-1" },
    { computerId: "bot-1@a@b", botId: "bot-1" },
    { computerId: "@run-7", botId: "bot-1" },
  ])(
    "$computerId, acting as $botId, is refused and never read as the main browser",
    ({ computerId, botId }) => {
      expect(() => browserOf(computerId, botId)).toThrow(BotIdRefusedError);
    },
  );

  test.each(["run-1", "a", "routine.7f3c_2", "x".repeat(128)])(
    "%p is a browser's name",
    (name) => {
      expect(isBrowserName(name)).toBe(true);
    },
  );

  test.each([
    "",
    "../x",
    "a/b",
    "a b",
    ".hidden",
    "a@b",
    "x".repeat(129),
    null,
  ])("%p is not", (name) => {
    expect(isBrowserName(name)).toBe(false);
  });
});

describe("the client", () => {
  /** A computer that records every request it was sent and answers each with the same body. */
  const recorded = (answer: unknown = { ok: true }) => {
    const seen: { path: string; headers: Headers }[] = [];
    const client = createComputerClient({
      baseUrl: "http://computer.test",
      token: "t",
      fetchImpl: (async (input: Request | string | URL, init?: RequestInit) => {
        seen.push({
          path: new URL(String(input)).pathname,
          headers: new Headers(init?.headers),
        });
        return new Response(JSON.stringify(answer), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    return { client, seen };
  };

  test("names the browser on every call of a view that has one, and says nothing for the main one", async () => {
    const { client, seen } = recorded({
      url: "https://example.com/",
      text: "",
    });
    await client.forBot("bot-1").read();
    await client.forBot("bot-1", null).read();
    await client.forBot("bot-1", "run-7").read();
    await client.forBot("bot-1", "run-7").control();

    expect(seen.map((one) => one.headers.get(BROWSER_HEADER))).toEqual([
      null,
      null,
      "run-7",
      "run-7",
    ]);
    // The Bot is named as it always was, beside it.
    expect(seen.map((one) => one.headers.get("x-openbot-bot-id"))).toEqual([
      "bot-1",
      "bot-1",
      "bot-1",
      "bot-1",
    ]);
  });

  test("refuses a browser's name that is not one before anything is sent", async () => {
    const { client, seen } = recorded();
    await expect(client.forBot("bot-1", "../profiles").read()).rejects.toThrow(
      BotIdRefusedError,
    );
    expect(seen).toEqual([]);
  });

  test("opens and lets go of the browser its view names, and hands back the computer's answer", async () => {
    const full = recorded({ opened: false, open: 2, cap: 2 });
    expect(await full.client.forBot("bot-1", "run-9").openBrowser()).toEqual({
      opened: false,
      open: 2,
      cap: 2,
    });
    expect(
      full.seen.map((one) => [one.path, one.headers.get(BROWSER_HEADER)]),
    ).toEqual([["/browsers/open", "run-9"]]);

    const gone = recorded({ released: true });
    expect(await gone.client.forBot("bot-1", "run-9").releaseBrowser()).toEqual(
      {
        released: true,
      },
    );
    expect(
      gone.seen.map((one) => [one.path, one.headers.get(BROWSER_HEADER)]),
    ).toEqual([["/browsers/release", "run-9"]]);
  });
});

/*
 * THE GATEWAY, AGAINST A COMPUTER THAT KEEPS EACH BROWSER'S PAGE APART as the real one does: a
 * view is a Bot in a browser, and what it is asked is recorded under that browser's own id.
 */
const PAGE = (url: string, snapshotId: number): SnapshotResult => ({
  snapshotId,
  url,
  title: "Order",
  truncated: false,
  elements: [{ ref: "e9", role: "button", name: "주문하기" }],
});

function computer(pages: Record<string, SnapshotResult>) {
  /** Every call, as `<computer's id>:<what was asked>`. */
  const calls: string[] = [];
  /** Which background browsers answer; one let go of answers as the computer does for a name nobody opened. */
  const open = new Set<string>();
  const view = (botId: string, browser?: string | null) => {
    const id = computerIdOf(botId, browser);
    const there = () => {
      if (browser && !open.has(id)) throw new WorkspaceRequestError("browser");
    };
    const said =
      <T>(what: string, answer: T) =>
      async (): Promise<T> => {
        there();
        calls.push(`${id}:${what}`);
        return answer;
      };
    const page = () => pages[id] ?? PAGE("about:blank", 1);
    return {
      snapshot: async () => {
        there();
        calls.push(`${id}:snapshot`);
        return page();
      },
      read: said("read", {
        url: page().url,
        title: "",
        text: "",
        truncated: false,
      }),
      click: said("click", { action: "click", url: page().url, elapsedMs: 1 }),
      requestSecret: async (input: {
        fields: { label: string; ref: string }[];
      }) => {
        there();
        calls.push(`${id}:requestSecret`);
        return {
          holder: "bot",
          since: "2026-10-10T00:00:00.000Z",
          requested: false,
          secretWanted: input.fields.map((field) => field.label).join(", "),
          secretRef: input.fields[0]?.ref,
          secretFields: input.fields,
        };
      },
      supplySecret: said("supplySecret", { characters: 7 }),
      control: said("control", {
        holder: "bot",
        since: "2026-10-10T00:00:00.000Z",
        requested: false,
      }),
      stopComputer: said("stopComputer", { stopped: true, wasRunning: true }),
      runEnded: said("runEnded", { ended: true, closed: 1 }),
      openBrowser: async () => {
        calls.push(`${id}:openBrowser`);
        open.add(id);
        return { opened: true, open: open.size, cap: 2 };
      },
      releaseBrowser: async () => {
        calls.push(`${id}:releaseBrowser`);
        return { released: open.delete(id) };
      },
    };
  };
  const client = {
    forBot: (botId: string, browser?: string | null) => view(botId, browser),
  } as unknown as ComputerClient;
  /** The computer gave the browser's place away, or started again: nothing is open under the id. */
  const vanish = (id: string) => void open.delete(id);
  return { client, calls, vanish };
}

const ACTOR = { id: "dev-local-user" };
const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };
const ASKS_ABOUT_BUTTONS: ActionPolicy = {
  deny: [],
  ask: ['element.role == "button"'],
  allow: ["true"],
};

function gatewayOn(
  pages: Record<string, SnapshotResult>,
  policy: ActionPolicy = PERMISSIVE,
) {
  const { client, calls, vanish } = computer(pages);
  const rows: AuditEventInput[] = [];
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  const approvals = createApprovalRegistry();
  const gateway = createComputerGateway({
    client,
    auditStore: store,
    policy: () => policy,
    approvals,
  });
  return { gateway, calls, rows, approvals, vanish };
}

const BACKGROUND = computerIdOf("bot-1", "run-7");
const CLICK = { ref: "e9", snapshotId: 3 };

describe("the gateway", () => {
  test("carries a call out in the browser its computer's id names, and in the main one for the Bot's own id", async () => {
    const { gateway, calls } = gatewayOn({});
    await gateway.openBrowser("bot-1", "run-7");
    await gateway.snapshot("bot-1", { botId: "bot-1", actor: ACTOR });
    await gateway.click("bot-1", "bot-1", ACTOR, CLICK);
    await gateway.snapshot(BACKGROUND, { botId: "bot-1", actor: ACTOR });
    await gateway.click(BACKGROUND, "bot-1", ACTOR, CLICK);
    await gateway.read(BACKGROUND);

    expect(calls).toEqual([
      "bot-1@run-7:openBrowser",
      "bot-1:snapshot",
      "bot-1:click",
      "bot-1@run-7:snapshot",
      "bot-1@run-7:click",
      "bot-1@run-7:read",
    ]);
  });

  test("what was seen in one browser is not what a ref means in another", async () => {
    const { gateway, rows } = gatewayOn({
      "bot-1": PAGE("https://shop.example/cart", 3),
    });
    await gateway.openBrowser("bot-1", "run-7");
    // Only the main browser has been looked at: `e9` is its 주문하기.
    await gateway.snapshot("bot-1", { botId: "bot-1", actor: ACTOR });
    await gateway.click("bot-1", "bot-1", ACTOR, CLICK);
    // The same ref in the background browser, which nobody has looked at: it names nothing there,
    // and the gate is not told it is a button on the cart page.
    await gateway.click(BACKGROUND, "bot-1", ACTOR, CLICK);

    const [inMain, inBackground] = rows.filter(
      (row) => row.eventType === "computer.action_allowed",
    );
    expect(inMain?.payload.element).toEqual({
      role: "button",
      name: "주문하기",
    });
    expect(inMain?.targetId).toBe("bot-1");
    expect(inBackground?.payload.element).toBe("laf:element_not_in_snapshot");
    // And the row says which computer it was, under the same Bot.
    expect(inBackground?.targetId).toBe("bot-1@run-7");
    expect(inBackground?.payload.bot).toBe("bot-1");
  });

  test("a computer that is another Bot's browser is refused before anything reaches it or is written", async () => {
    const { gateway, calls, rows } = gatewayOn({});
    await expect(
      gateway.click("bot-2@run-7", "bot-1", ACTOR, CLICK),
    ).rejects.toThrow(BotIdRefusedError);
    await expect(
      gateway.click("bot-1@../profiles", "bot-1", ACTOR, CLICK),
    ).rejects.toThrow(BotIdRefusedError);
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });

  test("a person's yes to an act in one browser is not a yes to it in another", async () => {
    const same = PAGE("https://shop.example/cart", 3);
    const { gateway, calls, approvals } = gatewayOn(
      { "bot-1": same, [BACKGROUND]: same },
      ASKS_ABOUT_BUTTONS,
    );
    await gateway.openBrowser("bot-1", "run-7");
    await gateway.snapshot("bot-1", { botId: "bot-1", actor: ACTOR });
    await gateway.snapshot(BACKGROUND, { botId: "bot-1", actor: ACTOR });

    const asked = (await gateway
      .click("bot-1", "bot-1", ACTOR, CLICK)
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    await approvals.answer(asked.approvalId, "bot-1", "manager-user", true);

    // The same button, the same address, the same ref — in the other browser. Asked again.
    const again = await gateway
      .click(BACKGROUND, "bot-1", ACTOR, CLICK, undefined, asked.approvalId)
      .catch((caught: unknown) => caught);
    expect(again).toBeInstanceOf(ActionNeedsApprovalError);
    expect((again as ActionNeedsApprovalError).approvalId).not.toBe(
      asked.approvalId,
    );
    expect(calls.filter((call) => call.endsWith(":click"))).toEqual([]);

    // Where it was asked, it is still a yes.
    await gateway.click(
      "bot-1",
      "bot-1",
      ACTOR,
      CLICK,
      undefined,
      asked.approvalId,
    );
    expect(calls.filter((call) => call.endsWith(":click"))).toEqual([
      "bot-1:click",
    ]);
  });

  test("letting a browser go forgets what was seen in it, and leaves the main browser's alone", async () => {
    const { gateway, calls, rows } = gatewayOn({
      "bot-1": PAGE("https://shop.example/cart", 3),
      [BACKGROUND]: PAGE("https://shop.example/cart", 3),
    });
    expect(await gateway.openBrowser("bot-1", "run-7")).toEqual({
      opened: true,
      open: 1,
      cap: 2,
    });
    await gateway.snapshot("bot-1", { botId: "bot-1", actor: ACTOR });
    await gateway.snapshot(BACKGROUND, { botId: "bot-1", actor: ACTOR });
    expect(await gateway.releaseBrowser("bot-1", "run-7")).toEqual({
      released: true,
    });
    expect(calls.at(-1)).toBe("bot-1@run-7:releaseBrowser");

    // Opened again under the same name, it is a browser nobody has looked at.
    await gateway.openBrowser("bot-1", "run-7");
    await gateway.click(BACKGROUND, "bot-1", ACTOR, CLICK);
    await gateway.click("bot-1", "bot-1", ACTOR, CLICK);
    const allowed = rows.filter(
      (row) => row.eventType === "computer.action_allowed",
    );
    expect(allowed.map((row) => [row.targetId, row.payload.element])).toEqual([
      ["bot-1@run-7", "laf:element_not_in_snapshot"],
      ["bot-1", { role: "button", name: "주문하기" }],
    ]);
  });
});

describe("a value put into a background browser", () => {
  const LOGIN: SnapshotResult = {
    snapshotId: 3,
    url: "https://example.com/login",
    title: "Login",
    truncated: false,
    elements: [
      { ref: "e2", role: "textbox", name: "비밀번호", type: "password" },
    ],
  };
  const putIn = async (
    gateway: ReturnType<typeof gatewayOn>["gateway"],
    computerId: string,
    threadId: string,
  ) => {
    await gateway.snapshot(computerId, { botId: "bot-1", actor: ACTOR });
    await gateway.requestSecret(
      computerId,
      "bot-1",
      { ...ACTOR, threadId },
      { label: "비밀번호", ref: "e2", snapshotId: 3 },
    );
    await gateway.supplySecret(computerId, "bot-1", ACTOR, ["hunter2"]);
  };
  const ends = (calls: string[]) =>
    calls.filter((call) => call.endsWith(":runEnded"));

  test("is let go of by telling that browser the run is over, not the main one", async () => {
    const { gateway, calls } = gatewayOn({ [BACKGROUND]: LOGIN });
    await gateway.openBrowser("bot-1", "run-7");
    await putIn(gateway, BACKGROUND, "thread-a");
    expect(gateway.holdsValues("bot-1")).toBe(true);

    await gateway.runEnded("bot-1", "thread-a");
    expect(ends(calls)).toEqual(["bot-1@run-7:runEnded"]);
    expect(gateway.holdsValues("bot-1")).toBe(false);
  });

  test("put into both, both are told", async () => {
    const { gateway, calls } = gatewayOn({
      "bot-1": LOGIN,
      [BACKGROUND]: LOGIN,
    });
    await gateway.openBrowser("bot-1", "run-7");
    await putIn(gateway, "bot-1", "thread-a");
    await putIn(gateway, BACKGROUND, "thread-a");

    await gateway.runEnded("bot-1", "thread-a");
    expect(ends(calls).sort()).toEqual([
      "bot-1:runEnded",
      "bot-1@run-7:runEnded",
    ]);
    expect(gateway.holdsValues("bot-1")).toBe(false);
  });

  test("a browser that was let go of holds nothing by being gone, and the run's end does not fail on it", async () => {
    const { gateway, calls } = gatewayOn({ [BACKGROUND]: LOGIN });
    await gateway.openBrowser("bot-1", "run-7");
    await putIn(gateway, BACKGROUND, "thread-a");
    // Let go of by name: what was held in it went with it.
    await gateway.releaseBrowser("bot-1", "run-7");
    expect(gateway.holdsValues("bot-1")).toBe(false);
    await gateway.runEnded("bot-1", "thread-a");
    expect(ends(calls)).toEqual([]);
  });

  test("a browser that went away without this server hearing of it holds nothing by being gone", async () => {
    const { gateway, calls, vanish } = gatewayOn({ [BACKGROUND]: LOGIN });
    await gateway.openBrowser("bot-1", "run-7");
    await putIn(gateway, BACKGROUND, "thread-a");
    // The computer gave its place to another, or started again. This server still notes the value.
    vanish(BACKGROUND);
    expect(gateway.holdsValues("bot-1")).toBe(true);

    // Told of the run's end, the computer answers that nothing is open under that name — which
    // is the value having gone with the browser, not a failure to keep trying at.
    await gateway.runEnded("bot-1", "thread-a");
    expect(gateway.holdsValues("bot-1")).toBe(false);
    expect(ends(calls)).toEqual([]);
  });

  test("stopping the main browser does not forget a value a background browser still holds", async () => {
    const { gateway, calls } = gatewayOn({
      "bot-1": LOGIN,
      [BACKGROUND]: LOGIN,
    });
    await gateway.openBrowser("bot-1", "run-7");
    await putIn(gateway, "bot-1", "thread-a");
    await putIn(gateway, BACKGROUND, "thread-a");

    await gateway.stopComputer("bot-1", "bot-1", ACTOR);
    // The main browser's tabs are closed; the background one's are not.
    expect(gateway.holdsValues("bot-1")).toBe(true);
    await gateway.runEnded("bot-1", "thread-a");
    expect(ends(calls)).toEqual(["bot-1@run-7:runEnded"]);
    expect(gateway.holdsValues("bot-1")).toBe(false);
  });
});
