/**
 * 업무판, PRESSED THE WAY A PERSON PRESSES IT — IN A PROCESS OF ITS OWN.
 *
 * WHY NOT IN THE SUITE'S PROCESS. A card's menu and a task's window are Base UI's, and Base UI
 * decides once, when it is first evaluated, whether there is a document to draw a popup into
 * (`support/steps-render.tsx`, `confirm-dialog.test.tsx`). `bun test` shares one module registry
 * across the files of a run, so a file that imported an app module before any DOM existed leaves
 * every file after it with menus that do not open. Measured 2026-10-18 in CI: beside
 * `account-copy.test.ts` (a route module, and it sorts first) the card's menu drew no items and the
 * test failed on "no doing in the menu"; alone, it passed. Here the DOM is registered before any app
 * module is imported, so what opens is what a person sees.
 *
 * Each scenario mounts its own board with its own fetch stand-in, writes down what it saw, and
 * unmounts; one that throws says so in its own `error`, and the ones after it still run.
 *
 * Prints one line, `TASK_BOARD <json>`. Not a test file (no `.test.` in the name), so the runner
 * never collects it on its own — and nothing may import a value from it, which would run it: types
 * only.
 *
 *     bun app/tests/support/task-board-render.tsx
 */
import type { CompanyTask } from "../../src/lib/hub/tasks";
import { APP_DOM_TIMEOUT_MS, installAppDom } from "./app-router";

type Scenario<T> = T & { error?: string };

export type TaskBoardShown = {
  /** A card whose move is on its way, moved again by its menu: the PATCH bodies after each step. */
  pending: Scenario<{
    afterFirst: unknown[];
    whileOnItsWay: unknown[];
    afterLanding: unknown[];
  }>;
};

process.env.NODE_ENV = "test";
const timer = setTimeout(() => {
  console.error("task-board-render: ran out of time");
  process.exit(2);
}, APP_DOM_TIMEOUT_MS * 2);
await installAppDom();

const { stubFetch } = await import("./fetch");
const { json, mount, routerAt, unmountAll } = await import("./mount");
const { unmountApps } = await import("./app-router");
const { QueryClient, QueryClientProvider } = await import(
  "@tanstack/react-query"
);
const { RouterProvider } = await import("@tanstack/react-router");
const { TaskBoard } = await import("../../src/components/tasks/task-board");

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

const realFetch = globalThis.fetch;

type Handler = (
  path: string,
  init: RequestInit | undefined,
) => Promise<Response | undefined> | Response | undefined;

/** A board alone, under a router, with `handler` answering first and the board's reads after it. */
async function board(handler: Handler, openTask?: string) {
  globalThis.fetch = stubFetch(async (url, init) => {
    const path = String(url);
    const answered = await handler(path, init);
    if (answered) return answered;
    if (path.startsWith("/api/hub/tasks/t_a")) {
      return json({ task: card, notes: [] });
    }
    if (path.startsWith("/api/hub/tasks")) {
      return json({ tasks: [card], next: null });
    }
    if (path.startsWith("/api/routines")) return json({ routines: [] });
    if (path.startsWith("/api/channels")) return json({ channels: [] });
    return json({});
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = await routerAt("/company/tasks", ["/company/tasks"], () => (
    <QueryClientProvider client={client}>
      <TaskBoard meId="m_a" members={[]} openTask={openTask} />
    </QueryClientProvider>
  ));
  const view = await mount(<RouterProvider router={router} />);
  await view.settle(60);
  return { view, router };
}

/** One scenario, its board taken down and `fetch` given back whatever happened. */
async function run<T extends object>(
  fallback: T,
  body: () => Promise<T>,
): Promise<Scenario<T>> {
  try {
    return await body();
  } catch (error) {
    return { ...fallback, error: String((error as Error)?.stack ?? error) };
  } finally {
    await unmountAll();
    await unmountApps();
    globalThis.fetch = realFetch;
    document.body.innerHTML = "";
  }
}

const pending = await run(
  { afterFirst: [], whileOnItsWay: [], afterLanding: [] },
  async () => {
    const patches: unknown[] = [];
    let land: (() => void) | undefined;
    const { view } = await board(async (_path, init) => {
      if (init?.method !== "PATCH") return undefined;
      patches.push(JSON.parse(String(init.body)));
      // The first move stays on its way until the scenario lets it land.
      await new Promise<void>((resolve) => {
        land = resolve;
      });
      return json({ task: { ...card, stage: "doing", version: 2 } });
    });
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

    await moveBy("doing");
    const afterFirst = [...patches];
    await moveBy("review");
    const whileOnItsWay = [...patches];
    land?.();
    await view.settle(60);
    await moveBy("review");
    return { afterFirst, whileOnItsWay, afterLanding: [...patches] };
  },
);

const shown: TaskBoardShown = { pending };
console.log(`TASK_BOARD ${JSON.stringify(shown)}`);
clearTimeout(timer);
process.exit(0);
