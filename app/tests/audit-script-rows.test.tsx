import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { RUN_SCRIPT_TOOL } from "../../server/src/computer/gateway/intent";
import {
  APP_DOM_TIMEOUT_MS,
  installAppDom,
  json,
  mountApp,
  removeAppDom,
  unmountApps,
} from "./support/app-router";

/**
 * THE TRAIL'S PAGE, DRAWING THE ROWS A SCRIPT'S RUN LEAVES.
 *
 * `audit-labels.test.ts` walks the tables these rows are worded from, and that is a claim about
 * tables. This is the page itself, mounted in the app's own router with the server answering the
 * rows a run writes (`server/src/computer/gateway/trail.ts`) — the decision, the ending, a file it
 * made, a run that was stopped at its time, and one that never ran — and what is held is what a
 * person scanning the table reads: what it was, which script and which files, how it ended, what
 * it made, and nothing that is not in the row.
 *
 * In a DOM and not in a browser: no deployment can hold such a row yet, since nothing offers a
 * run to a Bot, so there is no page anywhere to open and look at.
 */

beforeAll(installAppDom, APP_DOM_TIMEOUT_MS);
afterEach(unmountApps);
afterAll(async () => {
  await removeAppDom();
});

const SHA = "c3815262b66fc367c70635fa8727eff314ef53a89542666c0d09a825569754d0";
const script = { sha256: SHA, bytes: 58 };
const base = {
  actorUserId: null,
  targetType: "computer",
  targetId: "default",
};
const decision = {
  allowed: true,
  source: "allow",
  rule: "true",
  carriedOut: true,
};

/** Newest first, as the API returns them: each a second after the one below it. */
const EVENTS = [
  {
    ...base,
    id: "row-6",
    eventType: "computer.action_failed",
    createdAt: "2026-10-07T03:00:06.000Z",
    payload: {
      action: RUN_SCRIPT_TOOL,
      bot: "bot-1",
      actor: "user-1",
      page: "",
      ref: null,
      script: { sha256: "f".repeat(64), bytes: 20 },
      files: [],
      failure: "laf:workbench_unavailable",
      decision,
    },
  },
  {
    ...base,
    id: "row-5",
    eventType: "computer.script_finished",
    createdAt: "2026-10-07T03:00:05.000Z",
    payload: {
      action: RUN_SCRIPT_TOOL,
      bot: "bot-1",
      actor: "user-1",
      script: { sha256: "e".repeat(64), bytes: 31 },
      ending: "timed_out",
      exit: null,
      signal: "SIGKILL",
      ms: 20_004,
      stdoutBytes: 0,
      stderrBytes: 0,
      products: [],
      skipped: 0,
    },
  },
  {
    ...base,
    id: "row-4",
    eventType: "computer.action_allowed",
    createdAt: "2026-10-07T03:00:04.000Z",
    payload: {
      action: "computer_write_file",
      bot: "bot-1",
      actor: "user-1",
      page: "",
      ref: null,
      file: "made/2026-10-07-763a3113/요일별 매출.csv",
      decision,
    },
  },
  {
    ...base,
    id: "row-3",
    eventType: "computer.script_finished",
    createdAt: "2026-10-07T03:00:03.000Z",
    payload: {
      action: RUN_SCRIPT_TOOL,
      bot: "bot-1",
      actor: "user-1",
      script,
      ending: "exited",
      exit: 0,
      signal: null,
      ms: 412,
      stdoutBytes: 26,
      stderrBytes: 3,
      products: [
        { name: "요일별 매출.csv", bytes: 29 },
        { name: "notes.txt", bytes: 4 },
      ],
      skipped: 0,
    },
  },
  {
    ...base,
    id: "row-2",
    eventType: "computer.action_allowed",
    createdAt: "2026-10-07T03:00:02.000Z",
    payload: {
      action: RUN_SCRIPT_TOOL,
      bot: "bot-1",
      actor: "user-1",
      page: "",
      ref: null,
      script,
      files: ["uploads/매출.csv", "uploads/비용.csv"],
      decision,
    },
  },
];

async function drawn() {
  const view = await mountApp({
    path: "/admin/audit",
    role: "admin",
    api: (request) =>
      request.pathname === "/api/admin/audit-events"
        ? json({ events: EVENTS })
        : undefined,
  });
  await view.waitFor(
    () => (view.main()?.querySelectorAll("tbody tr").length ?? 0) > 1,
    "the trail's rows",
  );
  /** One drawn row by the id of its event: the cells' text, and the row itself. */
  const rows = [...(view.main()?.querySelectorAll("tbody tr") ?? [])].filter(
    (row) => row.querySelectorAll("td").length === 5,
  );
  const cells = (index: number) =>
    [...(rows[index]?.querySelectorAll("td") ?? [])].map((cell) =>
      (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
  return { view, rows, cells };
}

describe("the trail's page and a script's run", () => {
  test("the decision says what it was, which script by its digest, and the files it was handed", async () => {
    const { view, rows, cells } = await drawn();
    expect(rows).toHaveLength(EVENTS.length);
    // Newest first: the decision is the last of the five.
    const [, what, target, , verdict] = cells(4);
    expect(what).toBe("Run a small program");
    // The start of the digest in the chip, the whole of it one hover away, and each file by name.
    expect(target).toBe(
      `${SHA.slice(0, 12)}uploads/매출.csv, uploads/비용.csv`,
    );
    expect(rows[4]?.querySelector(`[title="${SHA}"]`)).not.toBeNull();
    expect(verdict).toBe("Allowed");
    // No site under it: a run has no page.
    expect(target).not.toContain("http");
    await view.unmount();
  });

  test("the ending says how it ended, how long it took, how much it printed, and what it made — by name", async () => {
    const { view, rows, cells } = await drawn();
    const [, what, target, , verdict] = cells(3);
    expect(what).toBe("Run a small program");
    expect(target).toBe(SHA.slice(0, 12));
    expect(verdict).toBe(
      "The program's run ended" +
        "It ended by itself, with status 0" +
        "412 ms · printed 29 bytes" +
        "Handed back 2 files요일별 매출.csvnotes.txt",
    );
    // Ended well: the colour of a row there is nothing to stop at.
    expect(rows[3]?.querySelector(".text-warning")).toBeNull();
    // And the file it made has a row of its own above it, with its path.
    expect(cells(2)[1]).toBe("Write a file");
    expect(cells(2)[2]).toBe("made/2026-10-07-763a3113/요일별 매출.csv");
    await view.unmount();
  });

  test("a run stopped at its time says so, in the colour a reader skims for, with no status and no files", async () => {
    const { view, rows, cells } = await drawn();
    const verdict = cells(1)[4];
    expect(verdict).toBe(
      "The program's run ended" +
        "It was stopped at the time it was given" +
        "20004 ms · printed 0 bytes",
    );
    expect(rows[1]?.querySelector(".text-warning")?.textContent).toBe(
      "The program's run ended",
    );
    await view.unmount();
  });

  test("a run that was allowed and never ran says why in words, and never as a code", async () => {
    const { view, cells } = await drawn();
    const [, what, target, , verdict] = cells(0);
    expect(what).toBe("Run a small program");
    expect(target).toBe("f".repeat(12));
    expect(verdict).toBe(
      "Did not happen" +
        "The place programs run did not answer, so nothing ran",
    );
    // Nowhere on the page is a fact shown as its code, or the tool by its identifier.
    const page = view.main()?.textContent ?? "";
    expect(page).not.toContain("laf:");
    expect(page).not.toContain(RUN_SCRIPT_TOOL);
    await view.unmount();
  });
});
