import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile as readDisk,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listFiles as listRoute,
  readFile as readRoute,
  writeFile as writeRoute,
} from "../../agent-computer/src/file-routes";
import {
  createWorkspace,
  type Workspace,
} from "../../agent-computer/src/workspace";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  createComputerGateway,
} from "../src/computer/gateway";
import { workspacePathOf } from "../src/computer/gateway/addresses";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { createUnattendedTools } from "../src/runner/unattended";

/**
 * WHAT A RULE JUDGES IS WHAT THE COMPUTER ACTS ON (`gateway/addresses.ts`, `workspacePathOf`).
 *
 * The computer trims a path and resolves it, so one file has many spellings; a rule was asked about
 * whichever one a model wrote. An independent read of the script act (2026-10-07) walked a deny on
 * a file past with a trailing space, and the same was true of the Bot's own file tools.
 *
 * EVERY TEST HERE IS IN FRONT OF THE REAL WORKSPACE, reached through the computer's own route
 * handlers with the body the server's client posts — and what is asserted is what happened on
 * the disk: was the guarded file read, was it written over. The first version of this file used a
 * computer that echoed what it was sent and asserted on strings; a second independent read then
 * found a spelling (`"./ private/pay.csv"`) for which this function's answer was a DIFFERENT
 * file to the computer, deleted the line in `govern` that reads the path, and watched all twelve
 * tests pass. A fake that echoes cannot see either, so there is none here.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [{ ref: "e9", role: "button", name: "Submit order" }],
};
const ACTOR = { id: "dev-local-user" };
/** The control an upload names: the snapshot's button, at the snapshot the server holds. */
const TARGET = { ref: "e9", snapshotId: SNAPSHOT.snapshotId };

/** What each file in the folder holds, so that what was read says WHICH file was read. */
const PAYROLL = "[the payroll]";
const IN_A_SPACED_FOLDER =
  "[pay.csv, in a folder whose name begins with a space]";
const A_SPACED_NAME = "[a file whose name ends with a space, in private/]";
const SECRET = "[the secret]";
const NOTE = "[a note]";

let root = "";
let workspace: Workspace;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "laf-one-spelling-"));
  await mkdir(join(root, "private"), { recursive: true });
  await mkdir(join(root, " private"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "private", "pay.csv"), PAYROLL);
  await writeFile(join(root, " private", "pay.csv"), IN_A_SPACED_FOLDER);
  await writeFile(join(root, "private", "pay.csv "), A_SPACED_NAME);
  await writeFile(join(root, ".env"), SECRET);
  await writeFile(join(root, "notes", "a.md"), NOTE);
  workspace = createWorkspace(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Route = (asked: never, computer: never) => Promise<Response> | Response;

/** The computer's own handler for a file route, asked as the server's client asks it. */
async function through(route: Route, payload: unknown) {
  const request = new Request("http://computer/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const response = await route(
    { request, url: new URL(request.url), botId: "bot-1" } as never,
    { workspace } as never,
  );
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.code));
  return body;
}

/** The real workspace behind the client's shape, writing down the path each act handed it. */
function realComputer() {
  const sent: string[] = [];
  const client = {
    snapshot: async () => SNAPSHOT,
    status: async () => ({ botId: "b", state: "ready" as const }),
    readFile: async (input: { path: string }) => {
      sent.push(input.path);
      return through(readRoute as Route, input);
    },
    writeFile: async (input: { path: string }) => {
      sent.push(input.path);
      return through(writeRoute as Route, input);
    },
    listFiles: async (input: { path?: string }) => {
      sent.push(input.path ?? "(no path)");
      return through(listRoute as Route, input);
    },
    uploadFile: async (input: { path: string; ref: string }) => {
      sent.push(input.path);
      // What the computer hands the page is the file this path resolves to (`actions.ts`).
      const full = await workspace.resolvePath(input.path, false);
      return { handed: await readDisk(full, "utf8") };
    },
    downloadFile: async (path: string) => {
      sent.push(path);
      return new Uint8Array(
        await readDisk(await workspace.resolvePath(path, false)),
      );
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  return { client, sent };
}

async function gatewayUnder(
  policy: ActionPolicy,
  standing = createStandingApprovalStore(),
) {
  const { client, sent } = realComputer();
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => policy,
    approvals: createApprovalRegistry(),
    standing,
  });
  // An upload names a control, so the server holds a snapshot first, as the real flow does.
  await gateway.snapshot("default");
  return { gateway, sent, rows };
}

const allowingAllBut = (...deny: string[]): ActionPolicy => ({
  deny,
  ask: [],
  allow: ["true"],
});

/** What came of a call: what it read or handed over, or the fact it was refused or failed with. */
async function cameOf(work: () => Promise<unknown>): Promise<string> {
  try {
    const result = (await work()) as Record<string, unknown>;
    if (typeof result.text === "string") return `read: ${result.text}`;
    if (typeof result.handed === "string") return `handed: ${result.handed}`;
    if (Array.isArray(result.entries)) {
      return `listed: ${result.entries.map((entry) => (entry as { path: string }).path).join(" | ")}`;
    }
    return "done";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Every way a model, a slip or a page that wants a rule walked past might write one path. */
function spellingsOf(core: string): string[] {
  const before = [
    "",
    " ",
    "\t",
    "\n",
    " ",
    "./",
    "./ ",
    " ./",
    ".//",
    "./ ./ ",
  ];
  const after = [
    "",
    " ",
    "\n",
    "　",
    "/",
    "/.",
    "/./",
    " /",
    " /.",
    "/ ",
    "/. ",
  ];
  return before.flatMap((head) => after.map((tail) => `${head}${core}${tail}`));
}

const CORES = [
  "private/pay.csv",
  "private//pay.csv",
  "private/./pay.csv",
  " private/pay.csv",
  "private/pay.csv ",
  "private / pay.csv",
  ".env",
  "notes/a.md",
  "private",
  " private",
  ".",
] as const;
const EVERY_SPELLING = CORES.flatMap(spellingsOf);

/** None of these is a path in the folder: each is something the computer refuses as one. */
const NOT_A_PATH = [
  "/etc/passwd",
  "..",
  "a/../b",
  "private/../../etc/passwd",
  "a\0b",
] as const;

describe("a path in the Bot's folder has one spelling", () => {
  test("the ends are trimmed, and `.`, empty segments and a trailing slash are gone", () => {
    for (const spelling of [
      "private/pay.csv ",
      " private/pay.csv",
      "private/pay.csv\n",
      " private/pay.csv　",
      "./private/pay.csv",
      "private/./pay.csv",
      "private//pay.csv",
      "private/pay.csv/",
      "private/pay.csv/.",
      ".//private///pay.csv/./",
    ]) {
      expect(workspacePathOf(spelling)).toBe("private/pay.csv");
    }
    for (const spelling of [".env/", ".env/.", " .env", "./.env", ".env\n"]) {
      expect(workspacePathOf(spelling)).toBe(".env");
    }
    // Already in its one spelling: handed back as it is. A space or a backslash INSIDE a name is
    // a letter of that name to the computer, so it is one here.
    for (const kept of [
      "notes.md",
      "notes/2026 10/a b.md",
      "가게/매출 정리.csv",
      "private\\pay.csv",
      "a / b",
    ]) {
      expect(workspacePathOf(kept)).toBe(kept);
    }
    for (const whole of [".", "./", " . ", ".//."]) {
      expect(workspacePathOf(whole)).toBe(".");
    }
  });

  test("what the computer refuses as a path has none", () => {
    for (const refused of ["", "   ", "\n", ...NOT_A_PATH]) {
      expect(workspacePathOf(refused)).toBeNull();
    }
  });

  test("a name with white space at an edge keeps the one mark that makes it itself", () => {
    // To the computer these are a folder called " private" and a file called "pay.csv ": sent
    // without the `./` or the `/.`, it would trim them into the payroll's own path.
    for (const [written, spelling] of [
      ["./ private/pay.csv", "./ private/pay.csv"],
      [" .//./ private//pay.csv/ ", "./ private/pay.csv"],
      ["./\tprivate/pay.csv", "./\tprivate/pay.csv"],
      ["private/pay.csv /", "private/pay.csv /."],
      ["private/pay.csv /.", "private/pay.csv /."],
      [" private/pay.csv /", "private/pay.csv /."],
      // A part that is a space and a dot is a NAME to the computer, not the folder itself.
      ["./ ./ notes/a.md", "./ ./ notes/a.md"],
      ["./ /./ notes/a.md", "./ / notes/a.md"],
      ["./ /.", "./ /."],
    ] as const) {
      expect(workspacePathOf(written)).toBe(spelling);
    }
  });

  test("a spelling is its own spelling: reading it again changes nothing", () => {
    for (const written of EVERY_SPELLING) {
      const once = workspacePathOf(written);
      if (once !== null) expect(workspacePathOf(once)).toBe(once);
    }
  });

  test("the computer reads a spelling exactly as it reads what was written", async () => {
    // The whole claim, against the reader it is a claim about: for every string that has a
    // spelling, the real route gives the same answer — the same file, or the same refusal —
    // for the string as written and for its spelling.
    let compared = 0;
    for (const written of EVERY_SPELLING) {
      const spelling = workspacePathOf(written);
      if (spelling === null) continue;
      for (const route of [readRoute, listRoute] as Route[]) {
        const asWritten = await cameOf(() => through(route, { path: written }));
        const asSpelled = await cameOf(() =>
          through(route, { path: spelling }),
        );
        expect(`${written} → ${asSpelled}`).toBe(`${written} → ${asWritten}`);
        compared++;
      }
    }
    // A corpus that quietly became empty would pass everything above.
    expect(compared).toBeGreaterThan(600);
  });
});

/**
 * A rule about the payroll, and every file in the folder that the rule is about. A rule about a
 * NAME or an EXTENSION is about the file with a space at the edge of its name too: `describeFile`
 * reads a name trimmed, so a look-alike is judged as the name it would be read as.
 */
const RULES: readonly (readonly [rule: string, guarded: readonly string[]])[] =
  [
    ['matches(file.path, "^private/")', [PAYROLL, A_SPACED_NAME]],
    ['file.path == "private/pay.csv"', [PAYROLL]],
    ['file.name == "pay.csv"', [PAYROLL, IN_A_SPACED_FOLDER, A_SPACED_NAME]],
    ['file.extension == "csv"', [PAYROLL, IN_A_SPACED_FOLDER, A_SPACED_NAME]],
  ];

describe("a rule about a file holds however the path is written", () => {
  test("no spelling reads a file a rule denies, or hands it to a site", async () => {
    for (const [rule, guarded] of RULES) {
      const { gateway } = await gatewayUnder(allowingAllBut(rule));
      for (const path of EVERY_SPELLING) {
        const read = await cameOf(() =>
          gateway.readFile("default", "bot-1", ACTOR, { path }),
        );
        const upload = await cameOf(() =>
          gateway.uploadFile("default", "bot-1", ACTOR, { ...TARGET, path }),
        );
        for (const contents of guarded) {
          expect(`${rule} · ${JSON.stringify(path)} · ${read}`).not.toContain(
            contents,
          );
          expect(`${rule} · ${JSON.stringify(path)} · ${upload}`).not.toContain(
            contents,
          );
        }
      }
    }
  });

  test("no spelling writes over a file a rule denies", async () => {
    const guardedFiles = [
      [join("private", "pay.csv"), PAYROLL],
      [join(" private", "pay.csv"), IN_A_SPACED_FOLDER],
      [join("private", "pay.csv "), A_SPACED_NAME],
    ] as const;
    for (const [rule, guarded] of RULES) {
      // Each rule starts from the folder as it was: what one rule does not guard, the rule before
      // it was free to write over.
      for (const [file, contents] of guardedFiles) {
        await writeFile(join(root, file), contents);
      }
      const { gateway } = await gatewayUnder(allowingAllBut(rule));
      for (const path of EVERY_SPELLING) {
        await cameOf(() =>
          gateway.writeFile("default", "bot-1", ACTOR, {
            path,
            contents: "written over",
          }),
        );
        for (const [file, contents] of guardedFiles) {
          if (!guarded.includes(contents)) continue;
          expect(
            `${rule} · ${JSON.stringify(path)} · ${await readDisk(join(root, file), "utf8")}`,
          ).toBe(`${rule} · ${JSON.stringify(path)} · ${contents}`);
        }
      }
    }
  });

  test("a dotfile denied by name is not read as `.env/`", async () => {
    const { gateway } = await gatewayUnder(
      allowingAllBut('file.name == ".env"'),
    );
    for (const path of spellingsOf(".env")) {
      const read = await cameOf(() =>
        gateway.readFile("default", "bot-1", ACTOR, { path }),
      );
      expect(`${JSON.stringify(path)} · ${read}`).not.toContain(SECRET);
    }
  });

  test("a denied folder is not listed under any spelling of it", async () => {
    const { gateway } = await gatewayUnder(
      allowingAllBut('file.path == "private"'),
    );
    for (const path of spellingsOf("private")) {
      const listed = await cameOf(() =>
        gateway.listFiles("default", "bot-1", ACTOR, { path }),
      );
      // The denied folder's own listing names the payroll's path, to the letter; the folder
      // beside it whose name begins with a space is another folder, and is not denied.
      expect(listed.replace("listed: ", "").split(" | ")).not.toContain(
        "private/pay.csv",
      );
    }
  });

  test("the whole folder, denied, is not listed by a path that is blank or only looks like nothing", async () => {
    const { gateway, rows } = await gatewayUnder(
      allowingAllBut('file.path == "."'),
    );
    for (const path of [
      undefined,
      "",
      " ",
      "\n",
      ".",
      "./",
      " ./. ",
      "./ /.",
    ]) {
      const listed = await cameOf(() =>
        gateway.listFiles(
          "default",
          "bot-1",
          ACTOR,
          path === undefined ? {} : { path },
        ),
      );
      expect(`${JSON.stringify(path)} · ${listed}`).not.toContain("notes");
    }
    // And a blank path is on the trail as the folder it lists, not as no file at all.
    expect(
      rows
        .filter((row) => row.eventType === "computer.action_refused")
        .slice(0, 4)
        .map((row) => row.payload.file),
    ).toEqual([".", ".", ".", "."]);
  });

  test("the preset that asks about a write outside notes/ is never walked past: nothing lands outside it unasked", async () => {
    const policy: ActionPolicy = {
      deny: [],
      // As the boundaries screen offers it (`app/src/routes/_authed/admin/boundaries.tsx`).
      ask: ['intent == "write_file" && !matches(file.path, "^notes/")'],
      allow: ["true"],
    };
    const { gateway } = await gatewayUnder(policy);
    const everything = async (dir = root, under = ""): Promise<string[]> => {
      const found: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const at = `${under}${entry.name}`;
        if (entry.isDirectory()) {
          found.push(...(await everything(join(dir, entry.name), `${at}/`)));
        } else {
          found.push(at);
        }
      }
      return found;
    };
    const before = new Set(await everything());
    let unasked = 0;
    for (const path of [
      ...spellingsOf("notes/b.md"),
      ...spellingsOf(" notes/b.md"),
      ...spellingsOf("private/report.md"),
      ...spellingsOf("report.md"),
    ]) {
      const came = await gateway
        .writeFile("default", "bot-1", ACTOR, { path, contents: "x" })
        .then(
          () => "written",
          (error: unknown) =>
            error instanceof ActionNeedsApprovalError
              ? "asked"
              : (error as Error).message,
        );
      if (came === "written") unasked++;
    }
    // What was written without a question is inside `notes/`, to the letter — and something was,
    // or this would pass with every write asked about.
    const landed = (await everything()).filter((file) => !before.has(file));
    expect(landed.filter((file) => !file.startsWith("notes/"))).toEqual([]);
    expect(landed).toContain("notes/b.md");
    expect(unasked).toBeGreaterThan(10);
  });

  test("an allowance for one file is not spent on a write that lands beside it", async () => {
    // The second read's case: the preset, an allowance somebody gave for `private/report.md`, and
    // a path that is a folder called " private" to the computer. An allowance's scope trims its
    // path once more (`standing-approvals.ts`, `allowanceFor`), so a reading with a space at its
    // edge matched the allowance while the file landed elsewhere.
    const rule = 'intent == "write_file" && !matches(file.path, "^notes/")';
    const standing = createStandingApprovalStore();
    await standing.grant({
      botId: "bot-1",
      rule,
      scope: { kind: "file", value: "private/report.md" },
      subject: {
        kind: "file",
        intent: "write_file",
        file: { path: "private/report.md" },
        reason: "policy_ask",
      },
      grantedBy: "owner",
    });
    const { gateway } = await gatewayUnder(
      { deny: [], ask: [rule], allow: ["true"] },
      standing,
    );
    // The file the allowance names is written without a question, under its own spellings.
    for (const named of ["private/report.md", " ./private//report.md "]) {
      expect(
        await cameOf(() =>
          gateway.writeFile("default", "bot-1", ACTOR, {
            path: named,
            contents: "x",
          }),
        ),
      ).toBe("done");
    }
    for (const beside of [
      "./ ./ private/report.md",
      "./ private/report.md",
      "private/report.md /./ /",
      "private/report.md /.",
    ]) {
      await expect(
        gateway.writeFile("default", "bot-1", ACTOR, {
          path: beside,
          contents: "x",
        }),
      ).rejects.toThrow(ActionNeedsApprovalError);
    }
  });
});

describe("what was judged is what the computer is handed", () => {
  test("for every spelling, the row names the string the computer was sent", async () => {
    const { gateway, sent, rows } = await gatewayUnder(allowingAllBut());
    for (const path of EVERY_SPELLING) {
      await cameOf(() => gateway.readFile("default", "bot-1", ACTOR, { path }));
    }
    const judged = rows
      .filter((row) => row.eventType === "computer.action_allowed")
      .map((row) => row.payload.file);
    // One reading, made once: what a rule was asked about, what the row says, what was sent.
    expect(judged).toEqual(sent);
    expect(sent.length).toBe(EVERY_SPELLING.length);
  });

  test("an allowed act reaches the computer under the path's one spelling", async () => {
    const { gateway, sent, rows } = await gatewayUnder(allowingAllBut());
    await gateway.readFile("default", "bot-1", ACTOR, {
      path: " ./notes//a.md \n",
      offset: 0,
      limit: 10,
    });
    await gateway.writeFile("default", "bot-1", ACTOR, {
      path: "notes/b.md/.",
      contents: "x",
    });
    await gateway.listFiles("default", "bot-1", ACTOR, { path: "notes/" });
    await gateway.uploadFile("default", "bot-1", ACTOR, {
      ...TARGET,
      path: "./notes/a.md ",
    });
    await gateway.listFiles("default", "bot-1", ACTOR, {});
    expect(sent).toEqual([
      "notes/a.md",
      "notes/b.md",
      "notes",
      "notes/a.md",
      "(no path)",
    ]);
    expect(rows.map((row) => row.payload.file)).toEqual([
      "notes/a.md",
      "notes/b.md",
      "notes",
      "notes/a.md",
      ".",
    ]);
  });

  test("what is no path at all goes on as it was written, and the trail has the attempt", async () => {
    for (const path of NOT_A_PATH) {
      const { gateway, sent, rows } = await gatewayUnder(allowingAllBut());
      expect(
        await cameOf(() =>
          gateway.readFile("default", "bot-1", ACTOR, { path }),
        ),
      ).toBe("laf:file_path_refused");
      expect(sent).toEqual([path]);
      // Allowed, and then it did not happen: the two rows an attempt on `../../etc/passwd` always
      // left. Refusing it here before a row would take the attempt off the trail.
      expect(rows.map((row) => row.eventType)).toEqual([
        "computer.action_allowed",
        "computer.action_failed",
      ]);
      expect(rows[1]?.payload.failure).toBe("laf:file_path_refused");
    }
  });
});

describe("the person's own door", () => {
  test("a file somebody downloads is on the trail under the name every other row about it has", async () => {
    // Nothing is decided here; the row is found by the file's path, and a Bot's rows about the
    // same file carry its one spelling.
    const { gateway, sent, rows } = await gatewayUnder(allowingAllBut());
    const handed = await gateway.downloadFile(
      "default",
      "bot-1",
      ACTOR,
      " ./notes//a.md ",
    );
    expect(new TextDecoder().decode(handed.bytes)).toBe(NOTE);
    expect(handed.name).toBe("a.md");
    expect(sent).toEqual(["notes/a.md"]);
    expect(rows.map((row) => [row.eventType, row.payload.file])).toEqual([
      ["computer.file_downloaded", "notes/a.md"],
    ]);
  });
});

describe("a routine's door", () => {
  test("a routine that adds a space does not write over a denied file, or list a denied folder by a blank", async () => {
    const { gateway } = await gatewayUnder(
      allowingAllBut('file.name == "pay.csv"', 'file.path == "."'),
    );
    const toolkit = await createUnattendedTools({ gateway })("bot-1", ACTOR);
    // This door hands a model's `path` on as it was written (`runner/unattended.ts`); the chat's
    // trims first. Neither has to remember.
    const written = await toolkit.execute("computer_write_file", {
      path: "private/pay.csv ",
      contents: "written over by a routine",
    });
    const listed = await toolkit.execute("computer_list_files", { path: "" });
    expect(written).toMatchObject({ ok: false, code: "laf:policy_denied" });
    expect(listed).toMatchObject({ ok: false, code: "laf:policy_denied" });
    expect(await readDisk(join(root, "private", "pay.csv"), "utf8")).toBe(
      PAYROLL,
    );
  });
});
