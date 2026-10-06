import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspace,
  WorkspacePathError,
} from "../../agent-computer/src/workspace";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createApprovalRegistry } from "../src/computer/approvals";
import type { ComputerClient } from "../src/computer/client";
import {
  ActionNeedsApprovalError,
  ActionRefusedError,
  createComputerGateway,
} from "../src/computer/gateway";
import { workspacePathOf } from "../src/computer/gateway/addresses";
import type { ActionPolicy } from "../src/computer/policy";
import type { SnapshotResult } from "../src/computer/schema";
import { createStandingApprovalStore } from "../src/computer/standing-approvals";
import { createUnattendedTools } from "../src/runner/unattended";

/**
 * WHAT A RULE JUDGES IS WHAT THE COMPUTER IS GIVEN (`gateway/addresses.ts`, `workspacePathOf`).
 *
 * The computer trims a path and resolves it, so one file has many spellings; a rule was asked about
 * whichever one a model wrote. An independent read of the script act (2026-10-07) walked a deny on
 * a file past with a trailing space, and the same was true of the Bot's own file tools: through a
 * routine's door with a space, and through every door with `./`, `//`, a trailing slash or `/.`.
 *
 * Held three ways, because each alone can be green while the fault is there: the spelling as a
 * table; the spelling against the REAL workspace, which is the reader it has to agree with; and
 * the gateway with a rule in force, asked through each act and through a routine's own door, where
 * what counts is that the computer was never asked.
 */

/** Every one of these is `private/pay.csv` to the computer. */
const ONE_FILE = [
  "private/pay.csv ",
  " private/pay.csv",
  "private/pay.csv\n",
  "\tprivate/pay.csv",
  " private/pay.csv　",
  "./private/pay.csv",
  "private/./pay.csv",
  "private//pay.csv",
  "private/pay.csv/",
  "private/pay.csv/.",
  ".//private///pay.csv/./",
] as const;

/** Every one of these is the dotfile at the top of the folder. */
const ONE_DOTFILE = [".env/", ".env/.", " .env", "./.env", ".env\n"] as const;

/** None of these is a path in the folder: each is something the computer refuses as one. */
const NOT_A_PATH = [
  "",
  "   ",
  "\n",
  "/etc/passwd",
  "..",
  "a/../b",
  "private/../../etc/passwd",
  "a\0b",
] as const;

describe("a path in the Bot's folder has one spelling", () => {
  test("the ends are trimmed, and `.`, empty segments and a trailing slash are gone", () => {
    for (const spelling of ONE_FILE) {
      expect(workspacePathOf(spelling)).toBe("private/pay.csv");
    }
    for (const spelling of ONE_DOTFILE) {
      expect(workspacePathOf(spelling)).toBe(".env");
    }
    // Already in its one spelling: handed back as it is. A space or a backslash INSIDE a name is
    // a letter of that name to the computer, so it is one here: nothing stricter than its reading.
    for (const kept of [
      "notes.md",
      "notes/2026 10/a b.md",
      "가게/매출 정리.csv",
      "private\\pay.csv",
    ]) {
      expect(workspacePathOf(kept)).toBe(kept);
    }
    // The folder itself, however it is written.
    for (const whole of [".", "./", " . ", ".//."]) {
      expect(workspacePathOf(whole)).toBe(".");
    }
  });

  test("what is not a path there has none", () => {
    for (const refused of NOT_A_PATH) {
      expect(workspacePathOf(refused)).toBeNull();
    }
  });
});

describe("the spelling agrees with the computer's own reading of a path", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "laf-one-spelling-"));
    await mkdir(join(root, "private"), { recursive: true });
    await writeFile(join(root, "private", "pay.csv"), "the payroll");
    await writeFile(join(root, ".env"), "the secret");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("every spelling the computer reads as one file is spelled as that file here", async () => {
    const workspace = createWorkspace(root);
    for (const [spellings, text] of [
      [ONE_FILE, "the payroll"],
      [ONE_DOTFILE, "the secret"],
    ] as const) {
      for (const spelling of spellings) {
        const one = workspacePathOf(spelling);
        expect(one).not.toBeNull();
        // The computer reads the path as a model wrote it, and reads the same file as when it is
        // handed the one spelling: this is the many-to-one the gateway has to undo before a rule.
        expect((await workspace.read(spelling)).text).toBe(text);
        expect((await workspace.read(one ?? "")).text).toBe(text);
      }
    }
  });

  test("what has no spelling here is what the computer refuses as a path", async () => {
    const workspace = createWorkspace(root);
    for (const refused of NOT_A_PATH) {
      await expect(workspace.read(refused)).rejects.toBeInstanceOf(
        WorkspacePathError,
      );
    }
  });
});

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e1", role: "input", name: "Customer name:", type: "text" },
    { ref: "e9", role: "button", name: "Submit order" },
  ],
};

/** A computer that writes down the path each act handed it. */
function recordingComputer() {
  const asked: string[] = [];
  const client = {
    snapshot: async () => SNAPSHOT,
    status: async () => ({ botId: "b", state: "ready" as const }),
    readFile: async (input: { path: string }) => {
      asked.push(`read ${input.path}`);
      return { path: input.path, text: "", truncated: false, bytes: 0 };
    },
    writeFile: async (input: { path: string }) => {
      asked.push(`write ${input.path}`);
      return { path: input.path, bytes: 1, appended: false };
    },
    listFiles: async (input: { path?: string }) => {
      asked.push(`list ${input.path ?? "(no path)"}`);
      return { path: input.path ?? ".", entries: [], truncated: false };
    },
    uploadFile: async (input: { path: string; ref: string }) => {
      asked.push(`upload ${input.path}`);
      return {
        action: "upload_file",
        ref: input.ref,
        path: input.path,
        url: SNAPSHOT.url,
        elapsedMs: 1,
      };
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  return { client, asked };
}

const ACTOR = { id: "dev-local-user" };
/** The control an upload names: the snapshot's button, at the snapshot the server holds. */
const TARGET = { ref: "e9", snapshotId: SNAPSHOT.snapshotId };
const allowingAllBut = (...deny: string[]): ActionPolicy => ({
  deny,
  ask: [],
  allow: ["true"],
});

async function gatewayWith(policy: ActionPolicy) {
  const { client, asked } = recordingComputer();
  const rows: AuditEventInput[] = [];
  const auditStore: AuditStore = {
    insert: async (event) => void rows.push(event),
  };
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => policy,
    approvals: createApprovalRegistry(),
    standing: createStandingApprovalStore(),
  });
  // An upload names a control, so the server holds a snapshot first, as the real flow does.
  await gateway.snapshot("default");
  return { gateway, asked, rows };
}

/** The four ways a rule about `private/pay.csv` gets written. */
const RULES_ABOUT_THE_FILE = [
  'matches(file.path, "^private/")',
  'file.path == "private/pay.csv"',
  'file.name == "pay.csv"',
  'file.extension == "csv"',
] as const;

describe("a rule about a file holds however the path is written", () => {
  test("a denied file is not read, written or handed to a site under any spelling of it", async () => {
    for (const rule of RULES_ABOUT_THE_FILE) {
      for (const path of ["private/pay.csv", ...ONE_FILE]) {
        const { gateway, asked, rows } = await gatewayWith(
          allowingAllBut(rule),
        );
        await expect(
          gateway.readFile("default", "bot-1", ACTOR, { path }),
        ).rejects.toThrow(ActionRefusedError);
        await expect(
          gateway.writeFile("default", "bot-1", ACTOR, { path, contents: "x" }),
        ).rejects.toThrow(ActionRefusedError);
        await expect(
          gateway.uploadFile("default", "bot-1", ACTOR, { ...TARGET, path }),
        ).rejects.toThrow(ActionRefusedError);
        // The property: nothing reached the computer.
        expect(asked).toEqual([]);
        // And each refusal is on the trail under the file's one name, not under what was written.
        expect(rows.map((row) => row.eventType)).toEqual([
          "computer.action_refused",
          "computer.action_refused",
          "computer.action_refused",
        ]);
        expect(rows.map((row) => row.payload.file)).toEqual([
          "private/pay.csv",
          "private/pay.csv",
          "private/pay.csv",
        ]);
      }
    }
  });

  test("a dotfile denied by name is not read as `.env/`", async () => {
    for (const path of [".env", ...ONE_DOTFILE]) {
      const { gateway, asked } = await gatewayWith(
        allowingAllBut('file.name == ".env"'),
      );
      await expect(
        gateway.readFile("default", "bot-1", ACTOR, { path }),
      ).rejects.toThrow(ActionRefusedError);
      expect(asked).toEqual([]);
    }
  });

  test("a denied folder is not listed under any spelling of it", async () => {
    for (const path of [
      "private",
      " private",
      "private ",
      "./private",
      "private/",
      "private/.",
    ]) {
      const { gateway, asked, rows } = await gatewayWith(
        allowingAllBut('file.path == "private"'),
      );
      await expect(
        gateway.listFiles("default", "bot-1", ACTOR, { path }),
      ).rejects.toThrow(ActionRefusedError);
      expect(asked).toEqual([]);
      expect(rows[0]?.payload.file).toBe("private");
    }
  });

  test("the preset that asks about a write outside notes/ is not asked inside it, and is outside", async () => {
    const policy: ActionPolicy = {
      deny: [],
      // As the boundaries screen offers it (`app/src/routes/_authed/admin/boundaries.tsx`).
      ask: ['intent == "write_file" && !matches(file.path, "^notes/")'],
      allow: ["true"],
    };
    for (const inside of ["notes/a.md", " notes/a.md", "./notes/a.md\n"]) {
      const { gateway, asked } = await gatewayWith(policy);
      await gateway.writeFile("default", "bot-1", ACTOR, {
        path: inside,
        contents: "x",
      });
      expect(asked).toEqual(["write notes/a.md"]);
    }
    for (const outside of [
      "private/a.md",
      "./private/a.md",
      " private/a.md ",
    ]) {
      const { gateway, asked } = await gatewayWith(policy);
      await expect(
        gateway.writeFile("default", "bot-1", ACTOR, {
          path: outside,
          contents: "x",
        }),
      ).rejects.toThrow(ActionNeedsApprovalError);
      expect(asked).toEqual([]);
    }
  });
});

describe("what was judged is what the computer is handed", () => {
  test("an allowed act reaches the computer under the path's one spelling, and the row says the same", async () => {
    const { gateway, asked, rows } = await gatewayWith(allowingAllBut());
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
      path: "./notes/c.pdf ",
    });
    expect(asked).toEqual([
      "read notes/a.md",
      "write notes/b.md",
      "list notes",
      "upload notes/c.pdf",
    ]);
    expect(rows.map((row) => row.payload.file)).toEqual([
      "notes/a.md",
      "notes/b.md",
      "notes",
      "notes/c.pdf",
    ]);
  });

  test("a listing with no path is the whole folder: judged as `.`, sent with no path, as before", async () => {
    const { gateway, asked, rows } = await gatewayWith(allowingAllBut());
    await gateway.listFiles("default", "bot-1", ACTOR, {});
    expect(asked).toEqual(["list (no path)"]);
    expect(rows[0]?.payload.file).toBe(".");
  });

  test("what is no path at all goes on as it was written, for the computer to refuse", async () => {
    for (const path of NOT_A_PATH) {
      const { gateway, asked, rows } = await gatewayWith(allowingAllBut());
      await gateway.readFile("default", "bot-1", ACTOR, { path });
      await gateway.writeFile("default", "bot-1", ACTOR, {
        path,
        contents: "x",
      });
      // Nothing is spelled for it: there is no file behind it to have a spelling. The real
      // computer refuses each of these (the test above); this one only writes down what it got.
      expect(asked).toEqual([`read ${path}`, `write ${path}`]);
      // And the trail says what was asked for, as it did before — nothing, where it was blank.
      expect(rows.map((row) => row.payload.file)).toEqual([
        path || undefined,
        path || undefined,
      ]);
    }
  });
});

describe("a routine's door", () => {
  test("a denied file is not written or listed by a routine that adds a space", async () => {
    const { gateway, asked } = await gatewayWith(
      allowingAllBut('matches(file.path, "^private")'),
    );
    const toolkit = await createUnattendedTools({ gateway })("bot-1", ACTOR);
    // This door hands a model's `path` on as it was written (`runner/unattended.ts`); the chat's
    // trims first. Neither has to remember any more.
    const written = await toolkit.execute("computer_write_file", {
      path: "private/pay.csv ",
      contents: "x",
    });
    const listed = await toolkit.execute("computer_list_files", {
      path: " private",
    });
    expect(written).toMatchObject({ ok: false, code: "laf:policy_denied" });
    expect(listed).toMatchObject({ ok: false, code: "laf:policy_denied" });
    expect(asked).toEqual([]);
  });
});
