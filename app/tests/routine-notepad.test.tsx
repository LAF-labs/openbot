import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  notepadEntryLabel,
  type RoutineNotepad,
} from "../src/lib/routines/queries";
import { stubFetch } from "./support/fetch";
import { json, mount, unmountAll } from "./support/mount";

/**
 * 메모장 on a routine's row: where it left off, readable, clearable, and never writable here.
 *
 * Rendered rather than grepped, for the part a DOM can answer: what an entry says, what an empty
 * notepad says, that nothing on the section takes typing, and that pressing Clear sends nothing by
 * itself. The confirm dialog it opens is Base UI's portal, which this suite cannot render reliably
 * (`confirm-dialog.test.tsx` says why), so the press through it is read off the source and was
 * measured in the browser.
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

const WRITTEN: RoutineNotepad = {
  entries: [
    {
      key: "new_reviews",
      kind: "watermark",
      lastId: "R-1002",
      lastAt: "2026-09-14T07:20:00+09:00",
      at: "2026-09-13T22:30:00.000Z",
    },
    {
      key: "pending",
      kind: "note",
      value: "문의 #88 사장님 확인 대기",
      at: "2026-09-13T22:30:00.000Z",
    },
  ],
  updatedAt: "2026-09-13T22:30:00.000Z",
};

describe("what an entry says", () => {
  test("a note is its value, and a watermark is where the routine got to", () => {
    const [watermark, note] = WRITTEN.entries;
    if (!watermark || !note) throw new Error("fixture");
    // The runner's locale is English; the Korean side is the dictionary's.
    expect(notepadEntryLabel(note)).toBe("문의 #88 사장님 확인 대기");
    expect(notepadEntryLabel(watermark)).toStartWith("Up to R-1002, ");
    expect(notepadEntryLabel(watermark)).not.toContain("lastId");
    expect(
      notepadEntryLabel({ ...watermark, lastAt: undefined, kind: "watermark" }),
    ).toBe("Up to R-1002");
    expect(
      notepadEntryLabel({
        key: "k",
        kind: "watermark",
        lastAt: "2026-09-14T07:20:00+09:00",
        at: "",
      }),
    ).toStartWith("Up to ");
  });
});

type Request = { method: string; url: string };

function server(notepad: RoutineNotepad) {
  const requests: Request[] = [];
  globalThis.fetch = stubFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (url === "/api/routines/r1/notepad" && method === "GET") {
      return json({ notepad });
    }
    if (url === "/api/routines/r1/notepad" && method === "DELETE") {
      return json({ cleared: notepad.entries.length });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  return requests;
}

async function mountedNotepad() {
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { RoutineNotepad } = await import("../src/components/routines/notepad");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = await mount(
    <QueryClientProvider client={client}>
      <RoutineNotepad routineId="r1" />
    </QueryClientProvider>,
  );
  await view.settle();
  return view;
}

describe("the notepad on a routine's row", () => {
  test("lists where the routine left off, by name", async () => {
    server(WRITTEN);
    const view = await mountedNotepad();

    const names = [...view.host.querySelectorAll("dt")].map(
      (term) => term.textContent,
    );
    expect(names).toEqual(["new_reviews", "pending"]);
    const said = [...view.host.querySelectorAll("dd")].map(
      (detail) => detail.textContent,
    );
    expect(said[0]).toStartWith("Up to R-1002, ");
    expect(said[1]).toBe("문의 #88 사장님 확인 대기");
  });

  test("offers no way to write one: nothing on it takes typing", async () => {
    const requests = server(WRITTEN);
    const view = await mountedNotepad();

    expect(
      view.host.querySelectorAll("input, textarea, [contenteditable]"),
    ).toHaveLength(0);
    // Reading it is the only request drawing it makes.
    expect(requests).toEqual([
      { method: "GET", url: "/api/routines/r1/notepad" },
    ]);
  });

  test("Clear asks before anything is sent", async () => {
    const requests = server(WRITTEN);
    const view = await mountedNotepad();
    const clear = [...view.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear",
    );
    expect(clear).toBeDefined();
    if (clear) await view.press(clear);

    // The press opens the question; only its confirm sends the DELETE.
    expect(requests.filter((request) => request.method === "DELETE")).toEqual(
      [],
    );
  });

  test("an empty notepad says so, and offers nothing to clear", async () => {
    server({ entries: [], updatedAt: null });
    const view = await mountedNotepad();

    expect(view.host.textContent).toContain("Nothing noted yet.");
    expect(
      [...view.host.querySelectorAll("button")].map(
        (button) => button.textContent,
      ),
    ).toEqual([]);
  });

  test("the clear goes through the confirm, to the notepad's own DELETE, and says what it costs", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/components/routines/notepad.tsx"),
      "utf8",
    );
    expect(source).toContain("<ConfirmDialog");
    // Awaited, so the dialog stays open until the notepad is empty and says so inside if it is not.
    expect(source).toContain("onConfirm={() => clear.mutateAsync()}");
    // And asked again at the press: an empty notepad, or a routine gone, sends nothing.
    expect(source).toContain("recheck={() => notepadClearRecheck(routineId)}");
    expect(source).toMatch(
      /routineRequest\(`\/api\/routines\/\$\{routineId\}\/notepad`, \{\s*method: "DELETE",/,
    );
    expect(source).toContain("may go over the same things again");
    // And the routines page draws it where a routine's runs are read.
    const page = readFileSync(
      join(import.meta.dir, "../src/routes/_authed/_app/routines.tsx"),
      "utf8",
    );
    expect(page).toContain("<RoutineNotepad routineId={routine.id} />");
  });
});
