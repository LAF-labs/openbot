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
  /** A drag put back with Escape, then the card's title clicked without a press before it. */
  escaped: Scenario<{
    /** Whether the copy that follows the pointer was drawn: the press really was a drag. */
    wasDragging: boolean;
    /** Whether Escape put it away. */
    putBack: boolean;
    /** The task the address opened after the click, if any. */
    opened: string | null;
  }>;
  /** A new task refused twice, then its title edited: the key each POST carried. */
  newTask: Scenario<{ writes: { key: string | null; body: unknown }[] }>;
  /** A note refused twice, then its words edited: the key each POST carried. */
  note: Scenario<{ writes: { key: string | null; body: unknown }[] }>;
  /** 회사 at an address that names 업무판 and a tab: which parts are drawn. */
  company: Scenario<{
    onTasks: { board: boolean; files: boolean };
    onFiles: { board: boolean; files: boolean };
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
const { mountApp, unmountApps } = await import("./app-router");
const { act } = await import("react");
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

const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

/** Types into a field the way a keystroke does: through the prototype's setter, which React sees. */
async function typeInto(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(field) as object,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
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

const escaped = await run(
  { wasDragging: false, putBack: false, opened: null },
  async () => {
    const { view, router } = await board(() => undefined);
    const cardElement = view.host.querySelector<HTMLElement>(
      `[data-task-card="${card.id}"]`,
    );
    if (!cardElement) throw new Error("no card on the board");
    const pointer = (type: string, x: number, y: number) =>
      act(async () => {
        cardElement.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
            clientX: x,
            clientY: y,
          }),
        );
      });
    // The copy that follows the pointer is a card with no `data-task-card` of its own.
    const ghostDrawn = () =>
      document.querySelector("[data-task-stage]:not([data-task-card])") !==
      null;

    await pointer("pointerdown", 10, 10);
    await pointer("pointermove", 40, 40);
    await view.settle();
    const wasDragging = ghostDrawn();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await view.settle();
    const putBack = !ghostDrawn();
    // Let go, and let whatever the release leaves for later run.
    await pointer("pointerup", 40, 40);
    await view.settle();

    // A click with no press before it: Enter on the title, or a finger's tap.
    const title = cardElement.querySelector<HTMLElement>("[data-task-open]");
    if (!title) throw new Error("no title on the card");
    await view.press(title);
    await view.settle();
    const search = router.state.location.search as { task?: string };
    return { wasDragging, putBack, opened: search.task ?? null };
  },
);

/** A write refused twice with nothing changed in between, then made with what was edited. */
function refusedTwice(path: string) {
  const writes: { key: string | null; body: unknown }[] = [];
  const handler: Handler = (url, init) => {
    if (init?.method !== "POST" || url !== path) return undefined;
    writes.push({
      key: headerOf(init, "idempotency-key"),
      body: JSON.parse(String(init.body)),
    });
    return writes.length <= 2
      ? json({ error: "laf:hub_unreachable" }, 502)
      : json({ ok: true }, 201);
  };
  return { writes, handler };
}

const newTask = await run({ writes: [] }, async () => {
  const { writes, handler } = refusedTwice("/api/hub/tasks");
  const { view } = await board(handler);
  const open = view.host.querySelector<HTMLElement>("[data-new-task]");
  if (!open) throw new Error("no 새 업무 button");
  await view.press(open);
  const form = view.host.querySelector<HTMLFormElement>("[data-new-task-form]");
  const field = form?.querySelector<HTMLInputElement>("input");
  if (!form || !field) throw new Error("no new task form");
  await typeInto(field, "견적서");
  await submit(form);
  await view.settle(60);
  await submit(form);
  await view.settle(60);
  await typeInto(field, "견적서 보내기");
  await submit(form);
  await view.settle(60);
  return { writes };
});

const note = await run({ writes: [] }, async () => {
  const { writes, handler } = refusedTwice("/api/hub/tasks/t_a/notes");
  const { view } = await board(handler, card.id);
  const notes = document.querySelector<HTMLElement>("[data-task-notes]");
  const form = notes?.querySelector<HTMLFormElement>("form");
  const field = form?.querySelector<HTMLTextAreaElement>("textarea");
  if (!form || !field) throw new Error("no note box in the task's window");
  await typeInto(field, "내일 보내요");
  await submit(form);
  await view.settle(60);
  await submit(form);
  await view.settle(60);
  await typeInto(field, "내일 아침에 보내요");
  await submit(form);
  await view.settle(60);
  return { writes };
});

const company = await run(
  {
    onTasks: { board: false, files: false },
    onFiles: { board: false, files: false },
  },
  async () => {
    const api = (request: { pathname: string }) => {
      switch (request.pathname) {
        case "/api/hub/status":
          return json({
            configured: true,
            state: "connected",
            code: null,
            workspace: { name: "우리 가게" },
            member: { role: "owner", name: "기범" },
            since: "2026-10-18T00:00:00.000Z",
          });
        case "/api/hub/me":
          return json({
            ok: true,
            member: { id: "m_a", role: "owner", name: "기범" },
            workspace: { id: "w_a", name: "우리 가게" },
          });
        case "/api/hub/members":
          return json({
            members: [{ id: "m_a", name: "기범", role: "owner" }],
          });
        case "/api/hub/files":
          return json({ files: [], next: null });
        case "/api/hub/tasks":
          return json({ tasks: [card], next: null });
        default:
          return undefined;
      }
    };
    const partsAt = async (path: string) => {
      const app = await mountApp({ path, api });
      await app.settle(60);
      const shown = {
        board: app.host.querySelector("[data-task-board]") !== null,
        files: app.host.querySelector("[data-company-files]") !== null,
      };
      await unmountApps();
      return shown;
    };
    return {
      onTasks: await partsAt("/company/tasks?tab=files"),
      onFiles: await partsAt("/company?tab=files"),
    };
  },
);

const shown: TaskBoardShown = { pending, escaped, newTask, note, company };
console.log(`TASK_BOARD ${JSON.stringify(shown)}`);
clearTimeout(timer);
process.exit(0);
