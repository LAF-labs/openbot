import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { CompanyTask } from "../src/lib/hub/tasks";
import { stubFetch } from "./support/fetch";
import { json, mount, routerAt, unmountAll } from "./support/mount";

/**
 * 업무판: a card whose last move is still on its way to the hub is not moved again — by the menu as
 * much as by a drag. A second move would carry the version the first one is about to replace, and
 * the hub would refuse it as `laf:task_stale`: the second place dropped, and the board saying
 * somebody else changed a task nobody else touched.
 */

beforeAll(() => {
  GlobalRegistrator.register();
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

const card: CompanyTask = {
  id: "t_a",
  title: "견적서 보내기",
  description: null,
  stage: "todo",
  visibility: "company",
  members: [],
  assignee: null,
  assignedBy: null,
  createdBy: "m_a",
  checkout: null,
  version: 1,
  rank: 10,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  doneAt: null,
};

async function board() {
  const patches: unknown[] = [];
  let answer: (() => void) | undefined;
  globalThis.fetch = stubFetch(async (url, init) => {
    const path = String(url);
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      // The first move stays on its way until the test lets it land.
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return json({ task: { ...card, stage: "doing", version: 2 } });
    }
    if (path.startsWith("/api/hub/tasks")) {
      return json({ tasks: [card], next: null });
    }
    if (path.startsWith("/api/routines")) return json({ routines: [] });
    return json({});
  });

  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { RouterProvider } = await import("@tanstack/react-router");
  const { TaskBoard } = await import("../src/components/tasks/task-board");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = await routerAt("/company/tasks", ["/company/tasks"], () => (
    <QueryClientProvider client={client}>
      <TaskBoard meId="m_a" members={[]} openTask={undefined} />
    </QueryClientProvider>
  ));
  const view = await mount(<RouterProvider router={router} />);
  await view.settle(60);

  const itemFor = (stage: string) =>
    document.querySelector<HTMLElement>(`[data-task-move="${stage}"]`);
  const moveBy = async (stage: string) => {
    // A press on an item the menu will not take leaves the menu open; a second press on the
    // trigger would close it.
    if (!itemFor(stage)) {
      const trigger = view.host.querySelector<HTMLElement>(
        `[data-task-card="${card.id}"] [data-task-menu]`,
      );
      if (!trigger) throw new Error("no menu on the card");
      await view.press(trigger);
    }
    const item = itemFor(stage);
    if (!item) throw new Error(`no ${stage} in the menu`);
    await view.press(item);
  };
  return { view, patches, moveBy, land: () => answer?.() };
}

describe("a card on its way", () => {
  test("the menu does not send a second move while the first is unanswered", async () => {
    const { view, patches, moveBy, land } = await board();
    await moveBy("doing");
    expect(patches).toEqual([{ version: 1, stage: "doing", rank: 10 }]);

    await moveBy("review");
    expect(patches).toHaveLength(1);

    // Once the hub has answered, the card moves again, from the version it gave back.
    land();
    await view.settle(60);
    await moveBy("review");
    expect(patches).toHaveLength(2);
    expect(patches[1]).toMatchObject({ version: 2, stage: "review" });
  });
});
