import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { soleBrowser } from "../agent-computer/src/browsers";
import type { Computer } from "../agent-computer/src/computer";
import type { StreamData } from "../agent-computer/src/live-screen";
import { computerFetch } from "../agent-computer/src/routes";
import { createSessions } from "../agent-computer/src/sessions";
import { createWorkspace } from "../agent-computer/src/workspace";
import type { AuditEventInput } from "../server/src/audit";
import { createApprovalRegistry } from "../server/src/computer/approvals";
import { createComputerClient } from "../server/src/computer/client";
import {
  type ActionActor,
  createComputerGateway,
} from "../server/src/computer/gateway";
import { createResultSpill } from "../server/src/computer/spillover";
import {
  FILE_SCOPE_HEADER,
  MAIN_SCOPE,
  OLDER_COPIES_PER_CALL,
  PERSON_SCOPE,
  projectScope,
} from "../shared/file-scope";

/**
 * A PROJECT'S FOLDER, FROM THE SERVER'S GATEWAY TO THE DISK, WITH NOTHING FAKED IN BETWEEN
 * (record §3, piece 4-2's second part, 2026-10-11).
 *
 * The rule has two halves in two workspaces — the server places a write, the computer refuses what
 * a scope may not reach — and each half's own tests stand the other in. Here the server's real
 * gateway and client speak to the container's real routes over a socket, onto a real folder: who
 * is acting is read from the conversation, said in a header, and held to on disk.
 *
 * At the root because it is about the wire between the two (`file-handoff.test.ts`).
 */

const TOKEN = "project-folder-e2e-token";
const BOT = "bot-1";
/** Which conversations are projects: what `thread-projects.ts` answers in a deployment. */
const PROJECT_OF: Record<string, string | null> = {
  "thread-a": "channel_a",
  "thread-b": "channel_b",
  "thread-main": null,
};
const IN_A = { id: "owner-user", threadId: "thread-a" };
const IN_B = { id: "owner-user", threadId: "thread-b" };
const IN_MAIN = { id: "owner-user", threadId: "thread-main" };
/** A routine's run, a check: nothing that names a conversation. */
const NO_CONVERSATION = { id: "owner-user" };

let base: string;
let root: string;
let container: ReturnType<typeof Bun.serve>;
let client: ReturnType<typeof createComputerClient>;
let gateway: ReturnType<typeof createComputerGateway>;
const rows: AuditEventInput[] = [];
/** Each call that reached the container: its path and the scope it said. */
const reached: { path: string; scope: string | null }[] = [];

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "laf-project-folder-e2e-"));
  root = join(base, "workspace");
  await mkdir(root, { recursive: true });
  const computer = {
    config: { token: TOKEN },
    profiles: { follow: async () => undefined },
    workspace: createWorkspace(root),
    sessions: createSessions({
      stateDirectoryFor: (botId) => join(base, "state", botId),
    }),
  } as unknown as Computer;
  const handle = computerFetch(soleBrowser(computer));
  container = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, server) => {
      reached.push({
        path: new URL(request.url).pathname,
        scope: request.headers.get(FILE_SCOPE_HEADER),
      });
      return handle(request, server as unknown as Server<StreamData>);
    },
  });
  client = createComputerClient({
    baseUrl: `http://127.0.0.1:${container.port}`,
    token: TOKEN,
    allowPrivateHosts: true,
  });
  const policy = { deny: [], ask: [], allow: ["true"] };
  gateway = createComputerGateway({
    client,
    auditStore: {
      insert: async (event) => {
        rows.push(event);
      },
    },
    policy: () => policy,
    approvals: createApprovalRegistry(),
    projectOf: async (threadId) => {
      if (!(threadId in PROJECT_OF)) throw new Error("the database is away");
      return PROJECT_OF[threadId] ?? null;
    },
  });
});

afterAll(async () => {
  await container.stop(true);
  await rm(base, { recursive: true, force: true });
});

const cameOf = (work: () => Promise<unknown>) =>
  work().then(
    (value) => JSON.stringify(value),
    (error: Error) => error.message,
  );

describe("what a project's run writes", () => {
  test("lands in the project's own folder, and the Bot is told where", async () => {
    rows.length = 0;
    reached.length = 0;

    const written = await gateway.writeFile("default", BOT, IN_A, {
      path: "보고서/9월.md",
      contents: "A의 매출",
    });

    expect(written).toMatchObject({
      path: "projects/channel_a/보고서/9월.md",
    });
    expect(
      await readFile(
        join(root, "projects", "channel_a", "보고서", "9월.md"),
        "utf8",
      ),
    ).toBe("A의 매출");
    // Nothing in the Bot's own folder: the write was placed, not copied.
    expect(await readdir(root)).toEqual(["projects"]);
    expect(reached).toEqual([
      { path: "/files/write", scope: "project:channel_a" },
    ]);
  });

  test("is recorded under the place it really went, which is what a rule was asked about", async () => {
    rows.length = 0;
    await gateway.writeFile("default", BOT, IN_A, {
      path: "notes.md",
      contents: "x",
    });
    const trail = JSON.stringify(rows);
    expect(trail).toContain("projects/channel_a/notes.md");
  });

  test("a rule about the project's folder is asked about the placed path, and can refuse it", async () => {
    const refusing = createComputerGateway({
      client,
      auditStore: { insert: async () => undefined },
      policy: () => ({
        deny: ['matches(file.path, "^projects/channel_a/secret/")'],
        ask: [],
        allow: ["true"],
      }),
      approvals: createApprovalRegistry(),
      projectOf: async (threadId) => PROJECT_OF[threadId] ?? null,
    });
    expect(
      await cameOf(() =>
        refusing.writeFile("default", BOT, IN_A, {
          path: "secret/key.md",
          contents: "x",
        }),
      ),
    ).toBe("laf:policy_denied");
    // And the same name in the main conversation is another file, which the rule says nothing of.
    expect(
      await cameOf(() =>
        refusing.writeFile("default", BOT, IN_MAIN, {
          path: "secret/key.md",
          contents: "x",
        }),
      ),
    ).toContain('"path":"secret/key.md"');
    await rm(join(root, "secret"), { recursive: true });
    expect(await readdir(join(root, "projects", "channel_a"))).not.toContain(
      "secret",
    );
  });

  test("written again by the name it was told, it is the same file and not a folder deeper", async () => {
    await gateway.writeFile("default", BOT, IN_A, {
      path: "projects/channel_a/보고서/9월.md",
      contents: "A의 매출, 고침",
    });
    expect(
      await readFile(
        join(root, "projects", "channel_a", "보고서", "9월.md"),
        "utf8",
      ),
    ).toBe("A의 매출, 고침");
    expect(await readdir(join(root, "projects", "channel_a"))).not.toContain(
      "projects",
    );
  });

  test("is read back by that project, by the name it was told", async () => {
    const read = await gateway.readFile("default", BOT, IN_A, {
      path: "projects/channel_a/보고서/9월.md",
    });
    expect(JSON.stringify(read)).toContain("A의 매출, 고침");
  });
});

describe("what a project's run wrote, asked for by somebody else", () => {
  const FILE = "projects/channel_a/보고서/9월.md";

  test.each([
    ["another project", IN_B],
    ["the main conversation", IN_MAIN],
    ["a run that is no conversation's", NO_CONVERSATION],
  ])("is not read by %s", async (_who, actor) => {
    const came = await cameOf(() =>
      gateway.readFile("default", BOT, actor, { path: FILE }),
    );
    expect(came).toBe("laf:file_path_refused");
    expect(came).not.toContain("매출");
  });

  test.each([
    ["another project", IN_B],
    ["the main conversation", IN_MAIN],
  ])("is not written over by %s", async (_who, actor) => {
    expect(
      await cameOf(() =>
        gateway.writeFile("default", BOT, actor, {
          path: FILE,
          contents: "somebody else's",
        }),
      ),
    ).toBe("laf:file_path_refused");
    expect(
      await readFile(
        join(root, "projects", "channel_a", "보고서", "9월.md"),
        "utf8",
      ),
    ).toBe("A의 매출, 고침");
  });

  test("is in no listing the main conversation is given, and in none of another project's", async () => {
    await gateway.writeFile("default", BOT, IN_MAIN, {
      path: "메모.md",
      contents: "main's",
    });
    await gateway.writeFile("default", BOT, IN_B, {
      path: "b.md",
      contents: "B's",
    });

    const main = JSON.stringify(
      await gateway.listFiles("default", BOT, IN_MAIN, {}),
    );
    expect(main).toContain("메모.md");
    expect(main).not.toContain("channel_a");
    expect(main).not.toContain("projects");

    const other = JSON.stringify(
      await gateway.listFiles("default", BOT, IN_B, {}),
    );
    expect(other).toContain("projects/channel_b/b.md");
    // The Bot's own folder is every project's to read.
    expect(other).toContain("메모.md");
    expect(other).not.toContain("channel_a");
  });

  test.each([
    ["another project", IN_B],
    ["the main conversation", IN_MAIN],
  ])(
    "is not a file %s's turn can put a card up for, or learn is there",
    async (_who, actor) => {
      // What a turn asks before it tells the Bot its card is on screen (`chat-tools.ts`).
      expect(await cameOf(() => gateway.fileFacts(BOT, FILE, actor))).toBe(
        "laf:file_path_refused",
      );
      expect(
        await cameOf(() =>
          gateway.fileFacts(BOT, "projects/channel_a/없는 파일.md", actor),
        ),
      ).toBe("laf:file_path_refused");
    },
  );

  test("is a file its own project's turn can put a card up for, and the card can ask of", async () => {
    expect(await gateway.fileFacts(BOT, FILE, IN_A)).toMatchObject({
      kind: "file",
    });
    // The card's own question, at the person's door.
    expect(await gateway.fileFacts(BOT, FILE)).toMatchObject({ kind: "file" });
  });

  test("is the person's to see, at the person's own door", async () => {
    const listed = await gateway.personFiles(BOT);
    expect(JSON.stringify(listed)).toContain("projects/channel_a");
  });
});

/**
 * EVERY SPELLING OF ANOTHER PROJECT'S FILE, OVER THE REAL WIRE (the review of 2026-10-11).
 *
 * The computer trims and resolves a path, so `./projects//channel_a/…`, `Projects/…` and
 * `projects/channel_b/../channel_a/…` are one file there; the rule is asked by name. Here each
 * spelling a model or a page could write goes from the gateway to the disk, as another project and
 * as the main conversation, and is held out — and the one that reads a name the computer does not
 * decode is shown to be a name, not a way in. One test per spelling, so no case waits on another.
 */
describe("every spelling of another project's file", () => {
  const FILE = "projects/channel_a/보고서/9월.md";
  const CONTENTS = "A의 매출, 고침";
  const onDisk = () =>
    readFile(join(root, "projects", "channel_a", "보고서", "9월.md"), "utf8");
  /** What the root held when this began: no spelling may add to it. */
  let rootBefore: string[] = [];
  beforeAll(async () => {
    rootBefore = (await readdir(root)).sort();
  });

  /** A spelling, and what the gateway answers whoever is not channel_a's for a read of it. */
  const REFUSED: readonly [string, string][] = [
    ["a dot and a doubled slash", "./projects//channel_a/보고서/9월.md"],
    ["a trailing slash", `${FILE}/`],
    ["a dot in the middle", "projects/./channel_a/보고서/9월.md"],
    ["other letters", "Projects/channel_a/보고서/9월.md"],
    ["every letter upper", "PROJECTS/channel_a/보고서/9월.md"],
    ["an absolute path", `/${FILE}`],
    ["a climb from the root", `../${FILE}`],
    ["a climb through a folder of the Bot's", `notes/../${FILE}`],
    [
      "a climb through its own folder",
      `projects/channel_b/../${FILE.slice(9)}`,
    ],
    ["backslashes", "projects\\channel_a\\보고서\\9월.md"],
    ["a backslash at the end", `${FILE}\\`],
    ["white space at the ends", `  ${FILE}  `],
    ["a NUL at the end", `${FILE}\u0000`],
    ["the folder's name in decomposed Korean", FILE.normalize("NFD")],
  ];
  /**
   * Spellings the computer reads as names it has no file for: it decodes nothing, so `%2e%2e` is a
   * folder called that, and a division slash (U+2215) or a full-width letter is a letter. Not a way
   * in — there is nothing there — and said here so that a reader of this table knows the answer
   * is "no such file" and not "refused".
   */
  const NAMES_OF_NOTHING: readonly [string, string][] = [
    ["percent-encoded dots", `%2e%2e/${FILE}`],
    ["percent-encoded slashes", FILE.replaceAll("/", "%2F")],
    ["a division slash", FILE.replace("projects/", "projects∕")],
    ["a full-width first letter", `ｐ${FILE.slice(1)}`],
  ];
  const WHOEVER: readonly [string, ActionActor][] = [
    ["another project", IN_B],
    ["the main conversation", IN_MAIN],
  ];
  const over = (
    table: readonly [string, string][],
    fact: string,
  ): [string, string, ActionActor, string, string][] =>
    table.flatMap(([name, path]) =>
      WHOEVER.map(
        ([who, actor]): [string, string, ActionActor, string, string] => [
          name,
          who,
          actor,
          path,
          fact,
        ],
      ),
    );

  test.each([
    ...over(REFUSED, "laf:file_path_refused"),
    ...over(NAMES_OF_NOTHING, "laf:file_not_found"),
  ])("is not read through %s by %s", async (_name, _who, actor, path, fact) => {
    const came = await cameOf(() =>
      gateway.readFile("default", BOT, actor, { path }),
    );
    expect(came).toBe(fact);
    expect(came).not.toContain("매출");
  });

  test.each(over(REFUSED, "laf:file_path_refused"))(
    "is not written over through %s by %s",
    async (_name, _who, actor, path, fact) => {
      expect(
        await cameOf(() =>
          gateway.writeFile("default", BOT, actor, {
            path,
            contents: "somebody else's",
          }),
        ),
      ).toBe(fact);
      expect(await onDisk()).toBe(CONTENTS);
      expect((await readdir(root)).sort()).toEqual(rootBefore);
    },
  );

  test.each(over(REFUSED, "laf:file_path_refused"))(
    "is not a card's file through %s for %s",
    async (_name, _who, actor, path, fact) => {
      expect(await cameOf(() => gateway.fileFacts(BOT, path, actor))).toBe(
        fact,
      );
    },
  );

  test.each([
    ["a trailing slash", "projects/channel_a/"],
    ["a dot", "./projects/channel_a"],
    ["other letters", "Projects/channel_a"],
    ["a climb", "projects/channel_b/../channel_a"],
  ])(
    "its folder is not listed through %s by another project",
    async (_name, path) => {
      expect(
        await cameOf(() => gateway.listFiles("default", BOT, IN_B, { path })),
      ).toBe("laf:file_path_refused");
    },
  );

  test.each([
    ["a trailing slash", "projects/"],
    ["a dot", "./projects"],
    ["other letters", "Projects"],
    ["a doubled slash", "projects//channel_a"],
  ])(
    "the projects' folder is not listed through %s by the main conversation",
    async (_name, path) => {
      expect(
        await cameOf(() =>
          gateway.listFiles("default", BOT, IN_MAIN, { path }),
        ),
      ).toBe("laf:file_path_refused");
    },
  );

  test("the way down to its own, spelled otherwise, still shows another project nothing", async () => {
    const shown = JSON.stringify(
      await gateway.listFiles("default", BOT, IN_B, { path: "./projects/" }),
    );
    expect(shown).toContain("projects/channel_b/b.md");
    expect(shown).not.toContain("channel_a");
  });

  test("a refused spelling is on the trail, under the one spelling, as an act that did not happen", async () => {
    rows.length = 0;
    await cameOf(() =>
      gateway.readFile("default", BOT, IN_MAIN, {
        path: "./projects//channel_a/보고서/9월.md",
      }),
    );
    const failed = rows.find(
      (row) => row.eventType === "computer.action_failed",
    );
    expect(JSON.stringify(failed)).toContain(FILE);
    expect(JSON.stringify(failed)).toContain("laf:file_path_refused");
  });
});

describe("where a project's own write goes, spelled otherwise", () => {
  test("a dot and a doubled slash are placed in its folder, and the Bot is told the one spelling", async () => {
    const written = await gateway.writeFile("default", BOT, IN_A, {
      path: "./메모//10월.md",
      contents: "A의 메모",
    });
    expect(written).toMatchObject({ path: "projects/channel_a/메모/10월.md" });
    expect(
      await readFile(
        join(root, "projects", "channel_a", "메모", "10월.md"),
        "utf8",
      ),
    ).toBe("A의 메모");
  });

  test.each([
    ["a climb out of its folder", "../escape.md"],
    ["a climb from inside its folder", "projects/channel_a/../escape.md"],
    ["a climb into another's", "projects/channel_a/../channel_b/escape.md"],
    ["another's folder in other letters", "Projects/channel_a/escape.md"],
    ["its own folder in other letters", "projects/Channel_a/escape.md"],
    ["an absolute path", "/projects/channel_a/escape.md"],
  ])(
    "has no place through %s, and nothing lands anywhere",
    async (_name, path) => {
      const before = (await readdir(root)).sort();
      expect(
        await cameOf(() =>
          gateway.writeFile("default", BOT, IN_A, { path, contents: "x" }),
        ),
      ).toBe("laf:file_path_refused");
      expect((await readdir(root)).sort()).toEqual(before);
      expect(await readdir(join(root, "projects", "channel_b"))).toEqual([
        "b.md",
      ]);
      // Sorted: a disk lists in its own order — CI's ext4 answered channel_b before channel_a.
      expect((await readdir(join(root, "projects"))).sort()).toEqual([
        "channel_a",
        "channel_b",
      ]);
      expect(await readdir(join(root, "projects", "channel_a"))).not.toContain(
        "escape.md",
      );
    },
  );
});

describe("a call that does not say whose files it touches", () => {
  test("is refused by the computer, and nothing is written", async () => {
    const before = await readdir(root);
    const came = await cameOf(() =>
      client.forBot(BOT).writeFile({ path: "stray.md", contents: "x" }),
    );
    expect(came).toBe("laf:request_invalid");
    expect(await readdir(root)).toEqual(before);
  });

  test("a conversation whose project cannot be read fails the act, and nothing reaches the computer", async () => {
    reached.length = 0;
    const came = await cameOf(() =>
      gateway.writeFile(
        "default",
        BOT,
        { id: "owner-user", threadId: "thread-unknown" },
        { path: "guess.md", contents: "x" },
      ),
    );
    expect(came).toBe("the database is away");
    expect(reached).toEqual([]);
    expect(await readdir(root)).not.toContain("guess.md");
  });
});

describe("a long tool result, filed for the model", () => {
  test("goes in the project's folder for a project's run, and the main folder for any other", async () => {
    const spill = createResultSpill(client, {
      scopeOfThread: (threadId) => {
        const project = threadId ? PROJECT_OF[threadId] : null;
        return project ? projectScope(project) : MAIN_SCOPE;
      },
    });
    const long = "긴 결과 ".repeat(20_000);

    const forA = spill.forModel(BOT, "call_a", long, "thread-a");
    const forMain = spill.forModel(BOT, "call_main", long, "thread-main");
    await spill.settled();

    expect(forA).toContain("projects/channel_a/.results/");
    expect(forMain).not.toContain("projects/");
    expect(
      await readdir(join(root, "projects", "channel_a", ".results")),
    ).toHaveLength(1);
    expect(await readdir(join(root, ".results"))).toHaveLength(1);
  });
});

describe("a project, deleted", () => {
  test("its folder is removed by its id, as the person, and the others are as they were", async () => {
    const person = client.forBot(BOT, undefined, PERSON_SCOPE);

    expect(await person.removeProjectFolder("channel_a")).toBe(true);

    expect(await readdir(join(root, "projects"))).toEqual(["channel_b"]);
    expect(await readFile(join(root, "메모.md"), "utf8")).toBe("main's");
    // Asked again by the clock, there is nothing to remove, and that is not a failure.
    expect(await person.removeProjectFolder("channel_a")).toBe(false);
  });

  test("what it filed in uploads/ before it had a folder goes with it, by name", async () => {
    await mkdir(join(root, "uploads"), { recursive: true });
    await writeFile(join(root, "uploads", "2026-09-26-1a2b3c4d-매출.csv"), "x");
    await writeFile(join(root, "uploads", "main.csv"), "the main's");
    const person = client.forBot(BOT, undefined, PERSON_SCOPE);

    // The folder went in the test above; the copies are still asked for, as the clock would.
    expect(
      await person.removeProjectFolder("channel_a", [
        "2026-09-26-1a2b3c4d-매출.csv",
      ]),
    ).toBe(false);

    expect(await readdir(join(root, "uploads"))).toEqual(["main.csv"]);
  });

  test.each([
    [["../메모.md"]],
    [["uploads/main.csv"]],
    [[""]],
    ["main.csv"],
    [[7]],
    // One more than a call carries: the server sends them in as many calls as they need.
    [Array.from({ length: OLDER_COPIES_PER_CALL + 1 }, (_, n) => `${n}.csv`)],
  ])(
    "copies named by anything but a name, or more than a call carries, are refused whole: %#",
    async (olderCopies) => {
      const came = await fetch(
        `http://127.0.0.1:${container.port}/files/project/remove`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-openbot-computer-token": TOKEN,
            "x-openbot-bot-id": BOT,
            [FILE_SCOPE_HEADER]: "person",
          },
          body: JSON.stringify({ projectId: "channel_b", olderCopies }),
        },
      );
      expect(came.status).toBe(400);
      expect(await came.json()).toMatchObject({
        code: "laf:request_invalid",
        field: "olderCopies",
      });
      expect(await readdir(join(root, "projects"))).toEqual(["channel_b"]);
      expect(await readdir(join(root, "uploads"))).toEqual(["main.csv"]);
      expect(await readFile(join(root, "메모.md"), "utf8")).toBe("main's");
    },
  );

  test.each([
    ["a project's run", projectScope("channel_b")],
    ["the main conversation", MAIN_SCOPE],
  ])("no folder is removed for %s", async (_who, scope) => {
    const came = await cameOf(() =>
      client.forBot(BOT, undefined, scope).removeProjectFolder("channel_b"),
    );
    expect(came).toBe("laf:request_invalid");
    expect(await readdir(join(root, "projects"))).toEqual(["channel_b"]);
  });

  test.each(["..", "channel_b/..", "", "."])(
    "nothing is removed for an id that is a path: %j",
    async (id) => {
      const came = await cameOf(() =>
        client.forBot(BOT, undefined, PERSON_SCOPE).removeProjectFolder(id),
      );
      expect(came).toBe("laf:request_invalid");
      expect(await readdir(join(root, "projects"))).toEqual(["channel_b"]);
      expect(await readFile(join(root, "메모.md"), "utf8")).toBe("main's");
    },
  );
});
