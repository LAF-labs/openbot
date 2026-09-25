import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { ko } from "../src/lib/i18n-ko";
import { mount, unmountAll } from "./support/mount";

/**
 * "대기 중" WAS TWO OPPOSITE FACTS ON ONE SCREEN (ux-review-0.5.4 §1.9): the idle pill, and a
 * message that had not reached the Bot yet. A correction then sat behind the wrong job until it
 * finished. The queued line now says when it goes, and offers to stop the job so it goes now.
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

async function transcript(onStopForQueued?: () => void) {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ChatTranscript } = await import(
    "../src/components/channels/chat-transcript"
  );
  const messages = [
    { id: "m-1", role: "user", content: "경제 뉴스 알려줘" },
  ] as Message[];
  const view = await mount(
    <QueryClientProvider client={new QueryClient()}>
      <ChatTranscript
        busy
        messages={messages}
        onRemoveQueued={() => {}}
        onStopForQueued={onStopForQueued}
        queued={[{ id: "q-1", text: "아 그거 말고 IT 뉴스로", commandIds: [] }]}
      />
    </QueryClientProvider>,
  );
  await view.settle(30);
  return view;
}

test("a queued correction says when it goes, and can stop the job to go now", async () => {
  let stopped = 0;
  const view = await transcript(() => {
    stopped += 1;
  });
  const text = view.host.textContent ?? "";
  expect(text).toContain("Sends when the current job is done");
  const stop = [...view.host.querySelectorAll("button")].find(
    (button) => button.textContent === "Stop and send this",
  );
  if (!stop) throw new Error("no 멈추고 이걸로");
  await view.press(stop);
  expect(stopped).toBe(1);
});

test("with nothing to stop, it offers only to be taken back", async () => {
  const view = await transcript();
  expect(view.host.textContent).not.toContain("Stop and send this");
  expect(view.host.textContent).toContain("Remove");
});

test("the idle pill and the queued line no longer share a word", () => {
  expect(ko.Ready).not.toBe(ko["Sends when the current job is done"]);
  expect(ko["Sends when the current job is done"]).not.toContain("대기 중");
  expect(ko.Ready).not.toBe("대기 중");
});
