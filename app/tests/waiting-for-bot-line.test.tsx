import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { Message } from "@ag-ui/core";
import { mount, unmountAll } from "./support/mount";

/**
 * THE LINE UNDER A TURN THAT IS WAITING FOR THE BOT, AND THE WAIT BEFORE IT IS SAID.
 *
 * `turn-waiting-for-bot.test.tsx` holds the whole conversation to it; these hold the two pieces it
 * is made of: where the transcript draws the line and what it gives way to, and the hook that keeps
 * the momentary `queued` at the start of every turn from being said at all.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost:3110/" });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

afterEach(unmountAll);

const WAITING = "Finishing another job first · this one is next";
const ASKED: Message = { id: "u-1", role: "user", content: "경제 뉴스 알려줘" };
const SAID: Message = {
  id: "a-1",
  role: "assistant",
  content: "찾아보고 있어요.",
};

async function transcript(props: {
  messages: Message[];
  busy?: boolean;
  waitingForBot?: boolean;
  stoppedCode?: string;
}) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ChatTranscript } = await import(
    "../src/components/channels/chat-transcript"
  );
  const { busy = true, waitingForBot = true, messages, stoppedCode } = props;
  const view = await mount(
    <QueryClientProvider client={new QueryClient()}>
      <ChatTranscript
        busy={busy}
        messages={messages}
        waitingForBot={waitingForBot}
        {...(stoppedCode ? { stoppedCode } : {})}
      />
    </QueryClientProvider>,
  );
  await view.settle(30);
  return view;
}

/** What the always-mounted status regions say: what somebody listening is told. */
const spoken = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="status"]')].map(
    (region) => region.textContent,
  );

describe("the transcript, under a turn that is waiting for the Bot", () => {
  test("says the Bot is finishing another job first, not that it is thinking — drawn and spoken", async () => {
    const view = await transcript({ messages: [ASKED] });
    const text = view.host.textContent ?? "";
    expect(text).toContain(WAITING);
    expect(text).not.toContain("Thinking");
    expect(spoken(view.host)).toContain(WAITING);
    expect(spoken(view.host)).not.toContain("Thinking");
  });

  test("says it under the Bot's own words too: a turn can wait for the Bot partway", async () => {
    const view = await transcript({ messages: [ASKED, SAID] });
    expect(view.host.textContent).toContain(WAITING);
    expect(spoken(view.host)).toContain(WAITING);
  });

  test("says nothing of it once the turn is over, or under a turn that failed", async () => {
    const over = await transcript({ messages: [ASKED, SAID], busy: false });
    expect(over.host.textContent).not.toContain(WAITING);
    await over.unmount();
    const failed = await transcript({
      messages: [ASKED],
      stoppedCode: "laf:turn_failed",
    });
    expect(failed.host.textContent).not.toContain(WAITING);
    expect(
      failed.host.querySelector('[data-testid="transcript-stopped"]'),
    ).not.toBeNull();
  });

  test("a turn that has the Bot is still thinking", async () => {
    const view = await transcript({ messages: [ASKED], waitingForBot: false });
    expect(view.host.textContent).toContain("Thinking");
    expect(view.host.textContent).not.toContain(WAITING);
  });
});

describe("how long something has lasted before it is said", () => {
  async function probe() {
    const { useLasting } = await import("../src/lib/use-lasting");
    function Probe({ what }: { what: string | null }) {
      return <output>{useLasting(what, 60) ? "said" : "not yet"}</output>;
    }
    const view = await mount(<Probe what={null} />);
    const show = (what: string | null) => view.render(<Probe what={what} />);
    const reads = () => view.host.querySelector("output")?.textContent;
    return { view, show, reads };
  }

  test("is not said at once, is said once it has lasted, and stops the moment it ends", async () => {
    const { view, show, reads } = await probe();
    expect(reads()).toBe("not yet");
    await show("turn-1");
    expect(reads()).toBe("not yet");
    await view.settle(120);
    expect(reads()).toBe("said");
    await show(null);
    expect(reads()).toBe("not yet");
  });

  test("starts over when it begins again: a turn queued a second time waits as long as the first", async () => {
    const { view, show, reads } = await probe();
    await show("turn-1");
    await view.settle(120);
    expect(reads()).toBe("said");
    await show(null);
    await show("turn-1");
    expect(reads()).toBe("not yet");
    await view.settle(120);
    expect(reads()).toBe("said");
  });

  test("something that ends before it has lasted is never said", async () => {
    const { view, show, reads } = await probe();
    await show("turn-1");
    await view.settle(10);
    await show(null);
    await view.settle(120);
    expect(reads()).toBe("not yet");
  });

  test("the next thing does not inherit what the last one earned", async () => {
    const { view, show, reads } = await probe();
    await show("turn-1");
    await view.settle(120);
    expect(reads()).toBe("said");
    // A second turn queued in the same commit the first one ended in.
    await show("turn-2");
    expect(reads()).toBe("not yet");
    await view.settle(120);
    expect(reads()).toBe("said");
  });
});
