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
  /**
   * A press on A whose first move is already off it and whose release is over the column (a
   * flick), then a press on the column moved over B with the button held, then a click on B.
   */
  strayPress: Scenario<{
    ghostWhileHeld: boolean;
    patches: { path: string; body: unknown }[];
  }>;
  /**
   * The same flick let go outside the window, so no release reaches the page; then a hover over B
   * with no button held, and a click on B.
   */
  lostRelease: Scenario<{
    ghostOnHover: boolean;
    patches: { path: string; body: unknown }[];
  }>;
  /** A drag whose card was taken off the page mid-drag (moved to another column by a refetch). */
  unmounted: Scenario<{
    wasDragging: boolean;
    /** Whether the copy still followed the pointer after a grip handed its capture on (a finger's). */
    ghostAfterHandOver: boolean;
    /** Whether the copy still followed the pointer once the card's capture was lost. */
    ghostAfterLost: boolean;
    ghostOnHover: boolean;
    patches: { path: string; body: unknown }[];
  }>;
  /** A 라피's card and a person's card, each dragged over 하는 중 and let go there; A's menu. */
  runCard: Scenario<{
    menu: string[];
    lineForRun: boolean;
    lineForPerson: boolean;
    patches: { path: string; body: unknown }[];
  }>;
  /** A's move refused after B's move was taken, before the board is read again. */
  refusedAlone: Scenario<{
    columns: Record<string, string | null>;
    notice: string | null;
  }>;
  /**
   * Who-does-it choices in a task's window: for a task a person holds in 하는 중 (no run on it),
   * and for the same task in 할 일.
   */
  choices: Scenario<{ doing: string[]; todo: string[] }>;
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
const { taskKeys } = await import("../../src/lib/hub/tasks");

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

const second: CompanyTask = {
  ...card,
  id: "t_b",
  title: "재고 확인",
  rank: 20,
};

/** A board alone, under a router, with `handler` answering first and the board's reads after it. */
async function board(
  handler: Handler,
  openTask?: string,
  tasks: CompanyTask[] = [card],
) {
  globalThis.fetch = stubFetch(async (url, init) => {
    const path = String(url);
    const answered = await handler(path, init);
    if (answered) return answered;
    if (path.startsWith("/api/hub/tasks/t_a")) {
      return json({ task: card, notes: [] });
    }
    if (path.startsWith("/api/hub/tasks")) {
      return json({ tasks, next: null });
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
  return { view, router, client };
}

/** A mouse's pointer event at a point, on `target`: a button held from the press to the release. */
function pointerOn(
  target: EventTarget,
  type: string,
  x: number,
  y: number,
  held = type !== "pointerup",
) {
  return act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: held ? 1 : 0,
        pointerId: 1,
        pointerType: "mouse",
        clientX: x,
        clientY: y,
      }),
    );
  });
}

const cardOn = (host: HTMLElement, id: string) => {
  const found = host.querySelector<HTMLElement>(`[data-task-card="${id}"]`);
  if (!found) throw new Error(`no card ${id} on the board`);
  return found;
};

const columnOn = (host: HTMLElement, stage: string) => {
  const found = host.querySelector<HTMLElement>(
    `[data-task-column="${stage}"]`,
  );
  if (!found) throw new Error(`no column ${stage}`);
  return found;
};

/** The copy that follows the pointer is a card with no `data-task-card` of its own. */
const ghostDrawn = () =>
  document.querySelector("[data-task-stage]:not([data-task-card])") !== null;

/** Every PATCH the board sent, answered as the hub would take it. */
function patchesTaken() {
  const patches: { path: string; body: unknown }[] = [];
  const handler: Handler = (path, init) => {
    if (init?.method !== "PATCH") return undefined;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    patches.push({ path, body });
    return json({ task: { ...card, ...body, version: 2 } });
  };
  return { patches, handler };
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
      pointerOn(cardElement, type, x, y);

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

/** Pressed on A; its first move is already past A's edge, over the column. */
async function flickOffA(host: HTMLElement) {
  const column = columnOn(host, "todo");
  await pointerOn(cardOn(host, "t_a"), "pointerdown", 10, 10);
  await pointerOn(column, "pointermove", 10, 200);
  return column;
}

/** A click on B: what a person does next, which must not drop A anywhere. */
async function clickB(host: HTMLElement) {
  const other = cardOn(host, "t_b");
  await pointerOn(other, "pointerdown", 40, 60);
  await pointerOn(other, "pointerup", 40, 60);
}

const strayPress = await run(
  { ghostWhileHeld: false, patches: [] },
  async () => {
    const { patches, handler } = patchesTaken();
    const { view } = await board(handler, undefined, [card, second]);
    const column = await flickOffA(view.host);
    await pointerOn(column, "pointerup", 10, 200);
    await view.settle();
    // A press on the column, which no card hears, moved over B with the button held.
    await pointerOn(column, "pointerdown", 10, 220);
    const other = cardOn(view.host, "t_b");
    await pointerOn(other, "pointermove", 30, 30);
    await pointerOn(other, "pointermove", 40, 60);
    await view.settle();
    const ghostWhileHeld = ghostDrawn();
    await pointerOn(other, "pointerup", 40, 60);
    await clickB(view.host);
    await view.settle(60);
    return { ghostWhileHeld, patches };
  },
);

const lostRelease = await run(
  { ghostOnHover: false, patches: [] },
  async () => {
    const { patches, handler } = patchesTaken();
    const { view } = await board(handler, undefined, [card, second]);
    await flickOffA(view.host);
    await view.settle();
    const other = cardOn(view.host, "t_b");
    await pointerOn(other, "pointermove", 30, 30, false);
    await pointerOn(other, "pointermove", 40, 60, false);
    await view.settle();
    const ghostOnHover = ghostDrawn();
    await clickB(view.host);
    await view.settle(60);
    return { ghostOnHover, patches };
  },
);

const unmounted = await run(
  {
    wasDragging: false,
    ghostAfterHandOver: false,
    ghostAfterLost: false,
    ghostOnHover: false,
    patches: [],
  },
  async () => {
    const { patches, handler } = patchesTaken();
    const { view, client } = await board(handler, undefined, [card, second]);
    const dragged = cardOn(view.host, "t_a");
    await pointerOn(dragged, "pointerdown", 10, 10);
    await pointerOn(dragged, "pointermove", 40, 40);
    await view.settle();
    const wasDragging = ghostDrawn();
    // What a finger's grip says when the card takes its capture: not the drag ending.
    const grip = dragged.querySelector("[data-task-grip]");
    if (!grip) throw new Error("no grip on the card");
    await act(async () => {
      grip.dispatchEvent(
        new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 }),
      );
    });
    await view.settle();
    const ghostAfterHandOver = ghostDrawn();
    // A colleague's move, read in mid-drag: A is drawn in 검토, its element taken off the page.
    await act(async () => {
      client.setQueryData<CompanyTask[]>(taskKeys.board, (tasks) =>
        tasks?.map((one) =>
          one.id === "t_a" ? { ...one, stage: "review", version: 2 } : one,
        ),
      );
    });
    await view.settle();
    // As Chrome says it: the capture is lost at the document, which no card hears.
    await act(async () => {
      document.dispatchEvent(
        new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 }),
      );
    });
    await view.settle();
    const ghostAfterLost = ghostDrawn();
    await pointerOn(columnOn(view.host, "todo"), "pointerup", 40, 200);
    await view.settle();
    const other = cardOn(view.host, "t_b");
    await pointerOn(other, "pointermove", 40, 60, false);
    await view.settle();
    const ghostOnHover = ghostDrawn();
    await pointerOn(other, "pointerdown", 40, 60);
    await pointerOn(other, "pointerup", 40, 60);
    await view.settle(60);
    return {
      wasDragging,
      ghostAfterHandOver,
      ghostAfterLost,
      ghostOnHover,
      patches,
    };
  },
);

const runCard = await run(
  { menu: [], lineForRun: false, lineForPerson: false, patches: [] },
  async () => {
    const { patches, handler } = patchesTaken();
    const lafis: CompanyTask = { ...card, assignee: "bot:m_a" };
    const { view } = await board(handler, undefined, [lafis, second]);
    const trigger = cardOn(view.host, "t_a").querySelector<HTMLElement>(
      "[data-task-menu]",
    );
    if (!trigger) throw new Error("no menu on the card");
    await view.press(trigger);
    const menu = [
      ...document.querySelectorAll<HTMLElement>("[data-task-move]"),
    ].map((item) => item.dataset.taskMove ?? "");
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await view.settle();
    // What is under the pointer is 하는 중's column, wherever it is.
    const doing = columnOn(view.host, "doing");
    const realElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => doing;
    const lineAfterDragging = async (id: string) => {
      const dragged = cardOn(view.host, id);
      await pointerOn(dragged, "pointerdown", 10, 10);
      await pointerOn(dragged, "pointermove", 300, 40);
      await pointerOn(dragged, "pointermove", 310, 40);
      await view.settle();
      const line = doing.querySelector("[data-task-drop-line]") !== null;
      await pointerOn(dragged, "pointerup", 310, 40);
      await view.settle(60);
      return line;
    };
    try {
      const lineForRun = await lineAfterDragging("t_a");
      const lineForPerson = await lineAfterDragging("t_b");
      return { menu, lineForRun, lineForPerson, patches };
    } finally {
      document.elementFromPoint = realElementFromPoint;
    }
  },
);

const refusedAlone = await run(
  { columns: { t_a: null, t_b: null }, notice: null },
  async () => {
    let refuse: (() => void) | undefined;
    let reads = 0;
    const { view } = await board(
      async (path, init) => {
        if (init?.method === "PATCH" && path === "/api/hub/tasks/t_a") {
          await new Promise<void>((resolve) => {
            refuse = resolve;
          });
          return json(
            { ok: false, code: "laf:request_invalid", field: "stage" },
            400,
          );
        }
        if (init?.method === "PATCH" && path === "/api/hub/tasks/t_b") {
          return json({ task: { ...second, stage: "review", version: 2 } });
        }
        // After the first read, the board's next read stays on its way: what shows is the cache.
        if (path.startsWith("/api/hub/tasks?")) {
          reads += 1;
          if (reads > 1) return new Promise<Response>(() => {});
        }
        return undefined;
      },
      undefined,
      [card, second],
    );
    const moveBy = async (id: string, stage: string) => {
      const trigger = cardOn(view.host, id).querySelector<HTMLElement>(
        "[data-task-menu]",
      );
      if (!trigger) throw new Error("no menu on the card");
      await view.press(trigger);
      const item = document.querySelector<HTMLElement>(
        `[data-task-move="${stage}"]`,
      );
      if (!item) throw new Error(`no ${stage} in the menu`);
      await view.press(item);
      await view.settle(60);
    };
    await moveBy("t_a", "blocked");
    await moveBy("t_b", "review");
    refuse?.();
    await view.settle(60);
    const columnOf = (id: string) =>
      view.host
        .querySelector(`[data-task-card="${id}"]`)
        ?.closest<HTMLElement>("[data-task-column]")?.dataset.taskColumn ??
      null;
    return {
      columns: { t_a: columnOf("t_a"), t_b: columnOf("t_b") },
      notice:
        view.host.querySelector<HTMLElement>("[data-task-notice]")
          ?.textContent ?? null,
    };
  },
);

const choices = await run({ doing: [], todo: [] }, async () => {
  const choicesFor = async (stage: CompanyTask["stage"]) => {
    const held: CompanyTask = { ...card, stage, assignee: "m:m_a" };
    const { view } = await board(
      (path) => {
        if (path.startsWith("/api/hub/tasks/t_a")) {
          return json({ task: held, notes: [] });
        }
        if (path.startsWith("/api/routines")) {
          return json({ routines: [{ id: "rt_1", name: "아침 매출 확인" }] });
        }
        return undefined;
      },
      card.id,
      [held],
    );
    const trigger = document.querySelector<HTMLElement>(
      "[data-task-detail] [data-task-assignee]",
    );
    if (!trigger) throw new Error("no who-does-it in the task's window");
    await view.press(trigger);
    await view.settle(60);
    const offered = [
      ...document.querySelectorAll<HTMLElement>("[data-assignee-option]"),
    ].map((option) => option.dataset.assigneeOption ?? "");
    await unmountAll();
    document.body.innerHTML = "";
    return offered;
  };
  return { doing: await choicesFor("doing"), todo: await choicesFor("todo") };
});

const shown: TaskBoardShown = {
  pending,
  escaped,
  newTask,
  note,
  company,
  strayPress,
  lostRelease,
  unmounted,
  runCard,
  refusedAlone,
  choices,
};
console.log(`TASK_BOARD ${JSON.stringify(shown)}`);
clearTimeout(timer);
process.exit(0);
