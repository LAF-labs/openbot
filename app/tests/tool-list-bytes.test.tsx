import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GalleryComponent } from "../src/lib/copilot/gallery-registry";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiRequest,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";
import {
  acted,
  BOT_ID,
  installTurnStreams,
  removeTurnStreams,
  THREAD_ID,
  turnServer,
} from "./support/turn-server";

/**
 * THE TOOL LIST A WINDOW SENDS WITH A TURN, BYTE FOR BYTE.
 *
 * The server hashes this list (`toolsFingerprint`, `server/src/copilot.ts`) and keeps the hash with
 * the conversation: one byte of it moving opens a new epoch, and the whole conversation behind it
 * is billed again from its head. The list is also the head of what the Bot reads. So the bytes are
 * held here, for a fixed set of grants — every tool's name, description and schema, the keys of
 * each schema in their order, and the tools in theirs.
 *
 * WHERE THE BYTES CAME FROM. `tests/tool-lists/*.txt` were written by this same test on the commit
 * before the registry was the app's own, when `@copilotkit/react-core` 1.67.1 built the list
 * (`buildFrontendTools` → `createToolSchema`). They are what windows were sending. A change that
 * moves one — a schema key reordered, `additionalProperties` let through, a tool registered in
 * another place — fails here, and is a decision to re-bill every conversation, not a snapshot to
 * refresh.
 *
 * WHEN A TOOL IS CHANGED ON PURPOSE — a description reworded in `shared/tools/`, a card's schema, a
 * tool added — the lists move with it and this fails, as it should. Run it once with
 * `LAF_WRITE_TOOL_LISTS=1` to keep the new bytes, and read the diff of `tests/tool-lists/` before
 * committing it: every line there is something every open conversation will be billed again for.
 *
 * The app is mounted whole and a message is sent, so the list is read off the request itself. The
 * gallery is found with Vite's `import.meta.glob`, which `bun test` does not have, so its cards
 * are put in the registry's list here, in the order the registry sorts them.
 */

const CHANNEL = "channel_tool-list";
const LISTS = join(import.meta.dir, "tool-lists");
const GALLERY_DIR = join(import.meta.dir, "../src/components/gallery");

let gallery: GalleryComponent[] = [];
let registered: GalleryComponent[] = [];

beforeAll(async () => {
  await installAppDom();
  installTurnStreams();
  const found: GalleryComponent[] = [];
  for (const file of readdirSync(GALLERY_DIR).sort()) {
    if (!file.endsWith(".tsx")) continue;
    const module = (await import(join(GALLERY_DIR, file))) as {
      GALLERY?: GalleryComponent[];
    };
    found.push(...(module.GALLERY ?? []));
  }
  gallery = found.sort((left, right) => left.name.localeCompare(right.name));
  const registry = await import("../src/lib/copilot/gallery-registry");
  registered = registry.GALLERY_COMPONENTS;
  registered.push(...gallery);
}, APP_DOM_TIMEOUT_MS);
afterEach(async () => {
  await unmountApps();
});
setDefaultTimeout(30_000);
afterAll(async () => {
  // The registry's list is the module's, and the next file in this process reads it.
  registered.length = 0;
  removeTurnStreams();
  await removeAppDom();
});

type Grants = {
  /** The cards this Bot holds, each with the description the deployment published for it. */
  components?: { name: string; description: string }[];
  plugins?: {
    ref: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  published?: {
    name: string;
    html: string;
    css: string;
    jsFunctions: string;
    argumentSchema: Record<string, unknown>;
  }[];
};

const PLUGINS: NonNullable<Grants["plugins"]> = [
  {
    ref: "placeholder-mail/search_messages",
    toolName: "placeholder_mail__search_messages",
    description: "Search messages.",
    inputSchema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "What to look for." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        labels: { type: "array", items: { type: "string" } },
        after: {
          type: "object",
          additionalProperties: false,
          properties: { date: { type: "string", format: "date" } },
        },
      },
    },
  },
  {
    ref: "placeholder-sheet/read",
    toolName: "placeholder_sheet__read",
    // No description of the vendor's own: the registration writes one from the names.
    description: "",
    // Not an object: the registration falls back to taking anything.
    inputSchema: { type: "string" },
  },
];

const PUBLISHED: NonNullable<Grants["published"]> = [
  {
    name: "placeholderHeldCard",
    html: "<div id='t'></div>",
    css: "",
    jsFunctions: "",
    argumentSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              value: { type: "number" },
            },
            required: ["label"],
          },
        },
        tone: { enum: ["plain", "strong"] },
      },
      required: ["title"],
    },
  },
  {
    name: "placeholderUnheldCard",
    html: "<p></p>",
    css: "",
    jsFunctions: "",
    argumentSchema: { type: "object", properties: {} },
  },
];

const everyCard = () =>
  gallery.map((spec) => ({
    name: spec.name,
    description: `Published words for ${spec.name}.`,
  }));

function serverWith(grants: () => Grants) {
  const turns = turnServer({ channelId: CHANNEL });
  const api = (request: ApiRequest) => {
    const now = grants();
    if (request.pathname === `/api/components/for-agent/${BOT_ID}`) {
      return json({ components: now.components ?? [] });
    }
    if (request.pathname === `/api/plugins/for/${BOT_ID}`) {
      return json({ tools: now.plugins ?? [], skills: [] });
    }
    if (request.pathname === "/api/sandboxed/published") {
      return json({ components: now.published ?? [] });
    }
    return turns.api(request);
  };
  return { api, turns };
}

type View = Awaited<ReturnType<typeof mountApp>>;

/** Send one message and read the list off the request the window made. */
async function listSent(view: View, words: string): Promise<string> {
  const before = view.requests.length;
  const { offerDraft } = await import(
    "../src/components/channels/composer/prefill"
  );
  await acted(() => offerDraft(CHANNEL, words));
  await view.waitFor(
    () =>
      (
        view.host.querySelector('[aria-label="Message"]')?.textContent ?? ""
      ).trim() === words,
    "the words in the composer",
    4000,
  );
  const send = view.host.querySelector('button[aria-label="Send message"]');
  if (!send) throw new Error("no send button");
  await view.click(send);
  const door = `/api/turns/${THREAD_ID}`;
  const sent = () =>
    view.requests
      .slice(before)
      .find(
        (request) => request.method === "POST" && request.pathname === door,
      );
  await view.waitFor(() => sent() !== undefined, "the hand-over", 8000);
  const handed = sent();
  if (!handed) throw new Error("no hand-over");
  lastSent = JSON.stringify((handed.body as { tools: unknown }).tools);
  return lastSent;
}

async function listFor(grants: Grants): Promise<string> {
  const { api } = serverWith(() => grants);
  const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
  return listSent(view, "안녕");
}

/** The list the last hand-over carried, for keeping on purpose (see the head of this file). */
let lastSent = "";

const kept = (name: string) => {
  if (process.env.LAF_WRITE_TOOL_LISTS === "1") {
    writeFileSync(join(LISTS, `${name}.txt`), `${lastSent}\n`);
  }
  return readFileSync(join(LISTS, `${name}.txt`), "utf8").replace(/\n$/, "");
};

describe("the tool list a window sends is the one it has been sending", () => {
  test("a Bot that holds nothing: the core tools alone", async () => {
    const list = await listFor({});
    expect(list).toBe(kept("nothing-held"));
    // And it is a list: the fixture is not an empty string that anything equals.
    const names = (JSON.parse(list) as { name: string }[]).map(
      (tool) => tool.name,
    );
    expect(names.slice(0, 3)).toEqual([
      "computer_navigate",
      "computer_read",
      "computer_snapshot",
    ]);
    expect(names).toContain("skill_view");
  });

  test("every card held, each under the description the deployment published", async () => {
    expect(gallery.length).toBeGreaterThan(5);
    expect(await listFor({ components: everyCard() })).toBe(kept("every-card"));
  });

  test("two cards of the many held: the rest are registered and not offered", async () => {
    const two = everyCard().filter(
      (card) => card.name === "askChoice" || card.name === "showChecklist",
    );
    expect(two).toHaveLength(2);
    expect(await listFor({ components: two })).toBe(kept("two-cards"));
  });

  test("a connected service's tools, with a vendor's schema and one that is no object", async () => {
    expect(await listFor({ plugins: PLUGINS })).toBe(kept("services"));
  });

  test("cards written in this deployment: the held one offered, the other not", async () => {
    expect(
      await listFor({
        published: PUBLISHED,
        components: [
          { name: "placeholderHeldCard", description: "A card of rows." },
        ],
      }),
    ).toBe(kept("written-cards"));
  });

  test("everything at once", async () => {
    expect(
      await listFor({
        published: PUBLISHED,
        plugins: PLUGINS,
        components: [
          ...everyCard(),
          { name: "placeholderHeldCard", description: "A card of rows." },
        ],
      }),
    ).toBe(kept("everything"));
  });

  test("a card taken back and given again while the conversation is open", async () => {
    let now: Grants = { components: everyCard() };
    const { api, turns } = serverWith(() => now);
    const view = await mountApp({ path: `/channel/${CHANNEL}`, api });
    const { componentKeys } = await import("../src/lib/components/queries");
    const reread = async () => {
      await acted(() =>
        view.queryClient.invalidateQueries({ queryKey: componentKeys.all }),
      );
      await view.settle(50);
    };

    expect(await listSent(view, "하나")).toBe(kept("every-card"));
    await acted(() => turns.announce("done"));

    now = {
      components: everyCard().filter((card) => card.name !== "showChecklist"),
    };
    await reread();
    const without = await listSent(view, "둘");
    expect(without).toBe(kept("card-taken-back"));
    expect(without).not.toContain('"showChecklist"');
    await acted(() => turns.announce("done"));

    now = { components: everyCard() };
    await reread();
    expect(await listSent(view, "셋")).toBe(kept("card-given-again"));
  });
});
