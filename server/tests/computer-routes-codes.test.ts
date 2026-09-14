import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { TOOL_RESULT_KO } from "../../shared/prompt/tool-results.ko";
import type { AuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createApprovalRegistry } from "../src/computer/approvals";
import {
  COMPUTER_FAILED,
  COMPUTER_TIMED_OUT,
  COMPUTER_UNREACHABLE,
  type ComputerClient,
  ComputerUnavailableError,
  ElementNotFoundError,
  NavigationRefusedError,
  PageLoadTimeoutError,
  STALE_REFS,
  StaleSnapshotError,
  URL_INVALID,
  WORKSPACE_FILE_UNUSABLE,
  WORKSPACE_PATH_REFUSED,
  WorkspaceRefusedError,
  WorkspaceRequestError,
} from "../src/computer/client";
import type { DemonstrationRecorder } from "../src/computer/demonstration";
import { createComputerGateway } from "../src/computer/gateway";
import type { ActionPolicy } from "../src/computer/policy";
import {
  createPolicyStore,
  type PolicyStore,
} from "../src/computer/policy-store";
import { createComputerRoutes } from "../src/computer/routes";
import type { SnapshotResult } from "../src/computer/schema";
import type { WriteUp } from "../src/computer/write-up";

/**
 * What the two routes a pane reads say when they cannot answer.
 *
 * MEASURED 2026-09-06: the screen card rendered `error` out of these bodies — "The assistant's
 * computer did not respond in time.", a Playwright call log, once the bare `laf:page_timeout` —
 * under a Korean heading, because a sentence was all the body carried. The server sends facts:
 * `code` is the fact, in the same shape as every other refusal that crosses this boundary, and it
 * has to agree with the status beside it or an operator and a person are told two different
 * stories about one failure.
 */

const SHOT = {
  base64: "aGVsbG8=",
  width: 1280,
  height: 800,
  capturedAt: "2026-09-06T00:00:00.000Z",
};

const STAFF = {
  id: "staff-user",
  email: "staff@laf.test",
  role: "user",
} as const;

const OWNER = {
  id: "owner-user",
  email: "owner@laf.test",
  role: "admin",
} as const;

const PERMISSIVE: ActionPolicy = { deny: [], ask: [], allow: ["true"] };

/** A computer whose screenshot and read both fail the given way, or succeed when nothing is given. */
function surface(failure?: Error) {
  const fail = async () => {
    if (failure) throw failure;
    return SHOT;
  };
  const client = {
    screenshot: fail,
    read: async () => {
      if (failure) throw failure;
      return { url: "https://example.com", title: "Example", text: "" };
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  const auditStore: AuditStore = { insert: async () => {} };
  const gateway = createComputerGateway({
    client,
    auditStore,
    policy: () => ({ deny: [], ask: [], allow: ["true"] }),
    approvals: createApprovalRegistry(),
  });
  const policyStore = createPolicyStore({ deny: [], ask: [], allow: ["true"] });
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", STAFF);
    // Their own Bot, so the ownership guard lets these reach the code under test.
    context.set("mayDriveBot", async () => true);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createComputerRoutes(client, gateway, policyStore, requireUser),
  );
  return app;
}

async function answer(app: Hono<{ Variables: AppVariables }>, path: string) {
  const response = await app.request(path);
  const body = (await response.json()) as { error?: string; code?: string };
  return { status: response.status, code: body.code, error: body.error };
}

/**
 * Each failure the client can raise, with the one status and the one code it deserves.
 *
 * The two columns are the point: `statusFor` and `codeFor` are separate functions over the same
 * branches, and this is what holds them to the same answer.
 */
const FAILURES: Array<[string, Error, number, string]> = [
  // The client's own facts, as it has raised them since 2026-09-14.
  [
    "nothing answered the connection",
    new ComputerUnavailableError(COMPUTER_UNREACHABLE),
    503,
    "laf:computer_unreachable",
  ],
  [
    "the computer did not answer in time",
    new ComputerUnavailableError(COMPUTER_TIMED_OUT),
    503,
    "laf:computer_timed_out",
  ],
  [
    "the computer failed and said so only in words",
    new ComputerUnavailableError(COMPUTER_FAILED),
    503,
    "laf:computer_failed",
  ],
  // A failure of a known kind that carries no code is still said, by its kind.
  [
    "the computer is unavailable and carries no fact",
    new ComputerUnavailableError("The assistant's computer is not running."),
    503,
    "laf:computer_unavailable",
  ],
  [
    "a person holds the wheel",
    new ComputerUnavailableError("laf:human_has_control"),
    409,
    "laf:human_has_control",
  ],
  [
    "the page never loaded",
    new PageLoadTimeoutError(),
    504,
    "laf:page_timeout",
  ],
  [
    "the refs are stale, as the computer says it",
    new StaleSnapshotError(STALE_REFS),
    409,
    "laf:stale_refs",
  ],
  [
    "the refs are stale and nothing says so in a code",
    new StaleSnapshotError("snapshot 3 is not current"),
    409,
    "laf:snapshot_stale",
  ],
  [
    "the element left the page and nothing says so in a code",
    new ElementNotFoundError("Element e9 is not on the page any more."),
    409,
    "laf:snapshot_stale",
  ],
  [
    "something nobody named",
    new Error("insert into audit_events (...) values ($1, $2)"),
    500,
    "laf:computer_failed",
  ],
];

describe("the screenshot route", () => {
  for (const [when, failure, status, code] of FAILURES) {
    test(`says ${code} with ${status} when ${when}`, async () => {
      const answered = await answer(surface(failure), "/bot-1/screenshot");
      expect({ status: answered.status, code: answered.code }).toEqual({
        status,
        code,
      });
      // And `error` is the same code: no reader of this route is handed a sentence any more.
      expect(answered.error).toBe(code);
    });
  }

  test("a refused Bot id is the same fact it always was, and still a 400", async () => {
    const answered = await answer(surface(), "/..%2F..%2Ftmp/screenshot");
    expect({ status: answered.status, code: answered.code }).toEqual({
      status: 400,
      code: "laf:bot_id_invalid",
    });
  });

  test("a screenshot that works carries no code at all", async () => {
    const response = await surface().request("/bot-1/screenshot");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SHOT);
  });
});

describe("the read route", () => {
  // The sibling a pane reads for the page's text: the same failures, the same two columns.
  for (const [when, failure, status, code] of FAILURES) {
    test(`says ${code} with ${status} when ${when}`, async () => {
      const answered = await answer(surface(failure), "/bot-1/read");
      expect({ status: answered.status, code: answered.code }).toEqual({
        status,
        code,
      });
    });
  }
});

/*
 * THE ACTING ROUTES, AND THE ONES A PERSON'S OWN SCREENS CALL.
 *
 * Until 2026-09-14 these answered a sentence per refusal — "A ref and the snapshotId it came from are
 * both required. Take a snapshot first.", "There is nothing recorded to write up.", "deny must be a
 * list of expressions." — and passed on whatever the computer said. A Korean-speaking model read the
 * sentence as its tool result; the masked box and the Boundaries page printed it.
 */

const SNAPSHOT: SnapshotResult = {
  snapshotId: 7,
  url: "https://example.com/order",
  title: "Order",
  truncated: false,
  elements: [
    { ref: "e9", role: "button", name: "Submit order" },
    { ref: "e4", role: "textbox", name: "Customer name" },
  ],
};

/** The routes over a computer whose every acting call fails the given way. */
function acting(
  options: {
    failure?: Error;
    policyStore?: PolicyStore;
    demonstrations?: DemonstrationRecorder;
    writeUp?: WriteUp;
  } = {},
) {
  const fail = async () => {
    throw options.failure ?? new Error("no failure was given");
  };
  const client = {
    snapshot: async () => SNAPSHOT,
    navigate: fail,
    click: fail,
    type: fail,
    key: fail,
    readFile: fail,
    writeFile: fail,
    listFiles: fail,
    uploadFile: fail,
    supplySecret: fail,
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  const gateway = createComputerGateway({
    client,
    auditStore: { insert: async () => {} },
    policy: () => PERMISSIVE,
    approvals: createApprovalRegistry(),
  });
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", OWNER);
    context.set("mayDriveBot", async () => true);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createComputerRoutes(
      client,
      gateway,
      options.policyStore ?? createPolicyStore(PERMISSIVE),
      requireUser,
      options.demonstrations,
      options.writeUp,
    ),
  );
  return app;
}

async function send(
  app: Hono<{ Variables: AppVariables }>,
  path: string,
  body: unknown,
  method = "POST",
) {
  const response = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("an acting route that the computer refused", () => {
  const CASES: Array<[string, unknown, Error, number, string]> = [
    [
      "/bot-1/files/read",
      { path: "notes.md" },
      new WorkspaceRequestError(WORKSPACE_FILE_UNUSABLE),
      400,
      "laf:workspace_file_unusable",
    ],
    [
      "/bot-1/files/write",
      { path: "../secrets", contents: "x" },
      new WorkspaceRefusedError(WORKSPACE_PATH_REFUSED),
      403,
      "laf:workspace_path_refused",
    ],
    [
      "/bot-1/click",
      { ref: "e9", snapshotId: 7 },
      new StaleSnapshotError("laf:label_changed"),
      409,
      "laf:label_changed",
    ],
    [
      // A 409 like a stale ref, and a different next move: the class alone cannot say which.
      "/bot-1/click",
      { ref: "e9", snapshotId: 7 },
      new StaleSnapshotError("laf:human_has_control"),
      409,
      "laf:human_has_control",
    ],
    [
      "/bot-1/navigate",
      { url: "not a web address" },
      new NavigationRefusedError(URL_INVALID),
      403,
      "laf:url_invalid",
    ],
  ];

  for (const [path, body, failure, status, code] of CASES) {
    test(`${path} answers ${code} with ${status}, in both fields`, async () => {
      const app = acting({ failure });
      await app.request("/bot-1/snapshot", { method: "POST" });
      const answered = await send(app, path, body);
      expect({ status: answered.status, body: answered.body }).toEqual({
        status,
        body: { error: code, code },
      });
    });
  }
});

describe("a request missing what its tool needs", () => {
  const MISSING: Array<[string, unknown]> = [
    ["/bot-1/navigate", {}],
    ["/bot-1/click", { ref: "e9" }],
    ["/bot-1/type", { ref: "e4", snapshotId: 7 }],
    ["/bot-1/key", {}],
    ["/bot-1/tabs/switch", { index: "second" }],
    ["/bot-1/upload", { ref: "e4", snapshotId: 7 }],
    ["/bot-1/files/read", {}],
    ["/bot-1/files/write", { path: "notes.md" }],
    ["/bot-1/control/secret", { ref: "e4" }],
  ];

  test("is one fact, the runner's own for the same mistake", async () => {
    const app = acting();
    for (const [path, body] of MISSING) {
      const answered = await send(app, path, body);
      expect({ path, status: answered.status, body: answered.body }).toEqual({
        path,
        status: 400,
        body: {
          error: "laf:tool_arguments_invalid",
          code: "laf:tool_arguments_invalid",
        },
      });
    }
  });
});

describe("a person's own doors", () => {
  test("say what the person's request lacked, as facts", async () => {
    const app = acting();
    expect(await send(app, "/bot-1/human/secret", {})).toEqual({
      status: 400,
      body: {
        error: "laf:secret_value_required",
        code: "laf:secret_value_required",
      },
    });
    expect(await send(app, "/bot-1/human/secretly", { x: 1 })).toEqual({
      status: 400,
      body: { error: "laf:input_unknown", code: "laf:input_unknown" },
    });
  });

  test("the boundary refused as a code, naming the list, and a save that failed as what is still true", async () => {
    expect(
      await send(acting(), "/policy", { deny: "everything" }, "PUT"),
    ).toEqual({
      status: 400,
      body: {
        error: "laf:policy_list_invalid",
        code: "laf:policy_list_invalid",
        list: "deny",
      },
    });

    const failing: PolicyStore = {
      ...createPolicyStore(PERMISSIVE),
      set: async () => {
        throw new Error("the database is gone");
      },
    };
    expect(
      await send(
        acting({ policyStore: failing }),
        "/policy",
        PERMISSIVE,
        "PUT",
      ),
    ).toEqual({
      status: 503,
      body: { error: "laf:policy_not_saved", code: "laf:policy_not_saved" },
    });
  });

  test("writing a recording up says which of its four outcomes it was", async () => {
    const recorded = {
      read: () => ({
        steps: [{ kind: "click", name: "저장" }],
        finished: true,
      }),
    } as unknown as DemonstrationRecorder;
    const empty = {
      read: () => ({ steps: [], finished: true }),
    } as unknown as DemonstrationRecorder;
    const path = "/bot-1/demonstration/write-up";

    expect(await send(acting({ demonstrations: empty }), path, {})).toEqual({
      status: 409,
      body: { error: "laf:recording_empty", code: "laf:recording_empty" },
    });
    expect(await send(acting({ demonstrations: recorded }), path, {})).toEqual({
      status: 501,
      body: {
        error: "laf:write_up_unavailable",
        code: "laf:write_up_unavailable",
      },
    });
    expect(
      await send(
        acting({
          demonstrations: recorded,
          writeUp: async () => ({ ok: false, because: "busy" }),
        }),
        path,
        {},
      ),
    ).toEqual({
      status: 503,
      body: {
        error: "laf:write_up_busy",
        code: "laf:write_up_busy",
        retryLater: true,
      },
    });
    expect(
      await send(
        acting({
          demonstrations: recorded,
          writeUp: async () => ({ ok: false, because: "unreadable" }),
        }),
        path,
        {},
      ),
    ).toEqual({
      status: 502,
      body: {
        error: "laf:write_up_unreadable",
        code: "laf:write_up_unreadable",
      },
    });
  });
});

/**
 * EVERY CODE A BOT'S TOOL CAN MEET HAS WORDS FOR THE MODEL.
 *
 * `toolResultText` hands a code it has no sentence for back as itself, so a code added to the client,
 * the routes or the gateway without one reaches a Bot as `laf:…` — the identifier, in the middle of a
 * Korean tool result. Read out of the source, like the app's own walks, so a new code fails here
 * until somebody decides what the model is told.
 */
describe("what a Bot is told when its computer says no", () => {
  const COMPUTER = join(import.meta.dir, "../src/computer");
  const sources = [
    "client.ts",
    "routes.ts",
    "bot-id.ts",
    "gateway.ts",
    ...readdirSync(join(COMPUTER, "gateway")).map((file) => `gateway/${file}`),
  ].map((file) => readFileSync(join(COMPUTER, file), "utf8"));

  /**
   * The codes only a person's own screens can meet, never a tool call, each with the screen that
   * says it. No Bot tool calls these routes, so the model has nothing to be told.
   */
  const PERSON_ONLY = new Set([
    // The masked box (`app/src/lib/computer/refusals.ts`).
    "laf:secret_not_pending",
    "laf:secret_field_gone",
    "laf:secret_value_required",
    // The live screen's own input, fired and not read back.
    "laf:input_unknown",
    // Writing a demonstration up (`teach-a-task.tsx` reads `retryLater`).
    "laf:recording_empty",
    "laf:write_up_unavailable",
    "laf:write_up_busy",
    "laf:write_up_unreadable",
    // The Boundaries page.
    "laf:policy_not_saved",
  ]);

  test("every one of them is in the model's table", () => {
    const codes = new Set(
      sources.flatMap((source) =>
        [...source.matchAll(/"(laf:[a-z_]+)"/g)].map(
          (match) => match[1] as string,
        ),
      ),
    );
    const told = [...codes].filter((code) => !PERSON_ONLY.has(code));
    // The walk reached the files: a green run over an empty set would prove nothing.
    expect(told.length).toBeGreaterThan(15);
    expect(told.filter((code) => !(code in TOOL_RESULT_KO))).toEqual([]);
  });

  test("the person-only list holds only codes these files still send", () => {
    // Kept honest the other way too: an entry for a code nothing sends any more would be a hole a
    // new code of the same name could slip through without a sentence.
    for (const code of PERSON_ONLY) {
      expect({
        code,
        inSource: sources.some((s) => s.includes(`"${code}"`)),
      }).toEqual({ code, inSource: true });
    }
  });
});
