import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import {
  type ComputerClient,
  createComputerClient,
  STALE_REFS,
  StaleSnapshotError,
} from "../src/computer/client";
import { DEFAULT_ACTION_POLICY } from "../src/computer/default-policy";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";

/**
 * AN ACTION IS JUDGED AGAINST THE PAGE IT LANDS ON, OR IT DOES NOT LAND.
 *
 * Measured 2026-09-26 against the real computer, with these answers exactly: a `target=_blank` link
 * to a bank answered `url` = the blog it was clicked on and `page.url` = the bank, the gateway kept
 * the blog in its cache — not even stale — and the Bot's next Enter with no ref was judged on the
 * blog: the money-host rule asked nobody, and the audit row named the blog. A tab a page's own
 * script opened was worse, because no answer said anything at all.
 *
 * The fake computer below keeps a generation the way `agent-computer` does and refuses a ref-less key
 * held to another (`actions.ts`), so what is tested is the gateway's half: it follows `page.url`, it
 * sends the generation it judged against, and a refusal makes it look again rather than trust the
 * page it just failed to land on.
 */

const BLOG = "https://blog.example.com/post";
const BANK = "https://obank.kbstar.com/transfer";

type Pressed = { key: string; snapshotId?: number; on: string };

/** One Bot's computer: a tab, a generation that moves when the tab changes, and presses by page. */
function fakeComputer() {
  const state = { url: BLOG, generation: 3 };
  const pressed: Pressed[] = [];
  /** The refusal as the real client raises it: the code, and where the computer says the Bot is. */
  const movedFrom = () => {
    const stale = new StaleSnapshotError(STALE_REFS);
    stale.page = { url: state.url, generation: state.generation };
    return stale;
  };
  const sent: {
    key?: Record<string, unknown>;
    scroll?: Record<string, unknown>;
  } = {};
  const client = {
    snapshot: async () => {
      state.generation += 1;
      return {
        snapshotId: state.generation,
        url: state.url,
        title: "",
        truncated: false,
        elements:
          state.url === BLOG
            ? [{ ref: "e5", role: "link", name: "read more" }]
            : [{ ref: "f1e2", role: "button", name: "확인" }],
      };
    },
    /** A link that opens the bank in a tab of its own, as `agent-computer` answers it. */
    click: async () => {
      const from = state.url;
      state.url = BANK;
      return {
        action: "click",
        ref: "e5",
        url: from,
        page: { url: BANK, title: "Bank", text: "송금" },
        generation: state.generation,
        elapsedMs: 5,
      };
    },
    key: async (input: { key: string; snapshotId?: number }) => {
      sent.key = { ...input };
      if (
        input.snapshotId !== undefined &&
        input.snapshotId !== state.generation
      ) {
        throw movedFrom();
      }
      pressed.push({
        key: input.key,
        snapshotId: input.snapshotId,
        on: state.url,
      });
      return {
        action: "key",
        key: input.key,
        url: state.url,
        generation: state.generation,
        elapsedMs: 5,
      };
    },
    scroll: async (input: { deltaY?: number; snapshotId?: number }) => {
      sent.scroll = { ...input };
      if (
        input.snapshotId !== undefined &&
        input.snapshotId !== state.generation
      ) {
        throw movedFrom();
      }
      return {
        action: "scroll",
        url: state.url,
        generation: state.generation,
        elapsedMs: 5,
      };
    },
    read: async () => ({
      url: state.url,
      title: "",
      text: "",
      truncated: false,
      generation: state.generation,
    }),
    takeControl: async () => ({ holder: "human", since: "", requested: false }),
    releaseControl: async () => {
      state.generation += 1;
      return { holder: "bot", since: "", requested: false };
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  /** What a page's own script does: a tab opens and becomes the Bot's, and nobody is told. */
  const popUp = (url: string) => {
    state.url = url;
    state.generation += 1;
  };
  return { client, pressed, sent, popUp, state };
}

function gatewayOver(policy: ActionPolicy = DEFAULT_ACTION_POLICY) {
  const computer = fakeComputer();
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const gateway = createComputerGateway({
    client: computer.client,
    auditStore,
    policy: () => policy,
  });
  return { gateway, rows, ...computer };
}

const ACTOR = { id: "dev-local-user" };
const BOT = "bot1";

async function outcomeOf(work: Promise<unknown>) {
  try {
    await work;
    return "done";
  } catch (error) {
    if (error instanceof ActionNeedsApprovalError) return "asked";
    if (error instanceof ActionRefusedError) return `refused ${error.message}`;
    if (error instanceof StaleSnapshotError) return "stale";
    throw error;
  }
}

/** The page every row about a ref-less key names, in the order they were written. */
const keyRowPages = (rows: AuditEventInput[]) =>
  rows
    .filter((row) => JSON.stringify(row.payload).includes("computer_key"))
    .map((row) => (row.payload as { page?: unknown }).page);

describe("a tab a link opened", () => {
  test("the next ref-less Enter is judged on the bank, not the blog it was clicked on", async () => {
    const { gateway, rows, pressed } = gatewayOver();
    await gateway.snapshot(BOT, { botId: BOT, actor: ACTOR });
    await gateway.click(BOT, BOT, ACTOR, { ref: "e5", snapshotId: 4 });

    // The cache follows `page.url` and knows its picture of the bank is not a look: blind.
    expect(
      await outcomeOf(gateway.key(BOT, BOT, ACTOR, { key: "Enter" })),
    ).toBe("refused laf:blind_action");
    expect(pressed).toEqual([]);

    // Looked at, the bank is judged as the bank: pressing anything there is a question.
    await gateway.snapshot(BOT, { botId: BOT, actor: ACTOR });
    expect(
      await outcomeOf(gateway.key(BOT, BOT, ACTOR, { key: "Enter" })),
    ).toBe("asked");
    expect(pressed).toEqual([]);
    // No row about the key names the blog.
    expect(
      keyRowPages(rows).some((page) => String(page).includes("blog")),
    ).toBe(false);
    expect(
      keyRowPages(rows).some((page) => String(page).includes("kbstar.com")),
    ).toBe(true);
  });
});

describe("a tab the page's own script opened", () => {
  test("the key is held to the look it was judged on, refused, and nothing is pressed", async () => {
    const { gateway, rows, pressed, sent, popUp } = gatewayOver();
    const look = await gateway.snapshot(BOT, { botId: BOT, actor: ACTOR });
    popUp(BANK);

    // Judged on the blog — nobody told the server otherwise — and so held to the blog's generation.
    expect(
      await outcomeOf(gateway.key(BOT, BOT, ACTOR, { key: "Enter" })),
    ).toBe("stale");
    expect(sent.key?.snapshotId).toBe(look.snapshotId);
    expect(pressed).toEqual([]);

    // The picture is not trusted after that: the next key is blind until the Bot looks again, and
    // the refusal names the page the computer said the Bot is on — not the blog it was judged on…
    expect(
      await outcomeOf(gateway.key(BOT, BOT, ACTOR, { key: "Enter" })),
    ).toBe("refused laf:blind_action");
    expect(String(keyRowPages(rows).at(-1))).toContain("kbstar.com");
    // …and the look it takes shows the bank, where the key is a question.
    await gateway.snapshot(BOT, { botId: BOT, actor: ACTOR });
    expect(
      await outcomeOf(gateway.key(BOT, BOT, ACTOR, { key: "Enter" })),
    ).toBe("asked");
    expect(pressed).toEqual([]);
  });

  test("a scroll is held to the look the same way", async () => {
    const { gateway, sent, popUp } = gatewayOver();
    const look = await gateway.snapshot(BOT, { botId: BOT, actor: ACTOR });
    await gateway.scroll(BOT, BOT, ACTOR, { deltaY: 300 });
    expect(sent.scroll?.snapshotId).toBe(look.snapshotId);
    popUp(BANK);
    expect(
      await outcomeOf(gateway.scroll(BOT, BOT, ACTOR, { deltaY: 300 })),
    ).toBe("stale");
  });

  test("the generation is the server's to give: whatever the caller sent is replaced", async () => {
    const { gateway, sent } = gatewayOver();
    const look = await gateway.snapshot(BOT, { botId: BOT, actor: ACTOR });
    await gateway.key(BOT, BOT, ACTOR, { key: "Tab", snapshotId: 999 });
    expect(sent.key?.snapshotId).toBe(look.snapshotId);
  });
});

describe("the client, reading the computer's refusal", () => {
  test("keeps where the Bot is beside the code, and nothing else of the body", async () => {
    const client = createComputerClient({
      baseUrl: "http://computer.test",
      token: "t",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            error: STALE_REFS,
            code: STALE_REFS,
            stale: true,
            url: BANK,
            generation: 9,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    const refused = await client
      .forBot(BOT)
      .key({ key: "Enter", snapshotId: 4 })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(StaleSnapshotError);
    expect((refused as StaleSnapshotError).message).toBe(STALE_REFS);
    expect((refused as StaleSnapshotError).page).toEqual({
      url: BANK,
      generation: 9,
    });
  });
});

describe("a hand-back", () => {
  test("leaves the server's picture untrusted: the next ref-less key is blind", async () => {
    const { gateway, pressed } = gatewayOver();
    await gateway.snapshot(BOT, { botId: BOT, actor: ACTOR });
    await gateway.takeControl(BOT, BOT, ACTOR);
    await gateway.releaseControl(BOT, BOT, ACTOR);
    expect(
      await outcomeOf(gateway.key(BOT, BOT, ACTOR, { key: "Enter" })),
    ).toBe("refused laf:blind_action");
    expect(pressed).toEqual([]);
  });
});

describe("what the generation does not change", () => {
  const PAGE_BLIND: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

  test("a policy that reads no page still lets a key after a page move land where the cache says", async () => {
    // The generation the answer named is kept with the address, so the key is held to the page
    // the server does know about and is not refused for want of a look nothing needs.
    const { gateway, pressed } = gatewayOver(PAGE_BLIND);
    await gateway.snapshot(BOT, { botId: BOT, actor: ACTOR });
    await gateway.click(BOT, BOT, ACTOR, { ref: "e5", snapshotId: 4 });
    expect(
      await outcomeOf(gateway.key(BOT, BOT, ACTOR, { key: "Escape" })),
    ).toBe("done");
    expect(pressed).toEqual([{ key: "Escape", snapshotId: 4, on: BANK }]);
  });

  test("the Bot never sees the generation in a result", async () => {
    const { gateway } = gatewayOver(PAGE_BLIND);
    await gateway.snapshot(BOT, { botId: BOT, actor: ACTOR });
    const pressed = await gateway.key(BOT, BOT, ACTOR, { key: "Tab" });
    expect(pressed).not.toHaveProperty("generation");
    const read = await gateway.read(BOT);
    expect(read).not.toHaveProperty("generation");
  });
});
