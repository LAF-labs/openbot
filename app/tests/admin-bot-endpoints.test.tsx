import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { AGENT_REFUSALS } from "../src/lib/agents/mutations";
import { ko } from "../src/lib/i18n-ko";
import {
  APP_DOM_TIMEOUT_MS,
  type ApiAnswer,
  agentFixture,
  CURRENT_USER,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * THE ENDPOINTS PAGE IS NOT DRAWN WHERE THE SERVER WOULD REFUSE WHAT IT SENDS.
 *
 * `/admin/bots` points a Bot at an AG-UI agent somebody hosts themselves. A hosted deployment takes
 * no such endpoint (the owner, 2026-10-06): `PATCH /api/agents/:id` refuses one there, and so does
 * the connection test. On a one-VM-per-person deployment the person IS the administrator, so the
 * page was offered to exactly the people it would refuse — a field, a 연결 확인 button and a 저장
 * button that could only ever answer no. "A control that saves and does nothing is worse than no
 * control":
 * the server says whether it takes an endpoint (`deployment.botEndpoints` on `/api/me`), and where
 * it does not, nothing on the admin screens leads to the page and the page itself says why in one
 * sentence.
 *
 * THREE WAYS IN, NOT ONE. The rail, the row of the same links that replaces it on a narrow window,
 * and the admin index all list the page — and the rail's own comment says it must agree with the
 * index. All three are held here, and so is the address typed by hand.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
// A test that timed out never reached its own unmount; nothing it mounted outlives it.
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const SENTENCE =
  "Every Bot runs on this deployment. It cannot be pointed at another server here.";
const BOT = "agent_2f1c9a3e-7d24-4a6b-9b1e-0c8f5d2a7b41";

/** The server as it answers an administrator, on a deployment that does or does not take one. */
const serverThat =
  (botEndpoints: boolean | undefined): ApiAnswer =>
  ({ pathname }) => {
    if (pathname === "/api/me") {
      return json({
        user: { ...CURRENT_USER, role: "admin", onboarded: true },
        deployment: {
          autoReview: true,
          ...(botEndpoints === undefined ? {} : { botEndpoints }),
        },
      });
    }
    if (pathname === "/api/agents") {
      return json({
        agents: [
          agentFixture({
            id: BOT,
            name: "초롱",
            // What a hosted server says of a Bot's address: nothing. A developer's says the row's.
            endpoint: botEndpoints ? "http://localhost:4200/ag-ui" : null,
          }),
        ],
      });
    }
    if (pathname === "/api/admin/credentials") {
      return json({ credentials: KEYS });
    }
    return undefined;
  };

/**
 * What the vault holds, as the credentials page is told: a key somebody stored for a Bot's own
 * server while that was taken, one for a Bot's server that was since retired, and a model's key.
 */
const KEYS = [
  {
    id: "credential-agent",
    kind: "agent",
    provider: "ag-ui",
    keyId: BOT,
    metadata: { header: "Authorization" },
    revokedAt: null,
  },
  {
    id: "credential-agent-retired",
    kind: "agent",
    provider: "ag-ui",
    keyId: "agent_retired",
    metadata: { header: "Authorization" },
    revokedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    id: "credential-model",
    kind: "model",
    provider: "openrouter",
    keyId: "default",
    metadata: {},
    revokedAt: null,
  },
];

/**
 * Where the links on screen that lead to a page go — as strings. Never the elements themselves: a
 * failed comparison prints what it received, and a DOM node printed whole is the page.
 */
const linksTo = (host: Element, page: string) =>
  [...host.querySelectorAll("a")]
    .map((link) => link.getAttribute("href") ?? "")
    .filter((href) => href.endsWith(page));
const linksToThePage = (host: Element) => linksTo(host, "/admin/bots");
const textOf = (element: Element | null) => element?.textContent ?? "";

describe("the endpoints page, on a deployment that takes no endpoint for a Bot", () => {
  test("nothing on the admin screens leads to it: not the rail, not the row that stands in for the rail, not the index", async () => {
    const view = await mountApp({
      path: "/admin",
      role: "admin",
      api: serverThat(false),
    });
    try {
      expect(linksToThePage(view.host)).toEqual([]);
      expect(textOf(view.host)).not.toContain("Bot endpoints");
      // The pages beside it are all still listed, in all three places.
      for (const beside of ["/admin/plugins", "/admin/components"]) {
        expect(linksTo(view.host, beside)).toHaveLength(3);
      }
    } finally {
      await view.unmount();
    }
  });

  test("a server that does not say is read as one that takes none", async () => {
    const view = await mountApp({
      path: "/admin",
      role: "admin",
      api: serverThat(undefined),
    });
    try {
      expect(linksToThePage(view.host)).toEqual([]);
    } finally {
      await view.unmount();
    }
  });

  test("reached by its address, it draws its title and one sentence — no Bot, no field, no button", async () => {
    const view = await mountApp({
      path: "/admin/bots",
      role: "admin",
      api: serverThat(false),
    });
    try {
      const main = view.main();
      expect(textOf(main)).toContain("Bot endpoints");
      expect(textOf(main)).toContain(SENTENCE);
      expect(main?.querySelectorAll("input").length).toBe(0);
      expect(main?.querySelectorAll("button").length).toBe(0);
      expect(main?.querySelectorAll("details").length).toBe(0);
      // Nothing of a Bot is drawn: not its name, and not the sentence that offered the page.
      expect(textOf(main)).not.toContain("초롱");
      expect(textOf(main)).not.toContain("Point a Bot at an agent");
      expect(textOf(main)).not.toContain("No Bots yet");
    } finally {
      await view.unmount();
    }
  });

  test("the sentence is the refusal's own, and both are said in Korean without a word for operators only", () => {
    // One fact, one wording: what the page says is what the server's refusal is shown as.
    expect(AGENT_REFUSALS["laf:agent_endpoint_not_taken"]).toBe(SENTENCE);
    const said = ko[SENTENCE] ?? "";
    expect(said).toBe(
      "모든 봇은 이 서버에서 실행돼요. 여기서는 다른 서버로 연결할 수 없어요.",
    );
    // The person who reads a refusal may be anybody: 해요체, and nobody is addressed as 사장님.
    expect(said).not.toContain("사장님");
    expect(said).not.toContain("엔드포인트");
  });
});

describe("the endpoints page, on a developer's stack", () => {
  test("is listed in all three places, and draws each Bot with its address, a key box and its buttons", async () => {
    const index = await mountApp({
      path: "/admin",
      role: "admin",
      api: serverThat(true),
    });
    try {
      expect(linksToThePage(index.host)).toHaveLength(3);
    } finally {
      await index.unmount();
    }

    const view = await mountApp({
      path: "/admin/bots",
      role: "admin",
      api: serverThat(true),
    });
    try {
      const main = view.main();
      await view.waitFor(
        () => (main?.querySelectorAll("details").length ?? 0) === 1,
        "the Bot's row",
      );
      expect(textOf(main)).toContain("초롱");
      expect(textOf(main)).not.toContain(SENTENCE);
      const fields = [...(main?.querySelectorAll("input") ?? [])];
      expect(fields.map((field) => field.getAttribute("type"))).toEqual([
        null,
        "password",
      ]);
      expect((fields[0] as HTMLInputElement).value).toBe(
        "http://localhost:4200/ag-ui",
      );
      expect(
        [...(main?.querySelectorAll("button") ?? [])].map((button) =>
          button.textContent?.trim(),
        ),
      ).toEqual(["Test", "Save"]);
    } finally {
      await view.unmount();
    }
  });
});

/*
 * THE ONE PLACE A STORED KEY CAN STILL BE REMOVED, AND IT SAID "IN USE" (the independent read of
 * #121). `/admin/credentials` lists a key stored for a Bot's own server as `agent · <bot id> · in
 * use`, with Revoke. On a hosted deployment nothing reads that key: the Bot is dialled at the
 * deployment's own agent and the vault is not asked. The row has to stay — it is how the person
 * takes the key back — so the words are made true instead: not used here.
 */
describe("a key stored for a Bot's own server, on the credentials page", () => {
  /** Each row as a person reads it: the line under the provider, and whether Revoke can be pressed. */
  const rowsOf = (main: Element | null) =>
    [...(main?.querySelectorAll('[data-slot="item-content"]') ?? [])].map(
      (content) => ({
        line: content
          .querySelector('[data-slot="item-description"]')
          ?.textContent?.replace(/\s+/g, " ")
          .trim(),
        revocable:
          content.parentElement?.querySelector("button")?.disabled === false,
      }),
    );
  const drawn = async (botEndpoints: boolean | undefined) => {
    const view = await mountApp({
      path: "/admin/credentials",
      role: "admin",
      api: serverThat(botEndpoints),
    });
    await view.waitFor(
      () => rowsOf(view.main()).length === KEYS.length,
      "the three keys",
    );
    return view;
  };

  test("is not said to be in use where nothing reads it — and can still be revoked there", async () => {
    for (const botEndpoints of [false, undefined]) {
      const view = await drawn(botEndpoints);
      try {
        expect(rowsOf(view.main())).toEqual([
          { line: `agent · ${BOT} · not used here`, revocable: true },
          // A retired key is retired, whatever it was for.
          { line: "agent · agent_retired · retired", revocable: false },
          // And every other kind of key is what it was: this deployment does read those.
          { line: "model · default · in use", revocable: true },
        ]);
      } finally {
        await view.unmount();
      }
    }
    // Said in Korean, beside 사용 중 and 폐기됨.
    expect(ko["not used here"]).toBe("여기서는 쓰지 않음");
  });

  test("is in use on a developer's stack, where a Bot is dialled with it", async () => {
    const view = await drawn(true);
    try {
      expect(rowsOf(view.main())).toEqual([
        { line: `agent · ${BOT} · in use`, revocable: true },
        { line: "agent · agent_retired · retired", revocable: false },
        { line: "model · default · in use", revocable: true },
      ]);
    } finally {
      await view.unmount();
    }
  });
});
