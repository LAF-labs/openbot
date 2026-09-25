import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { stubFetch } from "./support/fetch";
import { json, mount, routerAt, unmountAll } from "./support/mount";

/**
 * 오늘, rendered: the rows the server's facts become, where a press goes, and what an empty day says.
 *
 * Mounted against a stub server rather than walked as source: the facts are the server's
 * (`GET /api/agents/:id/day`), the words are this component's, and what is asserted is what a
 * person would read and where their press lands.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3111/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const realFetch = globalThis.fetch;
afterEach(async () => {
  await unmountAll();
  globalThis.fetch = realFetch;
});

const NOW = new Date();
const later = (hours: number) =>
  new Date(NOW.getTime() + hours * 3_600_000).toISOString();
const at = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 25, hour, minute)).toISOString();

type Item = Record<string, unknown>;

const chat = (runId: string, over: Item = {}): Item => ({
  kind: "chat",
  runId,
  at: at(1),
  status: "done",
  label: "예스24에서 책 찾아 줘",
  channelId: "ch-1",
  messageId: `first-${runId}`,
  frameToolCallId: null,
  ...over,
});

const conversation = (lastMessageAt: string | null) => ({
  id: "ch-1",
  name: "초롱",
  agentIds: ["bot-1"],
  threadId: "t1",
  active: true,
  lastMessage: lastMessageAt ? "3 orders are sorted" : null,
  lastMessageAt,
  lastMessageAgentId: lastMessageAt ? "bot-1" : null,
  unread: false,
  createdAt: at(0),
});

const routine = (id: string, name: string, nextRunAt: string, over = {}) => ({
  id,
  agentId: "bot-1",
  name,
  instruction: name,
  scheduleKind: "daily",
  intervalMinutes: null,
  dailyLocal: "07:30",
  dailyTimeZone: "Asia/Seoul",
  dailyDays: null,
  enabled: true,
  lastRunAt: null,
  nextRunAt,
  ...over,
});

function server(options: {
  items: Item[];
  channels?: ReturnType<typeof conversation>[];
  routines?: ReturnType<typeof routine>[];
}) {
  const asked: string[] = [];
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = String(input);
    asked.push(init?.method === "POST" ? `POST ${url}` : url);
    // Starting a conversation for a Bot that has one answers with that one.
    if (url === "/api/channels" && init?.method === "POST") {
      return json({ channel: (options.channels ?? [conversation(at(1))])[0] });
    }
    if (url === "/api/agents/bot-1/day") {
      return json({
        day: "2026-09-25",
        zone: "Asia/Seoul",
        items: options.items,
        more: false,
      });
    }
    if (url === "/api/agents/working") return json({ working: [] });
    if (url === "/api/channels") {
      return json({ channels: options.channels ?? [conversation(at(1))] });
    }
    if (url === "/api/routines") {
      return json({ routines: options.routines ?? [] });
    }
    if (url === "/api/connections/overview") {
      return json({ sites: [], accounts: [] });
    }
    if (url === "/api/me") {
      return json({
        user: { id: "u1", email: "kim@example.com", name: "김", role: "user" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  return asked;
}

const PATHS = ["/channel/$channelId", "/channel/new", "/routines", "/agents"];

async function day(
  options: Parameters<typeof server>[0],
  where: {
    path?: string;
    placement?: "sidebar" | "drawer";
    waitingOnly?: boolean;
  } = {},
) {
  const asked = server(options);
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { RouterProvider } = await import("@tanstack/react-router");
  const { BotDay } = await import("../src/components/app-sidebar/bot-day");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = await routerAt(where.path ?? "/channel/ch-1", PATHS, () => (
    <QueryClientProvider client={client}>
      <BotDay
        botId="bot-1"
        placement={where.placement ?? "sidebar"}
        waitingOnly={where.waitingOnly ?? false}
      />
    </QueryClientProvider>
  ));
  const view = await mount(<RouterProvider router={router} />);
  await view.settle(60);
  const groups = () =>
    [...view.host.querySelectorAll("h3")].map((h) => h.textContent);
  const rows = () =>
    [...view.host.querySelectorAll<HTMLButtonElement>("section button")].map(
      (row) => row.textContent ?? "",
    );
  const button = (text: string) =>
    [...view.host.querySelectorAll<HTMLButtonElement>("button")].find((row) =>
      row.textContent?.includes(text),
    ) as HTMLButtonElement;
  return { ...view, asked, router, groups, rows, button };
}

describe("오늘", () => {
  test("each kind of work is a row, newest first, marked only when it did not finish", async () => {
    const view = await day({
      items: [
        {
          kind: "routine",
          runId: "r-silent",
          routineId: "rt-1",
          at: at(2, 30),
          status: "done",
          name: "아침 주문 확인",
          silent: true,
          channelId: "ch-1",
          messageId: null,
        },
        {
          kind: "learned",
          memoryId: "m-1",
          at: at(2),
          head: "월요일은 쉰다",
        },
        chat("c-1", { frameToolCallId: "call-1" }),
        chat("c-2", { status: "error", label: "주문서 만들어 줘" }),
      ],
    });
    expect(view.groups()).toEqual(["What it did"]);
    const rows = view.rows();
    expect(rows[0]).toContain("아침 주문 확인 · Nothing new");
    expect(rows[1]).toContain("Remembered · 월요일은 쉰다");
    expect(rows[2]).toContain("예스24에서 책 찾아 줘");
    expect(rows[3]).toContain("주문서 만들어 줘");
    expect(rows[3]).toContain("Couldn't finish");
    expect(rows[2]).not.toContain("Couldn't finish");
    // The time is on the person's day's clock: 02:30 UTC is 11:30 in Seoul.
    expect(rows[0]).toContain("11:30");

    const thumbnail = view.host.querySelector("img");
    expect(thumbnail?.getAttribute("src")).toBe(
      "/api/channels/ch-1/frames/call-1",
    );
    expect(thumbnail?.getAttribute("alt")).toBe("The last screen of this task");
  });

  test("a chat row opens the conversation; a silent routine opens its routine", async () => {
    const view = await day({
      items: [
        {
          kind: "routine",
          runId: "r-silent",
          routineId: "rt-1",
          at: at(2, 30),
          status: "done",
          name: "아침 주문 확인",
          silent: true,
          channelId: "ch-1",
          messageId: null,
        },
        chat("c-1"),
      ],
    });
    await view.press(view.button("아침 주문 확인"));
    await view.settle(30);
    expect(view.router.state.location.pathname).toBe("/routines");
    expect(view.router.state.location.hash).toBe("routine-rt-1");

    await view.press(view.button("예스24에서 책 찾아 줘"));
    await view.settle(30);
    expect(view.router.state.location.pathname).toBe("/channel/ch-1");
  });

  test("four rows in the sidebar, six in the drawer, then the rest behind one press", async () => {
    // At the PC app's smallest window the sidebar has room for four (UX review 0.5.4, item 4).
    const items = Array.from({ length: 8 }, (_, index) =>
      chat(`c-${index}`, { label: `일 ${index}` }),
    );
    const view = await day({ items });
    expect(view.rows().filter((row) => row.startsWith("일"))).toHaveLength(4);
    await view.press(view.button("Show 4 more"));
    expect(view.rows().filter((row) => row.startsWith("일"))).toHaveLength(8);
    await unmountAll();

    const drawer = await day({ items }, { placement: "drawer" });
    expect(drawer.rows().filter((row) => row.startsWith("일"))).toHaveLength(6);
  });

  test("the card's words: 못 끝냄 with why, 멈춤 for a stop, 하는 중", async () => {
    const view = await day({
      items: [
        chat("c-1", {
          status: "error",
          reason: "laf:site_refused",
          label: "쿠팡 가격",
        }),
        chat("c-2", { status: "stopped", label: "토스 앱 다운로드" }),
        chat("c-3", { status: "running", label: "날씨" }),
      ],
    });
    const rows = view.rows();
    expect(rows[0]).toContain("Couldn't finish · The site turned the Bot away");
    expect(rows[1]).toContain("Halted");
    expect(rows[2]).toContain("Working on it");
  });

  test("what a turn remembered is on its row, not three more rows", async () => {
    const view = await day({
      items: [chat("c-1", { learned: 3, label: "우리 가게 소개" })],
    });
    const rows = view.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("우리 가게 소개");
    expect(rows[0]).toContain("Remembered 3");
  });

  test("the drawer beside the full sidebar shows only what waits on the owner", async () => {
    const view = await day(
      {
        items: [chat("c-1")],
        routines: [routine("rt-1", "리뷰 확인", later(1))],
      },
      { placement: "drawer", waitingOnly: true },
    );
    expect(view.groups()).toEqual([]);
    expect(view.host.textContent).not.toContain("예스24에서 책 찾아 줘");
    expect(view.host.textContent).not.toContain("리뷰 확인");
  });

  test("the next two of this Bot's routines that are on, soonest first", async () => {
    const view = await day({
      items: [chat("c-1")],
      routines: [
        routine("rt-3", "저녁 정산", later(9)),
        routine("rt-1", "리뷰 확인", later(1)),
        routine("rt-off", "꺼 둔 것", later(0.5), { enabled: false }),
        routine("rt-2", "재고 확인", later(3)),
        routine("rt-other", "남의 봇 것", later(0.2), { agentId: "bot-2" }),
      ],
    });
    expect(view.groups()).toEqual(["What it did", "Up next"]);
    const next = view.rows().slice(-2);
    expect(next[0]).toContain("리뷰 확인");
    expect(next[1]).toContain("재고 확인");
    expect(view.host.textContent).toContain("See all routines");
  });

  test("a quiet day draws nothing for what it did; a Bot nobody has spoken to is offered first things", async () => {
    const quiet = await day({ items: [] });
    expect(quiet.groups()).toEqual([]);
    expect(quiet.asked).not.toContain("/api/connections/overview");
    await unmountAll();

    const fresh = await day({ items: [], channels: [] });
    await fresh.settle(60);
    expect(fresh.groups()).toEqual(["What it did"]);
    expect(fresh.host.textContent).toContain(
      "Nothing done yet today. Try handing over one of these.",
    );
    // Sentences from the same catalogue as the empty conversation's chips, three at most.
    const chips = [...fresh.host.querySelectorAll("section div button")];
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(3);
    await unmountAll();

    // Not beside the empty conversation, which offers the same chips under the face.
    const beside = await day(
      { items: [], channels: [] },
      { path: "/channel/new" },
    );
    await beside.settle(60);
    expect(beside.groups()).toEqual([]);
    expect(beside.host.textContent).not.toContain(
      "Nothing done yet today. Try handing over one of these.",
    );
  });
});

describe("a first thing pressed is a first thing sent", () => {
  /*
   * MEASURED 2026-09-25: on a conversation that existed but was empty, the chip put its sentence in
   * the composer, while on a fresh account the same press sent it. Starting a Bot's conversation
   * lands on the one it has; that one was already on screen, so nothing mounted to read the stash.
   */
  test("on the empty conversation already on screen, the press sends the sentence there", async () => {
    const { hearFirstMessages } = await import(
      "../src/components/channels/transcript-messages"
    );
    const { takeOfferedDraft } = await import(
      "../src/components/channels/composer/prefill"
    );
    const sent: string[] = [];
    // What `ChannelChat` does while this conversation is on screen.
    const stop = hearFirstMessages("ch-1", (text) => sent.push(text));
    try {
      const view = await day({ items: [], channels: [conversation(null)] });
      await view.settle(60);
      const chip =
        view.host.querySelector<HTMLButtonElement>("section div button");
      expect(chip).not.toBeNull();
      const sentence = chip?.textContent ?? "";
      chip?.click();
      await view.settle(60);
      expect(view.asked).toContain("POST /api/channels");
      expect(sent).toEqual([sentence]);
      expect(takeOfferedDraft("ch-1")).toBeNull();
      expect(view.router.state.location.pathname).toBe("/channel/ch-1");
    } finally {
      stop();
    }
  });

  test("with no conversation on screen, the sentence waits for the one that mounts", async () => {
    const { peekFirstMessage, forgetFirstMessage } = await import(
      "../src/components/channels/transcript-messages"
    );
    const view = await day({ items: [], channels: [conversation(null)] });
    await view.settle(60);
    const chip =
      view.host.querySelector<HTMLButtonElement>("section div button");
    const sentence = chip?.textContent ?? "";
    chip?.click();
    await view.settle(60);
    expect(peekFirstMessage("ch-1")).toBe(sentence);
    forgetFirstMessage("ch-1");
  });
});

describe("a press leaves word for the conversation it names", () => {
  test("only that conversation takes it, once; leaving drops it", async () => {
    const { mount: mountView } = await import("./support/mount");
    const { dropJump, requestJump, settleJump, usePendingJump } = await import(
      "../src/lib/channels/jump"
    );
    const seen: Record<string, string | null> = {};
    function Probe({ channelId }: { channelId: string }) {
      const jump = usePendingJump(channelId);
      seen[channelId] = jump?.messageId ?? jump?.waitingCard ?? null;
      return null;
    }
    const view = await mountView(
      <>
        <Probe channelId="ch-1" />
        <Probe channelId="ch-2" />
      </>,
    );
    const { act } = await import("react");
    await act(async () => requestJump({ channelId: "ch-1", messageId: "m-1" }));
    expect(seen).toEqual({ "ch-1": "m-1", "ch-2": null });

    // Nothing to show is no jump at all.
    await act(async () => requestJump({ channelId: "ch-2" }));
    expect(seen["ch-2"]).toBeNull();

    await act(async () => dropJump("ch-2"));
    expect(seen["ch-1"]).toBe("m-1");
    await act(async () => {
      settleJump({ channelId: "ch-1", messageId: "m-1" });
    });
    // A copy is not the jump: only the one that was taken settles it.
    expect(seen["ch-1"]).toBe("m-1");
    await act(async () => dropJump("ch-1"));
    expect(seen["ch-1"]).toBeNull();

    await act(async () =>
      requestJump({ channelId: "ch-1", waitingCard: "call-9" }),
    );
    expect(seen["ch-1"]).toBe("call-9");
    await act(async () => dropJump("ch-1"));
    await view.unmount();
  });
});

describe("the day's words", () => {
  test("every mark has its Korean", async () => {
    const { ko } = await import("../src/lib/i18n-ko");
    const { dayMark } = await import("../src/lib/agents/day");
    for (const status of [
      "done",
      "error",
      "stopped",
      "unknown",
      "running",
    ] as const) {
      const mark = dayMark(status);
      if (status === "done") {
        expect(mark).toBeNull();
        continue;
      }
      expect(mark && ko[mark.text]).toBeTruthy();
    }
  });

  test("the clock is the day's zone's, not the machine's", async () => {
    const { dayClock } = await import("../src/lib/agents/day");
    expect(dayClock("2026-09-24T22:30:00Z", "Asia/Seoul")).toContain("7:30");
    expect(dayClock("2026-09-24T22:30:00Z", "UTC")).toContain("10:30");
  });
});
