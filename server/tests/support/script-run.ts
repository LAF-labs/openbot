/**
 * Stand-ins for the two things a script's run goes between, for the tests of the gateway's act
 * (`computer/gateway/acts.ts`, `runScript`): the place a script runs, and the Bot's computer.
 *
 * Each RECORDS what reached it, because what those tests hold is mostly what did NOT happen —
 * nothing sent before a decision, nothing read after a refusal, nothing filed without a row. The
 * sandbox's walls are measured where the service is real (`scripts/workbench-probe.ts`). And for
 * what a stand-in cannot say — WHICH file a path reads, or where a file lands — there is
 * `realComputer` below: no stand-in at all.
 */
import {
  fileBytes as bytesRoute,
  listFiles as listRoute,
  putFile as putRoute,
} from "../../../agent-computer/src/file-routes";
import { createWorkspace } from "../../../agent-computer/src/workspace";
import {
  type ComputerClient,
  createComputerClient,
  WorkspaceRequestError,
} from "../../src/computer/client";
import type { SnapshotResult } from "../../src/computer/schema";
import type {
  Workbench,
  WorkbenchAnswer,
  WorkbenchRequest,
} from "../../src/workbench/client";

export const bytes = (text: string) => new TextEncoder().encode(text);

/** A run that ended by itself with 0 and printed a line. */
export const ENDED: Extract<WorkbenchAnswer, { ok: true }>["run"] = {
  ending: "exited",
  exitCode: 0,
  signal: null,
  ms: 412,
  stdout: "the total is 42\n",
  stderr: "",
  stdoutBytes: 16,
  stderrBytes: 0,
  skipped: 0,
};

export const made = (...products: [string, string][]): WorkbenchAnswer => ({
  ok: true,
  run: ENDED,
  products: products.map(([name, text]) => ({ name, bytes: bytes(text) })),
});

/** The place a script runs, standing in: it records what it was sent and answers as told. */
export function fakeWorkbench(
  answer: (
    request: WorkbenchRequest,
    signal: AbortSignal | undefined,
  ) => WorkbenchAnswer | Promise<WorkbenchAnswer> = () => made(),
) {
  const sent: WorkbenchRequest[] = [];
  const workbench: Workbench = {
    health: async () => ({ busy: false, boot: "fake" }),
    run: async (request, signal) => {
      sent.push(request);
      return answer(request, signal);
    },
  };
  return { workbench, sent };
}

/** The Bot's computer, standing in: a folder in memory, and a record of everything asked of it. */
export function fakeComputer(
  folder: Record<string, Uint8Array> = {},
  options: {
    /** What the page it is parked on is, when a test looks at the screen first. */
    url?: string;
    /** What `made/` is said to hold already, in bytes; or that it cannot be described whole. */
    madeHolds?: number | "more than a listing describes";
    /** What a put is answered with instead of being taken. */
    refusePut?: (path: string) => Error | undefined;
  } = {},
) {
  const files = new Map(Object.entries(folder));
  /** Every call that reached the computer, by method and path, in order. */
  const asked: string[] = [];
  /** Which Bot each call was addressed as. */
  const addressedAs: string[] = [];
  const snapshot: SnapshotResult = {
    snapshotId: 1,
    url: options.url ?? "https://example.com/",
    title: "A page",
    truncated: false,
    elements: [{ ref: "e1", role: "button", name: "Submit order" }],
  };
  const client = {
    snapshot: async () => snapshot,
    click: async () => {
      asked.push("click");
      return { action: "click", url: snapshot.url, elapsedMs: 1 } as never;
    },
    async fileBytes(path: string) {
      asked.push(`fileBytes ${path}`);
      const found = files.get(path);
      if (!found) throw new WorkspaceRequestError("laf:file_not_found");
      return found;
    },
    async putFile(path: string, body: Uint8Array) {
      asked.push(`putFile ${path}`);
      const refused = options.refusePut?.(path);
      if (refused) throw refused;
      if (files.has(path)) throw new WorkspaceRequestError("laf:file_exists");
      files.set(path, body);
      return { path, kind: "file" as const, bytes: body.byteLength };
    },
    async listFiles(input: { path?: string }) {
      asked.push(`listFiles ${input.path ?? "."}`);
      const under = [...files].filter(([path]) =>
        path.startsWith(`${input.path}/`),
      );
      if (options.madeHolds === "more than a listing describes") {
        return { path: input.path ?? ".", entries: [], truncated: true };
      }
      if (typeof options.madeHolds === "number") {
        return {
          path: input.path ?? ".",
          entries: [
            { path: "made/earlier", kind: "folder" as const },
            {
              path: "made/earlier/old.xlsx",
              kind: "file" as const,
              bytes: options.madeHolds,
            },
          ],
          truncated: false,
        };
      }
      if (under.length === 0) {
        throw new WorkspaceRequestError("laf:file_not_found");
      }
      return {
        path: input.path ?? ".",
        entries: under.map(([path, held]) => ({
          path,
          kind: "file" as const,
          bytes: held.byteLength,
        })),
        truncated: false,
      };
    },
    forBot(botId: string) {
      addressedAs.push(botId);
      return client;
    },
  } as unknown as ComputerClient;
  return {
    client,
    files,
    asked,
    addressedAs,
    /** The browser goes somewhere else; the server sees it at its next look. */
    moveTo(url: string) {
      snapshot.url = url;
    },
  };
}

/** One of the computer's routes, as its own server calls it (`agent-computer/src/computer.ts`). */
type Route = (asked: never, computer: never) => Promise<Response> | Response;

/** The three file routes a script's run reaches, by the address the server's client dials. */
const FILE_ROUTES = new Map<string, Route>([
  ["/files/bytes", bytesRoute as Route],
  ["/files/put", putRoute as Route],
  ["/files/list", listRoute as Route],
]);

/**
 * The Bot's computer, NOT standing in: the server's own client (`computer/client.ts`), dialling
 * the computer's own route handlers (`agent-computer/src/file-routes.ts`), over the workspace
 * they are written for (`workspace.ts`), on a folder that is really on the disk. Only the socket
 * between the two is missing.
 *
 * For what a stand-in cannot show: how the computer READS a path it is handed. A stand-in that
 * looks a path up in a map does whatever its author thought of — the first tests of the path a
 * rule judges asserted on what a computer that echoes was sent, and passed with the fix deleted
 * (`gateway-file-paths.test.ts`, whose pattern this is). So every test that says which file was
 * read for a run, or where one landed, is in front of this, and asserts on the disk.
 *
 * The request is the one the client builds (a JSON body for a read and a listing; the path of a
 * put percent-encoded in a header, its body the file) and a failure is the computer's own code,
 * turned into an error by the client's own table — so the gateway reads both exactly as it would
 * off the wire.
 */
export function realComputer(root: string) {
  const workspace = createWorkspace(root);
  /** Every call that reached the computer, by method and path AS IT WAS HANDED, in order. */
  const asked: string[] = [];
  const dialled = createComputerClient({
    baseUrl: "http://computer.test",
    fetchImpl: (async (input: Request | URL | string, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const route = FILE_ROUTES.get(url.pathname);
      if (!route) {
        return Response.json({ code: "laf:not_found" }, { status: 404 });
      }
      return route(
        {
          request,
          url,
          botId: request.headers.get("x-openbot-bot-id") ?? "",
        } as never,
        { workspace } as never,
      );
    }) as typeof fetch,
  });
  const client = {
    forBot(botId: string) {
      const computer = dialled.forBot(botId);
      return {
        fileBytes(path: string) {
          asked.push(`fileBytes ${path}`);
          return computer.fileBytes(path);
        },
        putFile(path: string, body: Uint8Array) {
          asked.push(`putFile ${path}`);
          return computer.putFile(path, body);
        },
        listFiles(input: { path?: string }) {
          asked.push(`listFiles ${input.path ?? "."}`);
          return computer.listFiles(input);
        },
      };
    },
  } as unknown as ComputerClient;
  return { client, asked };
}
