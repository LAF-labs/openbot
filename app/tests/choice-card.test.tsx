import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mount, unmountAll } from "./support/mount";

/**
 * A QUESTION CARD SAYS HOW ITS QUESTION STANDS — AND OFFERS A PRESS ONLY WHILE A PRESS DOES SOMETHING.
 *
 * Pressed on the running app, 2026-10-02. The Bot asked with a choice card and the turn was stopped
 * before anybody answered. The card went on reading "답을 기다려요", with its three options looking
 * as live as before; pressing one did nothing at all — no request, no change. A question that had
 * passed looked exactly like one still being asked.
 *
 * The card is drawn here from its props, the way the transcript hands them over: `executing` with a
 * `respond` while a turn waits on it, `complete` with the call's result once it is over.
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
afterEach(async () => {
  await unmountAll();
});

const CHOICE = {
  title: "오늘 저녁 메뉴",
  options: [
    { id: "korean", label: "한식" },
    { id: "chinese", label: "중식" },
  ],
};

async function choiceCard(props: Record<string, unknown>) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ChoiceCard } = await import("../src/components/gallery/decisions");
  const Card = ChoiceCard as unknown as (
    props: Record<string, unknown>,
  ) => React.ReactElement;
  const view = await mount(
    <QueryClientProvider client={new QueryClient()}>
      <Card args={CHOICE} {...props} />
    </QueryClientProvider>,
  );
  const options = () =>
    [...view.host.querySelectorAll("button")].filter((button) =>
      ["한식", "중식"].includes(button.textContent?.trim() ?? ""),
    );
  return { view, options, text: () => view.host.textContent ?? "" };
}

async function approvalCard(props: Record<string, unknown>) {
  const { ApprovalCard } = await import("../src/components/gallery/decisions");
  const Card = ApprovalCard as unknown as (
    props: Record<string, unknown>,
  ) => React.ReactElement;
  const view = await mount(
    <Card
      args={{ title: "메일 보내기", summary: "이 메일을 보낼까요?" }}
      {...props}
    />,
  );
  return { view, text: () => view.host.textContent ?? "" };
}

describe("a choice card", () => {
  test("still being asked says it waits, and its options can be pressed", async () => {
    const answers: unknown[] = [];
    const { options, text, view } = await choiceCard({
      status: "executing",
      respond: async (value: unknown) => {
        answers.push(value);
      },
    });
    expect(text()).toContain("Waiting on you");
    expect(options().map((button) => button.disabled)).toEqual([false, false]);
    await view.press(options()[0] as Element);
    expect(answers).toEqual([{ choice: "korean", label: "한식" }]);
  });

  test("whose question passed without an answer says so, and offers nothing to press", async () => {
    for (const result of ["laf:stopped", "laf:nobody_answered"]) {
      const { options, text } = await choiceCard({
        status: "complete",
        result,
      });
      expect(text()).toContain("Not answered");
      expect(text()).not.toContain("Waiting on you");
      expect(options().every((button) => button.disabled)).toBe(true);
      await unmountAll();
    }
  });

  test("answered by a press shows which option, as it always did", async () => {
    const { options, text } = await choiceCard({
      status: "complete",
      result: JSON.stringify({ choice: "korean", label: "한식" }),
    });
    expect(text()).toContain("Answered");
    expect(text()).not.toContain("Not answered");
    expect(options().every((button) => button.disabled)).toBe(true);
  });

  test("answered in the person's own words shows the words", async () => {
    const { options, text } = await choiceCard({
      status: "complete",
      result: JSON.stringify({ answer: "둘 다 말고 냉면" }),
    });
    expect(text()).toContain("Answered");
    expect(text()).toContain("Your answer: 둘 다 말고 냉면");
    expect(options().every((button) => button.disabled)).toBe(true);
  });

  /*
   * The words go into the sentence through `t()`, and a value handed to a replace as a string is a
   * replacement pattern: "$$ 정도" was drawn "$ 정도", and `$&` as the slot's own name.
   */
  test("answered in words that hold a dollar sign shows them as they were typed", async () => {
    for (const words of [
      "$$ 정도면 좋겠어",
      "$& 말고 $' 다른 거",
      "$100 이하",
    ]) {
      const { text, view } = await choiceCard({
        status: "complete",
        result: JSON.stringify({ answer: words }),
      });
      expect(text()).toContain(`Your answer: ${words}`);
      await view.unmount();
    }
  });

  test("that nothing here can answer offers nothing to press", async () => {
    // Drawn while its turn is not waiting on it in this conversation, and no result is in yet.
    const { options, text } = await choiceCard({ status: "executing" });
    expect(options().every((button) => button.disabled)).toBe(true);
    expect(text()).not.toContain("Waiting on you");
  });
});

describe("the line that says words are taken", () => {
  test("is on a choice a turn the server owns is waiting on, where they are", async () => {
    const { ServerAnswersProvider } = await import("../src/lib/turns/answers");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { ChoiceCard } = await import("../src/components/gallery/decisions");
    const Card = ChoiceCard as unknown as (
      props: Record<string, unknown>,
    ) => React.ReactElement;
    const view = await mount(
      <QueryClientProvider client={new QueryClient()}>
        <ServerAnswersProvider
          value={{ waiting: new Set(["c-1"]), answer: async () => {} }}
        >
          <Card args={CHOICE} respond={async () => {}} status="executing" />
        </ServerAnswersProvider>
      </QueryClientProvider>,
    );
    expect(view.host.textContent).toContain(
      "None of these? Type your answer below.",
    );
  });

  test("is not on one a window drives, where what is typed waits for the turn to end", async () => {
    const { text } = await choiceCard({
      status: "executing",
      respond: async () => {},
    });
    expect(text()).not.toContain("None of these? Type your answer below.");
  });

  test("is not on the choice that saves who somebody is, which takes a press", async () => {
    const { ServerAnswersProvider } = await import("../src/lib/turns/answers");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { ChoiceCard } = await import("../src/components/gallery/decisions");
    const Card = ChoiceCard as unknown as (
      props: Record<string, unknown>,
    ) => React.ReactElement;
    const view = await mount(
      <QueryClientProvider client={new QueryClient()}>
        <ServerAnswersProvider
          value={{ waiting: new Set(["c-1"]), answer: async () => {} }}
        >
          <Card
            args={{ title: "누구세요?", options: [], saves: "persona" }}
            respond={async () => {}}
            status="executing"
          />
        </ServerAnswersProvider>
      </QueryClientProvider>,
    );
    expect(view.host.textContent).not.toContain(
      "None of these? Type your answer below.",
    );
  });
});

describe("an approval card", () => {
  test("whose question passed without an answer says so, and offers nothing to press", async () => {
    const { text, view } = await approvalCard({
      status: "complete",
      result: "laf:nobody_answered",
    });
    expect(text()).toContain("Not answered");
    expect(text()).not.toContain("Waiting on you");
    expect(view.host.querySelectorAll("button, input")).toHaveLength(0);
  });

  test("that was declined says declined", async () => {
    const { text } = await approvalCard({
      status: "complete",
      result: JSON.stringify({ decision: "declined" }),
    });
    expect(text()).toContain("Declined");
    expect(text()).not.toContain("Not answered");
  });
});
