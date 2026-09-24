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
import { LEADING_SKILL } from "../src/components/channels/composer/draft";
import { taskOf } from "../src/components/computer/task-title";
import { mount, unmountAll } from "./support/mount";

/**
 * A SKILL CALLED /리뷰답장 IS A SKILL IN THE CONVERSATION TOO.
 *
 * Skills may be named in Korean since 0.5.3 (UI/UX audit, item 11: `SKILL_SLUG_PATTERN`). The
 * conversation read a leading `/name` with an a–z pattern, so `/리뷰답장 새 리뷰에 답해 줘` was drawn
 * as plain text where `/review-reply` got its chip, and asking it again lost its instruction.
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

describe("a leading /name", () => {
  test("is read in Korean as well as in a–z", () => {
    expect(LEADING_SKILL.exec("/리뷰답장 새 리뷰에 답해 줘")?.[1]).toBe(
      "리뷰답장",
    );
    expect(LEADING_SKILL.exec("/review-reply 오늘 것")?.[1]).toBe(
      "review-reply",
    );
    expect(LEADING_SKILL.exec("/주간-매출")?.[1]).toBe("주간-매출");
  });

  test("is still not a path or a sentence that happens to start with a slash", () => {
    expect(LEADING_SKILL.exec("/etc/hosts is broken")).toBeNull();
    expect(LEADING_SKILL.exec("안녕 /리뷰답장")).toBeNull();
  });

  test("is not the task a browsing card is titled with", () => {
    expect(taskOf("/리뷰답장 새 리뷰 확인해 줘", null)).toBe("새 리뷰 확인");
  });
});

test("the conversation draws a Korean-named skill as its chip", async () => {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ChatTranscript } = await import(
    "../src/components/channels/chat-transcript"
  );
  const messages = [
    { id: "m-1", role: "user", content: "/리뷰답장 새 리뷰에 답해 줘" },
  ] as Message[];
  const view = await mount(
    <QueryClientProvider client={new QueryClient()}>
      <ChatTranscript commandNames="리뷰답장" messages={messages} />
    </QueryClientProvider>,
  );
  await view.settle(30);
  const bubble = view.host.querySelector('[data-slot="bubble-content"]');
  // The chip, then the rest — not the slash and the name as words.
  expect(bubble?.textContent).toBe("/리뷰답장새 리뷰에 답해 줘");
  expect(bubble?.querySelector(".font-mono")?.textContent).toBe("/리뷰답장");
});
