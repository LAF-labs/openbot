/**
 * Stand-ins for the two things a script's run goes between, for the tests of the gateway's act
 * (`computer/gateway/acts.ts`, `runScript`): the place a script runs, and the Bot's computer.
 *
 * Each RECORDS what reached it, because what those tests hold is mostly what did NOT happen —
 * nothing sent before a decision, nothing read after a refusal, nothing filed without a row. The
 * real ones are elsewhere: the sandbox's walls where the service is real
 * (`scripts/workbench-probe.ts`), the computer's routes in its own workspace's tests.
 */
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspacePathError,
} from "../../../agent-computer/src/workspace";
import {
  type ComputerClient,
  WorkspaceRefusedError,
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

/**
 * The Bot's computer, NOT standing in: the workspace the computer's own routes are written over
 * (`agent-computer/src/workspace.ts`), on a folder that is really on the disk.
 *
 * For what a stand-in cannot show: how the computer READS a path it is handed. It trims one, and
 * a rule judged the path as it was written — so a path that differs only by what a trim removes
 * is one thing to the policy and another to the disk. A stand-in that looks a path up in a map
 * does whatever its author thought of; this does what the computer does.
 *
 * The failures are the computer's own codes, thrown as the server's client throws them, so the
 * gateway reads them as it would off the wire.
 */
export function realComputer(root: string) {
  const workspace = createWorkspace(root);
  /** Every call that reached the computer, by method and path AS IT WAS HANDED, in order. */
  const asked: string[] = [];
  const through = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        throw new WorkspaceRefusedError(error.code);
      }
      if (error instanceof WorkspaceFileError) {
        throw new WorkspaceRequestError(error.code);
      }
      throw error;
    }
  };
  const client = {
    async fileBytes(path: string) {
      asked.push(`fileBytes ${path}`);
      const { bytes: held } = await through(() => workspace.whole(path));
      return new Uint8Array(held);
    },
    async putFile(path: string, body: Uint8Array) {
      asked.push(`putFile ${path}`);
      return through(() =>
        workspace.put(
          path,
          (async function* () {
            yield body;
          })(),
        ),
      );
    },
    async listFiles(input: { path?: string }) {
      asked.push(`listFiles ${input.path ?? "."}`);
      return through(() => workspace.list(input.path));
    },
    forBot() {
      return client;
    },
  } as unknown as ComputerClient;
  return { client, asked };
}
