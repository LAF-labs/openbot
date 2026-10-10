/**
 * The 계정 screen's dialogs, pressed in a process of their own.
 *
 * Base UI decides once, when its module is first evaluated, whether a popup can open, and the
 * suite's shared registry has usually decided no before any file's DOM exists
 * (`confirm-dialog.test.tsx` has the measurement). So what goes through a dialog — saving a login,
 * changing one, a refusal, a delete's confirmation — is done here, where the DOM is installed
 * before anything is imported, and `logins-screen.test.tsx` reads what happened off one line.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

type Write = { method: string; path: string; body: unknown };

export type LoginsShown = {
  /** What the site box reads when the add dialog opens. */
  siteBox: string;
  saved: {
    writes: Write[];
    isDialogClosed: boolean;
    isRowDrawn: boolean;
    /** Whether the typed password is anywhere in the page once it is saved. */
    isValueLeft: boolean;
  };
  changed: {
    /** What each box held when the form opened on a saved login. */
    opened: Record<string, string>;
    writes: Write[];
    /** The requests when only a new password was typed, and when nothing was changed at all. */
    passwordOnly: Write[];
    untouched: { writes: Write[]; isDialogClosed: boolean };
    /** A change to a login another window deleted while the form was open. */
    gone: { isSaid: boolean; isRowLeft: boolean };
  };
  /** A save that is still on its way, and everything that would close the dialog under it. */
  pending: {
    isOpenAfterEscape: boolean;
    isOpenAfterClose: boolean;
    isCloseDisabled: boolean;
    isClosedOnceSaved: boolean;
  };
  refused: {
    writes: number;
    isSaid: boolean;
    addressesInvalid: string | null;
    labelInvalid: string | null;
    usernameKept: string;
    isCodeDrawn: boolean;
  };
  removed: {
    /** The question, as the dialog's title drew it. */
    question: string;
    writesBeforeConfirm: number;
    writes: Write[];
    /** What the list drew once it was read again. */
    rowsAfter: string[];
    /** What the question drew when the server said the login was already gone. */
    refusedText: string;
  };
};

process.env.NODE_ENV = "test";
GlobalRegistrator.register({ url: "http://localhost:3110/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class NoSocket {
  onopen = null;
  onmessage = null;
  onclose = null;
  close() {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = NoSocket;
(window as unknown as { WebSocket: unknown }).WebSocket = NoSocket;

const { json, mountApp } = await import("./app-router");
type ApiRequest = import("./app-router").ApiRequest;

const NAVER = {
  id: "login-1",
  label: "네이버 (가게)",
  site: "naver-smartstore" as string | null,
  origins: ["https://nid.naver.com", "https://sell.smartstore.naver.com"],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  lastUsedAt: null,
};

function server(
  options: {
    logins?: (typeof NAVER)[];
    refuse?: { status: number; body: unknown };
    /** A write is not answered until this is. */
    hold?: Promise<void>;
  } = {},
) {
  let held = [...(options.logins ?? [])];
  const writes: Write[] = [];
  const api = (request: ApiRequest) => {
    const { pathname, method } = request;
    if (!pathname.startsWith("/api/logins")) return undefined;
    if (method === "GET") return json({ logins: held, max: 100 });
    writes.push({ method, path: pathname, body: request.body });
    if (options.hold) return options.hold.then(() => answer(request));
    return answer(request);
  };
  const answer = (request: ApiRequest) => {
    const { pathname, method } = request;
    if (options.refuse) return json(options.refuse.body, options.refuse.status);
    if (method === "DELETE") {
      held = held.filter((login) => !pathname.endsWith(login.id));
      return new Response(null, { status: 204 });
    }
    // A change names only what changed, and the server keeps the rest: so does this.
    const body = request.body as { label?: string; origins?: string[] };
    const before = held.find((login) => pathname.endsWith(login.id)) ?? NAVER;
    const saved = {
      ...before,
      id: method === "POST" ? "login-new" : before.id,
      label: body.label ?? before.label,
      site: method === "POST" ? null : before.site,
      origins: body.origins
        ? body.origins.map((origin) => `https://${origin}`)
        : before.origins,
    };
    held =
      method === "POST"
        ? [...held, saved]
        : held.map((login) => (login.id === saved.id ? saved : login));
    return json(saved, method === "POST" ? 201 : 200);
  };
  return { api, writes };
}

type View = Awaited<ReturnType<typeof mountApp>>;

const field = (id: string) =>
  document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
const pageButton = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (one) => one.textContent?.trim() === text,
  );

async function pressLabelled(view: View, label: string) {
  await view.waitFor(
    () => view.host.querySelector(`button[aria-label="${label}"]`) !== null,
    `a button labelled ${label}`,
  );
  const button = view.host.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`no button labelled ${label}`);
  await view.click(button);
}

async function openAdd(view: View) {
  await view.waitFor(
    () => view.buttonNamed("Add login") !== undefined,
    "the add button",
  );
  const add = view.buttonNamed("Add login");
  if (!add) throw new Error("no add button");
  await view.click(add);
  await view.waitFor(() => field("login-label") !== null, "the form");
}

async function fill(view: View, values: Record<string, string>) {
  for (const [id, value] of Object.entries(values)) {
    const box = field(id);
    if (!box) throw new Error(`no box ${id}`);
    await view.type(box, value);
  }
}

async function save(view: View) {
  const button = pageButton("Save");
  if (!button) throw new Error("no Save");
  await view.click(button);
}

// 1. A new one, as it was typed.
let siteBox = "";
const saved = await (async (): Promise<LoginsShown["saved"]> => {
  const { api, writes } = server();
  const view = await mountApp({ path: "/settings/logins", api });
  await openAdd(view);
  siteBox = document.getElementById("login-site")?.textContent ?? "";
  await fill(view, {
    "login-addresses":
      " nid.naver.com \nsell.smartstore.naver.com, shop.example\n",
    "login-label": "네이버 (가게)",
    "login-username": "sajang",
    "login-password": " hunter2 ",
  });
  await save(view);
  await view.waitFor(() => writes.length === 1, "the save");
  await view.waitFor(
    () => field("login-password") === null,
    "the dialog to close",
  );
  await view.waitFor(
    () => view.host.textContent?.includes("네이버 (가게)") === true,
    "the new row",
  );
  const shown = {
    writes: [...writes],
    isDialogClosed: field("login-password") === null,
    isRowDrawn: view.host.textContent?.includes("네이버 (가게)") === true,
    isValueLeft: document.body.innerHTML.includes("hunter2"),
  };
  await view.unmount();
  return shown;
})();

// 2. A saved one, changed without its values.
const changed = await (async (): Promise<LoginsShown["changed"]> => {
  const { api, writes } = server({ logins: [NAVER] });
  const view = await mountApp({ path: "/settings/logins", api });
  await pressLabelled(view, `Change ${NAVER.label}`);
  await view.waitFor(() => field("login-label") !== null, "the form");
  const opened = Object.fromEntries(
    ["login-label", "login-addresses", "login-username", "login-password"].map(
      (id) => [id, field(id)?.value ?? "(absent)"],
    ),
  );
  await fill(view, { "login-label": "네이버" });
  await save(view);
  await view.waitFor(() => writes.length === 1, "the change");
  const first = [...writes];
  await view.waitFor(() => field("login-label") === null, "the form to close");

  // Only a new password: nothing else of the login is said again.
  await pressLabelled(view, "Change 네이버");
  await view.waitFor(() => field("login-password") !== null, "the form again");
  await fill(view, { "login-password": "new-pass" });
  await save(view);
  await view.waitFor(() => writes.length === 2, "the password's change");
  const passwordOnly = writes.slice(1);
  await view.waitFor(() => field("login-label") === null, "the form to close");

  // Nothing at all: saved as it was opened, and the server is not asked for anything.
  await pressLabelled(view, "Change 네이버");
  await view.waitFor(() => field("login-label") !== null, "the form once more");
  await save(view);
  await view.settle(60);
  const untouched = {
    writes: writes.slice(2),
    isDialogClosed: field("login-label") === null,
  };
  await view.unmount();

  // Deleted elsewhere while its form was open: the change is refused, and the list is read again.
  let isGone = false;
  const elsewhere = server({ logins: [NAVER] });
  const stale = await mountApp({
    path: "/settings/logins",
    api: (request) => {
      if (request.pathname.startsWith("/api/logins") && isGone) {
        return request.method === "GET"
          ? json({ logins: [], max: 100 })
          : json(
              { error: "laf:login_not_found", code: "laf:login_not_found" },
              404,
            );
      }
      return elsewhere.api(request);
    },
  });
  await pressLabelled(stale, `Change ${NAVER.label}`);
  await stale.waitFor(() => field("login-label") !== null, "the stale form");
  isGone = true;
  await fill(stale, { "login-label": "다른 이름" });
  await save(stale);
  const sentence = "That login is not saved any more.";
  await stale.waitFor(
    () => document.body.textContent?.includes(sentence) === true,
    "the refusal of a change to a login that is gone",
  );
  await stale.waitFor(
    () => stale.host.textContent?.includes(NAVER.label) !== true,
    "the row to leave the list",
  );
  const gone = {
    isSaid: document.body.textContent?.includes(sentence) === true,
    isRowLeft: stale.host.textContent?.includes(NAVER.label) === true,
  };
  await stale.unmount();
  return { opened, writes: first, passwordOnly, untouched, gone };
})();

// 2b. A save still on its way, and everything that would close the dialog under it.
const pending = await (async (): Promise<LoginsShown["pending"]> => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { api, writes } = server({ hold });
  const view = await mountApp({ path: "/settings/logins", api });
  await openAdd(view);
  await fill(view, {
    "login-addresses": "shop.example",
    "login-label": "가게",
    "login-username": "sajang",
    "login-password": "hunter2",
  });
  await save(view);
  await view.waitFor(() => writes.length === 1, "the save to be sent");
  const popup = () => document.body.querySelector('[role="dialog"]');
  const open = popup();
  if (open) await view.press(open, "Escape");
  await view.settle(40);
  const isOpenAfterEscape = field("login-password") !== null;
  const close = popup()?.querySelector<HTMLButtonElement>(
    '[data-slot="dialog-close"]',
  );
  const isCloseDisabled = close ? close.disabled : false;
  if (close) await view.click(close);
  await view.settle(40);
  const isOpenAfterClose = field("login-password") !== null;
  release();
  await view.waitFor(
    () => field("login-password") === null,
    "the dialog to close",
  );
  const shown = {
    isOpenAfterEscape,
    isOpenAfterClose,
    isCloseDisabled,
    isClosedOnceSaved: field("login-password") === null,
  };
  await view.unmount();
  return shown;
})();

// 3. A refusal about one box.
const refused = await (async (): Promise<LoginsShown["refused"]> => {
  const { api, writes } = server({
    refuse: {
      status: 400,
      body: {
        error: "laf:login_origin_refused",
        code: "laf:login_origin_refused",
        field: "origins",
      },
    },
  });
  const view = await mountApp({ path: "/settings/logins", api });
  await openAdd(view);
  await fill(view, {
    "login-addresses": "http://shop.example",
    "login-label": "가게",
    "login-username": "sajang",
    "login-password": "hunter2",
  });
  await save(view);
  await view.waitFor(() => writes.length === 1, "the refused save");
  const sentence = "That is not an address a login can be saved for.";
  await view.waitFor(
    () => document.body.textContent?.includes(sentence) === true,
    "the refusal",
  );
  const shown = {
    writes: writes.length,
    isSaid: document.body.textContent?.includes(sentence) === true,
    addressesInvalid:
      field("login-addresses")?.getAttribute("aria-invalid") ?? null,
    labelInvalid: field("login-label")?.getAttribute("aria-invalid") ?? null,
    usernameKept: field("login-username")?.value ?? "(absent)",
    isCodeDrawn: document.body.textContent?.includes("laf:") === true,
  };
  await view.unmount();
  return shown;
})();

// 4. A delete of the second of two, and the question before it.
const OTHER = {
  ...NAVER,
  id: "login-2",
  label: "거래처 발주",
  site: null,
  origins: ["https://order.example.co.kr"],
};
const removed = await (async (): Promise<LoginsShown["removed"]> => {
  const { api, writes } = server({ logins: [NAVER, OTHER] });
  const view = await mountApp({ path: "/settings/logins", api });
  await pressLabelled(view, `Delete ${OTHER.label}`);
  const dialog = () =>
    document.body.querySelector('[role="alertdialog"], [role="dialog"]');
  await view.waitFor(() => dialog() !== null, "the question");
  const question =
    dialog()?.querySelector("h1, h2, h3")?.textContent?.trim() ?? "";
  const writesBeforeConfirm = writes.length;
  const confirm = pageButton("Delete");
  if (!confirm) throw new Error("no confirm");
  await view.click(confirm);
  await view.waitFor(() => writes.length === 1, "the delete");
  await view.waitFor(
    () => view.host.textContent?.includes(OTHER.label) !== true,
    "the row to go",
  );
  const rowsAfter = [
    ...view.host.querySelectorAll('[data-slot="item-title"]'),
  ].map((title) => title.textContent?.trim() ?? "");
  const firstWrites = [...writes];
  await view.unmount();

  // The same press on a login another window already deleted: the server says it is gone.
  const gone = server({
    logins: [NAVER],
    refuse: {
      status: 404,
      body: { error: "laf:login_not_found", code: "laf:login_not_found" },
    },
  });
  const again = await mountApp({ path: "/settings/logins", api: gone.api });
  await pressLabelled(again, `Delete ${NAVER.label}`);
  await again.waitFor(() => dialog() !== null, "the second question");
  const confirmAgain = pageButton("Delete");
  if (!confirmAgain) throw new Error("no second confirm");
  await again.click(confirmAgain);
  await again.waitFor(() => gone.writes.length === 1, "the refused delete");
  await again.settle(80);
  const refusedText = dialog()?.textContent ?? "";
  await again.unmount();
  return {
    question,
    writesBeforeConfirm,
    writes: firstWrites,
    rowsAfter,
    refusedText,
  };
})();

const shown: LoginsShown = {
  siteBox,
  saved,
  changed,
  pending,
  refused,
  removed,
};
console.log(`LOGINS_RENDER ${JSON.stringify(shown)}`);
await GlobalRegistrator.unregister();
process.exit(0);
