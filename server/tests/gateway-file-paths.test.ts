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
import { DEFAULT_ACTION_POLICY } from "../src/computer/default-policy";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import {
  hasNoOneReading,
  workspacePathOf,
} from "../src/computer/gateway/addresses";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { createUnattendedTools } from "../src/runner/unattended";
import {
  A_SPACED_NAME,
  EVERY_SPELLING,
  FILES,
  NOT_A_PATH,
  NOTE,
  PAYROLL,
  RULES,
  SECRET,
  spellingsOf,
} from "./support/path-spellings";

/**
 * WHAT A RULE JUDGES IS WHAT THE COMPUTER ACTS ON (`gateway/addresses.ts`, `workspacePathOf`).
 *
 * The computer trims a path and resolves it, so one file has many spellings; a rule was asked about
 * whichever one a model wrote. An independent read of the script act (2026-10-07) walked a deny on
 * a file past with a trailing space, and the same was true of the Bot's own file tools.
 *
 * EVERY TEST HERE IS IN FRONT OF THE REAL WORKSPACE, reached through the computer's own route
 * handlers with the body the server's client posts — and what is asserted is what happened: which
 * file was read, what is on the disk. The first version of this file used a computer that echoed
 * what it was sent and asserted on strings; a second independent read found a spelling for which
 * the fix's own answer was a DIFFERENT file to the computer, deleted the line in `govern` that
 * reads the path, and watched all twelve tests pass. A third found that the computer reads a
 * backslash as a separator and writes it as a letter, which no test here knew. So: no fake that
 * echoes, every file with contents of its own, and spellings by the thousand rather than by
 * example.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [{ ref: "e9", role: "button", name: "Submit order" }],
};
const ACTOR = { id: "dev-local-user" };
const OWNER = "owner-user";
/** The control an upload names: the snapshot's button, at the snapshot the server holds. */
const TARGET = { ref: "e9", snapshotId: SNAPSHOT.snapshotId };

let root = "";
let workspace: Workspace;
async function folderAsItWas() {
  for (const [file, contents] of FILES) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), contents);
  }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "laf-one-spelling-"));
  await folderAsItWas();
  workspace = createWorkspace(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file under the folder, by its path from the folder's top. */
async function everything(dir = root, under = ""): Promise<string[]> {
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
}

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
  const approvals = createApprovalRegistry();
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => policy,
    approvals,
    standing,
  });
  // An upload names a control, so the server holds a snapshot first, as the real flow does.
  await gateway.snapshot("default");
  return { gateway, approvals, sent, rows };
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
    if (error instanceof ActionNeedsApprovalError) return "asked";
    return error instanceof Error ? error.message : String(error);
  }
}

describe("a path in the Bot's folder has one spelling", () => {
  test("the ends are trimmed, and `.`, empty segments and a trailing slash are gone", () => {
    for (const spelling of [
      "private/pay.csv ",
      " private/pay.csv",
      "private/pay.csv\n",
      "\u00a0private/pay.csv\u3000",
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
    // Already in its one spelling: handed back as it is, a space INSIDE the path included.
    for (const kept of [
      "notes.md",
      "notes/2026 10/a b.md",
      "가게/매출 정리.csv",
      "a/ b /c",
    ]) {
      expect(workspacePathOf(kept)).toBe(kept);
      expect(hasNoOneReading(kept)).toBe(false);
    }
    for (const whole of [".", "./", " . ", ".//."]) {
      expect(workspacePathOf(whole)).toBe(".");
    }
  });

  test("what the computer refuses as a path has none, and is not what the gateway refuses", () => {
    for (const refused of ["", "   ", "\n", ...NOT_A_PATH]) {
      expect(workspacePathOf(refused)).toBeNull();
      expect(hasNoOneReading(refused)).toBe(false);
    }
  });

  test("a backslash, or white space at the edge of a first or last name, has no one reading", () => {
    for (const two of [
      // The computer reads a backslash as a separator and writes it as a letter.
      "private\\pay.csv",
      "\\private/pay.csv",
      "private/pay.csv\\",
      "\\",
      // To the computer: a folder called " private", a file called "pay.csv ".
      "./ private/pay.csv",
      "./\tprivate/pay.csv",
      "./\nprivate/pay.csv",
      "./\u3000private/pay.csv",
      "private/pay.csv /",
      "private/pay.csv /.",
      " private/pay.csv /",
      "./ ./ notes/a.md",
      "./ /.",
    ]) {
      expect(hasNoOneReading(two)).toBe(true);
      expect(workspacePathOf(two)).toBeNull();
    }
  });

  test("white space on the inner side of a first or last name is a letter of that name", () => {
    // The lower bound of what is refused. Only the OUTER edges are what the computer trims away
    // once a mark is gone; `"a /b"` is a folder called `"a "`, written and read as that.
    for (const honest of [
      "a /b",
      "a/ b",
      "a /c/ b",
      "notes /a.md",
      "notes/ a.md",
      "reports / 2026.md",
    ]) {
      expect(hasNoOneReading(honest)).toBe(false);
      expect(workspacePathOf(honest)).toBe(honest);
    }
  });

  test("a spelling is its own spelling: reading it again changes nothing", () => {
    for (const written of EVERY_SPELLING) {
      const once = workspacePathOf(written);
      if (once === null) continue;
      expect(workspacePathOf(once)).toBe(once);
      expect(hasNoOneReading(once)).toBe(false);
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

  test("the computer refuses a backslash itself, so a spelling it never sees is one it would not read", async () => {
    // The root of the third read's finding, closed where it is: `resolvePath` read a backslash as
    // a separator through `realpath` and wrote it as a letter.
    for (const path of [
      "private\\pay.csv",
      "\\private/pay.csv",
      "private/pay.csv\\",
      "\\",
    ]) {
      for (const route of [readRoute, listRoute] as Route[]) {
        expect(await cameOf(() => through(route, { path }))).toBe(
          "laf:file_path_refused",
        );
      }
      expect(
        await cameOf(() =>
          through(writeRoute as Route, { path, contents: "x" }),
        ),
      ).toBe("laf:file_path_refused");
    }
  });
});

describe("a rule about a file holds however the path is written", () => {
  test("no spelling reads a file a rule denies, or hands it to a site", async () => {
    for (const rule of RULES) {
      const { gateway } = await gatewayUnder(allowingAllBut(rule));
      for (const path of EVERY_SPELLING) {
        const read = await cameOf(() =>
          gateway.readFile("default", "bot-1", ACTOR, { path }),
        );
        const upload = await cameOf(() =>
          gateway.uploadFile("default", "bot-1", ACTOR, { ...TARGET, path }),
        );
        expect(`${rule} · ${JSON.stringify(path)} · ${read}`).not.toContain(
          PAYROLL,
        );
        expect(`${rule} · ${JSON.stringify(path)} · ${upload}`).not.toContain(
          PAYROLL,
        );
      }
    }
  });

  test("no spelling writes over a file a rule denies", async () => {
    for (const rule of RULES) {
      // Each rule starts from the folder as it was.
      await folderAsItWas();
      const { gateway } = await gatewayUnder(allowingAllBut(rule));
      for (const path of EVERY_SPELLING) {
        await cameOf(() =>
          gateway.writeFile("default", "bot-1", ACTOR, {
            path,
            contents: "written over",
          }),
        );
        expect(
          `${rule} · ${JSON.stringify(path)} · ${await readDisk(join(root, "private", "pay.csv"), "utf8")}`,
        ).toBe(`${rule} · ${JSON.stringify(path)} · ${PAYROLL}`);
      }
    }
  });

  test("a path with no one reading is refused with a row and never sent, whatever the policy allows", async () => {
    const { gateway, sent, rows } = await gatewayUnder(allowingAllBut());
    const before = await everything();
    let refused = 0;
    for (const path of EVERY_SPELLING.filter(hasNoOneReading)) {
      for (const came of [
        await cameOf(() =>
          gateway.readFile("default", "bot-1", ACTOR, { path }),
        ),
        await cameOf(() =>
          gateway.writeFile("default", "bot-1", ACTOR, { path, contents: "x" }),
        ),
        await cameOf(() =>
          gateway.listFiles("default", "bot-1", ACTOR, { path }),
        ),
        await cameOf(() =>
          gateway.uploadFile("default", "bot-1", ACTOR, { ...TARGET, path }),
        ),
      ]) {
        expect(`${JSON.stringify(path)} · ${came}`).toBe(
          `${JSON.stringify(path)} · laf:file_path_refused`,
        );
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(1000);
    // Nothing reached the computer, nothing changed on the disk, and every attempt has its row:
    // a refusal, by the fact, under the string as it was written — there is no other to give it.
    expect(sent).toEqual([]);
    expect(await everything()).toEqual(before);
    const refusals = rows.filter(
      (row) => row.eventType === "computer.action_refused",
    );
    expect(refusals.length).toBe(refused);
    expect(
      new Set(
        refusals.map((row) => (row.payload.decision as { code?: string }).code),
      ),
    ).toEqual(new Set(["laf:file_path_refused"]));
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

  test("a denied folder is not listed, whether the rule names the folder or what is under it", async () => {
    for (const rule of [
      'file.path == "private"',
      'matches(file.path, "^private/")',
    ]) {
      const { gateway } = await gatewayUnder(allowingAllBut(rule));
      for (const path of spellingsOf("private")) {
        const listed = await cameOf(() =>
          gateway.listFiles("default", "bot-1", ACTOR, { path }),
        );
        // The denied folder's own listing names the payroll's path, to the letter.
        expect(
          `${rule} · ${JSON.stringify(path)} · ${listed.replace("listed: ", "").split(" | ").includes("private/pay.csv")}`,
        ).toBe(`${rule} · ${JSON.stringify(path)} · false`);
      }
    }
  });

  test("a folder's two names are two chances for a rule, in the policy's own order — an allow among them", async () => {
    const listing = async (policy: ActionPolicy, path: string) => {
      const { gateway } = await gatewayUnder(policy);
      return cameOf(() =>
        gateway.listFiles("default", "bot-1", ACTOR, { path }),
      );
    };
    const THE_FOLDER = 'file.path == "notes"';
    const WHAT_IS_UNDER_IT = 'matches(file.path, "^notes/")';
    /*
     * A policy that allows nothing but the notes folder, named either way. "No rule allows it"
     * under one name is the absence of a rule; it was weighed like a deny for two commits, and
     * the folder somebody had allowed was refused under every spelling of it.
     */
    for (const allow of [THE_FOLDER, WHAT_IS_UNDER_IT]) {
      const only: ActionPolicy = { deny: [], ask: [], allow: [allow] };
      for (const path of ["notes", "notes/", " ./notes/. "]) {
        expect(
          `${allow} · ${JSON.stringify(path)} · ${await listing(only, path)}`,
        ).toBe(`${allow} · ${JSON.stringify(path)} · listed: notes/a.md`);
      }
      // And the folder beside it is still one no rule allows.
      expect(await listing(only, "private")).toBe("laf:no_rule_allows");
    }
    // A question under one name comes before an allow under the other, and a deny before both.
    for (const [first, second] of [
      [THE_FOLDER, WHAT_IS_UNDER_IT],
      [WHAT_IS_UNDER_IT, THE_FOLDER],
    ] as const) {
      expect(
        await listing({ deny: [], ask: [first], allow: [second] }, "notes"),
      ).toBe("asked");
      expect(
        await listing(
          { deny: [first], ask: [second], allow: ["true"] },
          "notes",
        ),
      ).toBe("laf:policy_denied");
    }
  });

  test("the folder's other name is the same folder: it keeps the folder's own name", async () => {
    // On main `private/` had no name at all, so "everything not called private" matched it and
    // the folder was listed by its slash name (the third read's mutation R13 brings that back).
    const { gateway } = await gatewayUnder({
      deny: [],
      ask: [],
      allow: ['file.name != "private"'],
    });
    for (const path of ["private", "private/", "./private/", "private/."]) {
      const listed = await cameOf(() =>
        gateway.listFiles("default", "bot-1", ACTOR, { path }),
      );
      expect(`${JSON.stringify(path)} · ${listed}`).toBe(
        `${JSON.stringify(path)} · laf:no_rule_allows`,
      );
    }
    expect(
      await cameOf(() =>
        gateway.listFiles("default", "bot-1", ACTOR, { path: "notes/" }),
      ),
    ).toBe("listed: notes/a.md");
  });

  test("only a listing has two names: a file called `notes` is not under notes/", async () => {
    const { gateway } = await gatewayUnder({
      deny: [],
      ask: [],
      allow: ['matches(file.path, "^notes/")'],
    });
    await rm(join(root, "notes"), { recursive: true, force: true });
    const before = await everything();
    expect(
      await cameOf(() =>
        gateway.writeFile("default", "bot-1", ACTOR, {
          path: "notes",
          contents: "a FILE called notes, at the top",
        }),
      ),
    ).toBe("laf:no_rule_allows");
    expect(
      await cameOf(() =>
        gateway.readFile("default", "bot-1", ACTOR, { path: ".env/" }),
      ),
    ).toBe("laf:no_rule_allows");
    expect(await everything()).toEqual(before);
  });

  test("the whole folder has one name, and where both names ask, the name that was asked for is the question", async () => {
    // `./` is nobody's name for the folder: a rule written against it does not stop its listing.
    const whole = await gatewayUnder(allowingAllBut('file.path == "./"'));
    expect(
      await cameOf(() =>
        whole.gateway.listFiles("default", "bot-1", ACTOR, { path: "." }),
      ),
    ).toContain("listed: ");
    // Two rules that ask, one per name. The rule on the question is the one an allowance is
    // granted under, so it is the one about the name the folder was asked for by.
    const THE_FOLDER = 'file.path == "notes"';
    const { gateway } = await gatewayUnder({
      deny: [],
      ask: [THE_FOLDER, 'matches(file.path, "^notes/")'],
      allow: ["true"],
    });
    const asked = (await gateway
      .listFiles("default", "bot-1", ACTOR, { path: "notes" })
      .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
    expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
    expect(asked.rule).toBe(THE_FOLDER);
  });

  test("a cost, kept on purpose: a folder whose name ends in white space is not listed by its own name", async () => {
    /*
     * `"reports / 2026.md"` has one reading and is written — into a folder called `"reports "`.
     * That folder's own path ends in white space, which the computer reads only behind a mark
     * (`"reports /"`), so a Bot cannot name it; main listed it by the mark. What it holds is
     * still read by its full path, and the whole folder's listing still shows it.
     */
    const { gateway } = await gatewayUnder(allowingAllBut());
    const file = "reports / 2026.md";
    await gateway.writeFile("default", "bot-1", ACTOR, {
      path: file,
      contents: "[a report]",
    });
    expect(
      await cameOf(() =>
        gateway.readFile("default", "bot-1", ACTOR, { path: file }),
      ),
    ).toBe("read: [a report]");
    for (const path of ["reports /", "reports /.", "./reports /"]) {
      expect(
        await cameOf(() =>
          gateway.listFiles("default", "bot-1", ACTOR, { path }),
        ),
      ).toBe("laf:file_path_refused");
    }
    expect(
      await cameOf(() => gateway.listFiles("default", "bot-1", ACTOR, {})),
    ).toContain(file);
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

  // By a SPELLING. By letter case it is walked past — `matches` ignores case and a VM's disk does
  // not, so `Notes/x.md` lands unasked. That is the rule's own fault and the pull request after
  // this one; nothing here tries it.
  test("the preset that asks about a write outside notes/ is not walked past by a spelling: nothing lands outside it unasked", async () => {
    const policy: ActionPolicy = {
      deny: [],
      // As the boundaries screen offers it (`app/src/routes/_authed/admin/boundaries.tsx`).
      ask: ['intent == "write_file" && !matches(file.path, "^notes/")'],
      allow: ["true"],
    };
    const { gateway } = await gatewayUnder(policy);
    const before = new Set(await everything());
    let unasked = 0;
    for (const path of [
      ...spellingsOf("notes/b.md"),
      ...spellingsOf(" notes/b.md"),
      ...spellingsOf("private/report.md"),
      ...spellingsOf("report.md"),
    ]) {
      const came = await cameOf(() =>
        gateway.writeFile("default", "bot-1", ACTOR, { path, contents: "x" }),
      );
      if (came === "done") unasked++;
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
    // path once more (`standing-approvals.ts`, `allowanceFor`).
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
      grantedBy: OWNER,
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
    const before = await everything();
    for (const beside of [
      "./ ./ private/report.md",
      "./ private/report.md",
      "private/report.md /./ /",
      "private/report.md /.",
      "private\\report.md",
    ]) {
      const came = await cameOf(() =>
        gateway.writeFile("default", "bot-1", ACTOR, {
          path: beside,
          contents: "x",
        }),
      );
      expect(`${JSON.stringify(beside)} · ${came}`).not.toContain("done");
    }
    expect(await everything()).toEqual(before);
  });
});

describe("everything about one file is about its one spelling", () => {
  test("the same file under five spellings is the same call five times, and the shipped policy asks", async () => {
    // The shipped policy has one rule a file's path reaches: the same call again
    // (`repeat.count >= 5`). On main, five spellings of one file were five different calls.
    const { gateway } = await gatewayUnder(DEFAULT_ACTION_POLICY);
    const came: string[] = [];
    for (const path of [
      "notes/a.md",
      " notes/a.md",
      "./notes/a.md",
      "notes//a.md",
      "notes/a.md/.",
    ]) {
      came.push(
        await cameOf(() =>
          gateway.readFile("default", "bot-1", ACTOR, { path }),
        ),
      );
    }
    expect(came).toEqual([
      `read: ${NOTE}`,
      `read: ${NOTE}`,
      `read: ${NOTE}`,
      `read: ${NOTE}`,
      "asked",
    ]);
  });

  test("a person's yes for a file is found under another spelling of it, and a no stands under every one", async () => {
    const policy: ActionPolicy = {
      deny: [],
      ask: ['file.name == "a.md"'],
      allow: ["true"],
    };
    {
      const { gateway, approvals, rows } = await gatewayUnder(policy);
      const asked = (await gateway
        .readFile("default", "bot-1", ACTOR, { path: "./notes/a.md" })
        .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
      expect(asked).toBeInstanceOf(ActionNeedsApprovalError);
      // The question is about the file's one name, whatever was written.
      const subject = rows[0]?.payload.subject as
        | { file?: { path?: string } }
        | undefined;
      expect(subject?.file?.path).toBe("notes/a.md");
      await approvals.answer(asked.approvalId, "bot-1", OWNER, true);
      expect(
        await cameOf(() =>
          gateway.readFile(
            "default",
            "bot-1",
            ACTOR,
            { path: " notes//a.md " },
            asked.approvalId,
          ),
        ),
      ).toBe(`read: ${NOTE}`);
    }
    {
      const { gateway, approvals } = await gatewayUnder(policy);
      const asked = (await gateway
        .readFile("default", "bot-1", ACTOR, { path: "notes/a.md" })
        .catch((caught: unknown) => caught)) as ActionNeedsApprovalError;
      await approvals.answer(asked.approvalId, "bot-1", OWNER, false);
      for (const path of ["notes/a.md", "./notes/a.md", "notes/a.md/. "]) {
        const refused = await gateway
          .readFile("default", "bot-1", ACTOR, { path })
          .catch((caught: unknown) => caught);
        expect(refused).toBeInstanceOf(ActionRefusedError);
        expect((refused as ActionRefusedError).code).toBe(
          "laf:declined_recently",
        );
      }
    }
  });

  test("a refusal's row names the file's one spelling", async () => {
    const { gateway, rows } = await gatewayUnder(
      allowingAllBut('file.name == "pay.csv"'),
    );
    for (const path of ["private/pay.csv ", "./private//pay.csv/."]) {
      await cameOf(() => gateway.readFile("default", "bot-1", ACTOR, { path }));
    }
    expect(rows.map((row) => [row.eventType, row.payload.file])).toEqual([
      ["computer.action_refused", "private/pay.csv"],
      ["computer.action_refused", "private/pay.csv"],
    ]);
  });

  test("the rows of an act that was allowed and then failed name the one spelling too", async () => {
    const { gateway, rows } = await gatewayUnder(allowingAllBut());
    expect(
      await cameOf(() =>
        gateway.readFile("default", "bot-1", ACTOR, {
          path: " ./nothing//here.md/ ",
        }),
      ),
    ).toBe("laf:file_not_found");
    expect(rows.map((row) => [row.eventType, row.payload.file])).toEqual([
      ["computer.action_allowed", "nothing/here.md"],
      ["computer.action_failed", "nothing/here.md"],
    ]);
  });

  test("the row that says a person was asked names the one spelling", async () => {
    const { gateway, rows } = await gatewayUnder({
      deny: [],
      ask: ['file.name == "a.md"'],
      allow: ["true"],
    });
    expect(
      await cameOf(() =>
        gateway.readFile("default", "bot-1", ACTOR, { path: "./notes//a.md " }),
      ),
    ).toBe("asked");
    expect(
      rows
        .filter((row) => row.eventType === "approval.requested")
        .map((row) => row.payload.file),
    ).toEqual(["notes/a.md"]);
  });

  test("for every spelling that is sent, the row names the string the computer was sent", async () => {
    const { gateway, sent, rows } = await gatewayUnder(allowingAllBut());
    for (const path of EVERY_SPELLING) {
      await cameOf(() => gateway.readFile("default", "bot-1", ACTOR, { path }));
    }
    const judged = rows
      .filter((row) => row.eventType === "computer.action_allowed")
      .map((row) => row.payload.file ?? "");
    // One reading, made once: what a rule was asked about, what the row says, what was sent.
    expect(judged).toEqual(sent);
    expect(sent.length).toBeGreaterThan(300);
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

  // In front of a store that takes any string. `jsonb` itself refuses a NUL and half an emoji,
  // so on the real trail an attempt whose path holds one throws at the insert: nothing is sent
  // and nothing is kept. True before this change, and not put right by it.
  test("what the computer refuses as a path goes on as it was written, and a store that takes the row has the attempt", async () => {
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

  test("a person's door hands a path on as it was written: behind a mark it reaches a file a Bot cannot name", async () => {
    const { gateway, rows } = await gatewayUnder(allowingAllBut());
    const marked = await gateway.downloadFile(
      "default",
      "bot-1",
      ACTOR,
      "private/pay.csv /.",
    );
    expect(new TextDecoder().decode(marked.bytes)).toBe(A_SPACED_NAME);
    // And by its plain name it reaches the NEIGHBOUR, as it always did — the computer trims —
    // with a row that names the file that was handed over, not the one that was meant.
    const plain = await gateway.downloadFile(
      "default",
      "bot-1",
      ACTOR,
      "private/pay.csv ",
    );
    expect(new TextDecoder().decode(plain.bytes)).toBe(PAYROLL);
    expect(rows.at(-1)?.payload.file).toBe("private/pay.csv");
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
    const backslash = await toolkit.execute("computer_read_file", {
      path: "private\\pay.csv",
    });
    expect(written).toMatchObject({ ok: false, code: "laf:policy_denied" });
    expect(listed).toMatchObject({ ok: false, code: "laf:policy_denied" });
    expect(backslash).toMatchObject({
      ok: false,
      code: "laf:file_path_refused",
    });
    expect(await readDisk(join(root, "private", "pay.csv"), "utf8")).toBe(
      PAYROLL,
    );
  });
});
