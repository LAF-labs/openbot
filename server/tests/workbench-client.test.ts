/**
 * The server's client for the workbench, against a daemon that is whatever each test says it is.
 *
 * The real daemon is on the other end in `tests/workbench-daemon.test.ts` (at the repository's
 * root, where both sides can be imported). Here the other end LIES — because the one thing this
 * client must never do is pass on, as a run, what a compromised daemon chose to say. The daemon's
 * container is the one place a stranger's code runs as the daemon's own user; its answer is read
 * as untrusted as that code.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Transform } from "node:stream";
import {
  createBrotliCompress,
  createDeflate,
  createGzip,
  constants as zlib,
} from "node:zlib";
import type { Logger } from "../../shared/log";
import {
  type InvalidField,
  isNonce,
  JOB_PART,
  NONCE_HEADER,
  PROOF_HEADER,
  proofOf,
  REPORT_PART,
  routeOf,
  SCRIPT_PART,
  WORKBENCH_LIMITS,
} from "../../shared/workbench/protocol";
import { createWorkbench, type WorkbenchAnswer } from "../src/workbench/client";

const quiet: Logger = { svc: "test", info() {}, warn() {}, error() {} };

const opened: { stop: () => Promise<void> | void; root: string }[] = [];

afterEach(() => {
  for (const { stop, root } of opened.splice(0)) {
    // Not waited for: a fake that is still pretending to run something would be waited for too.
    void stop();
    rmSync(root, { recursive: true, force: true });
  }
});

/** The key the client under test holds, and — unless a test says otherwise — the far side too. */
const KEY = "a-key-for-tests-0123456789abcdef-0123456789";

/** An answer with the proof a daemon holding `key` would put on it, for the request it answers. */
async function provenBy(
  key: string,
  request: Request,
  response: Response,
): Promise<Response> {
  const nonce = request.headers.get(NONCE_HEADER);
  if (!isNonce(nonce)) return response;
  // The type and the other headers before the body: a form's type is gone once its body is read.
  const type = response.headers.get("content-type") ?? "";
  const headers = new Headers(response.headers);
  const body = new Uint8Array(await response.arrayBuffer());
  headers.set(
    PROOF_HEADER,
    proofOf(key, {
      route: routeOf(request),
      nonce,
      status: response.status,
      type,
      body,
    }),
  );
  return new Response(body, { status: response.status, headers });
}

const idle = () => Response.json({ status: "ok", busy: false, boot: "fake" });

/**
 * A daemon that answers every `/run` with whatever `answer` makes of the request.
 *
 * IT LIES AS A DAEMON WOULD HAVE TO: with the key. Every answer carries its proof, so that what
 * each test says of a shape or a size is what the client is refusing — a daemon that has been got
 * into, not a stranger at its socket. `bare` names the answers sent as they are instead: a body
 * that never ends cannot be hashed, and a redirect is refused before a proof is looked for. A fake
 * with no key at all (`key: null`) is the stranger, and has tests of its own.
 */
function fakeDaemon(
  answer: (request: Request) => Response | Promise<Response>,
  health: (request: Request) => Response | Promise<Response> = idle,
  options: {
    key?: string | null;
    bare?: ("run" | "health")[];
    /** Where to listen, when it is a path a client already knows; a directory of its own otherwise. */
    at?: string;
  } = {},
) {
  const root = options.at
    ? join(options.at, "..")
    : mkdtempSync(join(tmpdir(), "wc-"));
  const socketPath = options.at ?? join(root, "w.sock");
  const key = options.key === undefined ? KEY : options.key;
  let asked = 0;
  const said = async (
    which: "run" | "health",
    request: Request,
    response: Response,
  ) =>
    key === null || options.bare?.includes(which)
      ? response
      : provenBy(key, request, response);
  const server = Bun.serve({
    unix: socketPath,
    async fetch(request) {
      if (new URL(request.url).pathname === "/health") {
        return said("health", request, await health(request));
      }
      asked += 1;
      return said("run", request, await answer(request));
    },
  });
  opened.push({ stop: () => server.stop(true), root });
  return { socketPath, asked: () => asked, server };
}

/**
 * A report a real daemon could have sent, and the parts it names.
 *
 * What it printed is counted, as a daemon counts it, unless a test says otherwise: a report of
 * output beside a count of none is one of the answers this side does not pass on, and two
 * fixtures here were that — "second" and "the daemon that came back", printed in no bytes.
 */
function honest(
  report: Record<string, unknown> = {},
  parts: Record<string, string> = {},
): Response {
  const printed = (stream: unknown) =>
    typeof stream === "string" ? Buffer.byteLength(stream) : 0;
  const form = new FormData();
  form.set(
    REPORT_PART,
    JSON.stringify({
      ending: "exited",
      exitCode: 0,
      signal: null,
      ms: 12,
      stdout: "",
      stderr: "",
      stdoutBytes: printed(report.stdout),
      stderrBytes: printed(report.stderr),
      products: [],
      skipped: 0,
      ...report,
    }),
  );
  for (const [name, value] of Object.entries(parts)) {
    form.set(name, new Blob([value]));
  }
  return new Response(form);
}

const script = "console.log(1)";

test("a run that came back whole is handed on: how it ended, what it said, the files as bytes", async () => {
  const { socketPath } = fakeDaemon(() =>
    honest(
      {
        stdout: "합계 60\n",
        stdoutBytes: 10,
        products: [
          { name: "요일별 합계.xlsx", bytes: 5, part: "product0" },
          { name: "notes.txt", bytes: 2, part: "product1" },
        ],
        skipped: 1,
      },
      { product0: "PK-xl", product1: "ok" },
    ),
  );
  const answer = await createWorkbench({
    key: KEY,
    socketPath,
    log: quiet,
  }).run({
    script,
    files: [],
  });
  expect(answer).toEqual({
    ok: true,
    run: {
      ending: "exited",
      exitCode: 0,
      signal: null,
      ms: 12,
      stdout: "합계 60\n",
      stderr: "",
      stdoutBytes: 10,
      stderrBytes: 0,
      skipped: 1,
    },
    products: [
      { name: "요일별 합계.xlsx", bytes: new TextEncoder().encode("PK-xl") },
      { name: "notes.txt", bytes: new TextEncoder().encode("ok") },
    ],
  });
});

test("what is sent is the script as it was written, each file's bytes, and where each goes", async () => {
  let seen: {
    job: unknown;
    script: number[];
    files: Record<string, number[]>;
  } | null = null;
  const { socketPath } = fakeDaemon(async (request) => {
    const form = await request.formData();
    const bytesOf = async (name: string) => {
      const part = form.get(name);
      return part instanceof Blob
        ? [...new Uint8Array(await part.arrayBuffer())]
        : [];
    };
    seen = {
      job: JSON.parse(String(form.get(JOB_PART))),
      script: await bytesOf(SCRIPT_PART),
      files: { file0: await bytesOf("file0"), file1: await bytesOf("file1") },
    };
    return honest();
  });
  const written = "const a = `x\ny`;\r\nconsole.log(a);\n";
  await createWorkbench({ key: KEY, socketPath, log: quiet }).run({
    script: written,
    files: [
      { path: "uploads/매출.xlsx", bytes: new Uint8Array([0, 13, 10, 255]) },
      { path: "made/notes.txt", bytes: new Uint8Array([]) },
    ],
    timeoutMs: 30_000,
  });
  expect(seen).not.toBeNull();
  expect(seen as unknown).toEqual({
    job: {
      timeoutMs: 30_000,
      files: [
        { path: "uploads/매출.xlsx", part: "file0" },
        { path: "made/notes.txt", part: "file1" },
      ],
    },
    // Byte for byte: a form's text field would have rewritten the line endings.
    script: [...new TextEncoder().encode(written)],
    files: { file0: [0, 13, 10, 255], file1: [] },
  });
});

test("a request the daemon could only refuse is refused here, unsent", async () => {
  const { socketPath, asked } = fakeDaemon(() => honest());
  const workbench = createWorkbench({
    key: KEY,
    socketPath,
    log: quiet,
    limits: {
      ...WORKBENCH_LIMITS,
      scriptBytes: 20,
      files: 2,
      fileBytes: 4,
      filesBytes: 6,
    },
  });
  const file = (path: string, size = 1) => ({
    path,
    bytes: new Uint8Array(size),
  });
  const refused = (field: InvalidField): WorkbenchAnswer => ({
    ok: false,
    failure: "invalid",
    field,
  });
  expect(await workbench.run({ script: "", files: [] })).toEqual(
    refused("script"),
  );
  // Counted in bytes, as it is sent: seven characters, twenty-one bytes.
  expect(await workbench.run({ script: "가".repeat(7), files: [] })).toEqual(
    refused("script"),
  );
  for (const timeoutMs of [0, -5, 1.5, Number.NaN, 60_001]) {
    expect(await workbench.run({ script, files: [], timeoutMs })).toEqual(
      refused("timeoutMs"),
    );
  }
  for (const path of ["../x", "/x", "a/../x", "a//b", "", "a\\b", "a\0b"]) {
    expect(await workbench.run({ script, files: [file(path)] })).toEqual(
      refused("files"),
    );
  }
  // What a trim would change: the gateway reads a path trimmed, for a rule and for the computer,
  // and the daemon places it as written, so the two would not be reading the same path (the
  // read of 2026-10-07, when it was a rule that read it as written).
  for (const path of [
    "a ",
    " a",
    "a\n",
    "a\t",
    "d/a\u00a0",
    "\u3000a",
    "   ",
  ]) {
    expect(await workbench.run({ script, files: [file(path)] })).toEqual(
      refused("files"),
    );
  }
  expect(
    await workbench.run({ script, files: [file("a"), file("b"), file("c")] }),
  ).toEqual(refused("files"));
  expect(
    await workbench.run({ script, files: [file("a"), file("a")] }),
  ).toEqual(refused("files"));
  expect(await workbench.run({ script, files: [file("a", 5)] })).toEqual(
    refused("files"),
  );
  expect(
    await workbench.run({ script, files: [file("a", 4), file("b", 3)] }),
  ).toEqual(refused("files"));
  expect(asked()).toBe(0);
  // And what fits is sent.
  expect(
    (await workbench.run({ script, files: [file("a", 4), file("b", 2)] })).ok,
  ).toBe(true);
  expect(asked()).toBe(1);
});

/** Answers no real daemon sends. Each must come back as `malformed`, whole. */
const lies: [string, () => Response][] = [
  ["not a form at all", () => Response.json({ ending: "exited" })],
  ["a form with no report", () => new Response(new FormData())],
  [
    "a report that is not JSON",
    () => {
      const form = new FormData();
      form.set(REPORT_PART, "{exited");
      return new Response(form);
    },
  ],
  [
    "a report that is a list",
    () => {
      const form = new FormData();
      form.set(REPORT_PART, "[]");
      return new Response(form);
    },
  ],
  ["an ending nobody defined", () => honest({ ending: "escaped" })],
  ["an exit status that is a word", () => honest({ exitCode: "0" })],
  ["a signal that is a number", () => honest({ signal: 9 })],
  ["a time that is negative", () => honest({ ms: -1 })],
  ["a count that is a fraction", () => honest({ stdoutBytes: 1.5 })],
  ["no count of what was skipped", () => honest({ skipped: undefined })],
  ["output that is not text", () => honest({ stdout: ["a"] })],
  [
    "more output than the bound keeps",
    () => honest({ stderr: "x".repeat(WORKBENCH_LIMITS.streamBytes + 1) }),
  ],
  /*
   * WHAT A REPORT SAYS OF A RUN, HELD TO MORE THAN ITS TYPE (the second read). These were each
   * passed on, and each is written on the run's ending row as the daemon said it: no output
   * beside a thousand characters of it, a status no process leaves with, a run stopped at its
   * time that also left with 0. A number that is a number is not yet a number a run can have.
   */
  [
    "said to have printed less than it handed back",
    () => honest({ stdout: "x".repeat(1000), stdoutBytes: 0 }),
  ],
  [
    "said to have printed less to stderr than it handed back",
    () => honest({ stderr: "warning\n", stderrBytes: 7 }),
  ],
  ["an exit status no process leaves with", () => honest({ exitCode: 1e21 })],
  ["an exit status past the last there is", () => honest({ exitCode: 256 })],
  ["an exit status below nought", () => honest({ exitCode: -1 })],
  [
    "a run longer than the time it was given and the wait after it",
    () => honest({ ms: Number.MAX_SAFE_INTEGER }),
  ],
  [
    "stopped at its time, and yet left with a status",
    () => honest({ ending: "timed_out", exitCode: 0, signal: null }),
  ],
  [
    "stopped at its memory by a signal the service does not send",
    () =>
      honest({ ending: "out_of_memory", exitCode: null, signal: "SIGTERM" }),
  ],
  [
    "both a status and a signal",
    () => honest({ exitCode: 0, signal: "SIGKILL" }),
  ],
  [
    "neither a status nor a signal",
    () => honest({ exitCode: null, signal: null }),
  ],
  ["products that are not a list", () => honest({ products: "none" })],
  ["a refusal nobody defined", () => honest({ productsRefused: "too_ugly" })],
  [
    "files from a script that failed",
    () =>
      honest(
        {
          exitCode: 1,
          products: [{ name: "a.txt", bytes: 1, part: "product0" }],
        },
        { product0: "x" },
      ),
  ],
  [
    "files from a script that was ended",
    () =>
      honest(
        {
          ending: "timed_out",
          exitCode: null,
          signal: "SIGKILL",
          products: [{ name: "a.txt", bytes: 1, part: "product0" }],
        },
        { product0: "x" },
      ),
  ],
  [
    "files refused and files handed back, both",
    () =>
      honest(
        {
          productsRefused: "too_many",
          products: [{ name: "a.txt", bytes: 1, part: "product0" }],
        },
        { product0: "x" },
      ),
  ],
  [
    "a file whose name is a path",
    () =>
      honest(
        { products: [{ name: "../../etc/x", bytes: 1, part: "product0" }] },
        { product0: "x" },
      ),
  ],
  [
    "a file whose name is hidden",
    () =>
      honest(
        { products: [{ name: ".env", bytes: 1, part: "product0" }] },
        { product0: "x" },
      ),
  ],
  /*
   * A NAME THAT WOULD NOT BE FILED UNDER ITSELF (the independent read of 2026-10-07): a name
   * becomes the end of a path that is read once, trimmed, before a rule is asked about it or
   * the computer is sent it — so `"tool2.exe "` would be filed as `tool2.exe`, and a name of
   * spaces as the path of its own folder (where it was written as a file, when a rule still
   * judged the name as written). And a name that draws as another name.
   */
  [
    "a file whose name ends in a space",
    () =>
      honest(
        { products: [{ name: "tool2.exe ", bytes: 1, part: "product0" }] },
        { product0: "x" },
      ),
  ],
  [
    "a file whose name is nothing but spaces",
    () =>
      honest(
        { products: [{ name: "   ", bytes: 1, part: "product0" }] },
        { product0: "x" },
      ),
  ],
  [
    "a file whose name ends a line",
    () =>
      honest(
        { products: [{ name: "a.csv\n", bytes: 1, part: "product0" }] },
        { product0: "x" },
      ),
  ],
  [
    "a file whose name draws as another name",
    () =>
      honest(
        {
          products: [
            { name: "invoice\u202efdp.exe", bytes: 1, part: "product0" },
          ],
        },
        { product0: "x" },
      ),
  ],
  /*
   * AND THE REST OF THAT CLASS, held by what Unicode says a character is (the second read): a
   * soft hyphen draws as nothing, a Hangul filler is a letter that draws as nothing, and half a
   * character is not text — the computer's client throws on it when it writes the path, after
   * the script has run.
   */
  [
    "a file whose name has a soft hyphen in it",
    () =>
      honest(
        {
          products: [{ name: "to\u00adtals.csv", bytes: 1, part: "product0" }],
        },
        { product0: "x" },
      ),
  ],
  [
    "a file whose name ends in a Hangul filler",
    () =>
      honest(
        { products: [{ name: "tool.exe\u3164", bytes: 1, part: "product0" }] },
        { product0: "x" },
      ),
  ],
  [
    "a file whose name holds half a character",
    () =>
      honest(
        { products: [{ name: "b\ud800.txt", bytes: 1, part: "product0" }] },
        { product0: "x" },
      ),
  ],
  /*
   * AND A NAME WITH A BACKSLASH IN IT, which the daemon leaves where the script put it and
   * counts (`tests/workbench-daemon.test.ts`): the Bot's computer wrote one as a letter and read
   * it as a separator. An answer that names one is not that daemon's, and none of it is passed
   * on — not the files beside it either, which are whatever such an answer says they are.
   */
  [
    "a file whose name has a backslash in it",
    () =>
      honest(
        {
          products: [
            { name: "report.csv", bytes: 1, part: "product0" },
            { name: "a\\b.txt", bytes: 1, part: "product1" },
          ],
        },
        { product0: "r", product1: "x" },
      ),
  ],
  [
    "two files under one name",
    () =>
      honest(
        {
          products: [
            { name: "a.txt", bytes: 1, part: "product0" },
            { name: "a.txt", bytes: 1, part: "product1" },
          ],
        },
        { product0: "x", product1: "y" },
      ),
  ],
  [
    "a file the report names and the answer does not hold",
    () => honest({ products: [{ name: "a.txt", bytes: 1, part: "product0" }] }),
  ],
  [
    "a file that is not the size the report says",
    () =>
      honest(
        { products: [{ name: "a.txt", bytes: 1, part: "product0" }] },
        { product0: "xy" },
      ),
  ],
  [
    "a file that is a text field",
    () => {
      const form = new FormData();
      form.set(
        REPORT_PART,
        JSON.stringify({
          ending: "exited",
          exitCode: 0,
          signal: null,
          ms: 1,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          products: [{ name: "a.txt", bytes: 1, part: "product0" }],
          skipped: 0,
        }),
      );
      form.set("product0", "x");
      return new Response(form);
    },
  ],
  [
    "more files than a run may hand back",
    () =>
      honest(
        {
          products: Array.from(
            { length: WORKBENCH_LIMITS.products + 1 },
            (_, index) => ({
              name: `${index}.txt`,
              bytes: 1,
              part: `product${index}`,
            }),
          ),
        },
        Object.fromEntries(
          Array.from({ length: WORKBENCH_LIMITS.products + 1 }, (_, index) => [
            `product${index}`,
            "x",
          ]),
        ),
      ),
  ],
  [
    "a file said to be larger than one may be",
    () =>
      honest({
        products: [
          {
            name: "a.bin",
            bytes: WORKBENCH_LIMITS.productBytes + 1,
            part: "product0",
          },
        ],
      }),
  ],
];

for (const [name, lie] of lies) {
  test(`an answer that is ${name} is not passed on, in whole or in part`, async () => {
    const { socketPath } = fakeDaemon(lie);
    expect(
      await createWorkbench({ key: KEY, socketPath, log: quiet }).run({
        script,
        files: [],
      }),
    ).toEqual({ ok: false, failure: "malformed" });
  });
}

/*
 * AND WHAT A REAL DAEMON SAYS IS STILL PASSED ON: each way a run really ends (`shared/workbench/
 * run.ts` — a status or a signal, never both; the daemon's own kill at a bound is SIGKILL), output
 * cut at the bound with its true total beside it, and text whose characters are more than a byte.
 */
test("what a real daemon says of each way a run ends is passed on as it was said", async () => {
  const kept = "가".repeat(100);
  const said: Record<string, unknown>[] = [
    { ending: "exited", exitCode: 0, signal: null },
    { ending: "exited", exitCode: 255, signal: null },
    // Ended by a signal of its own making.
    { ending: "exited", exitCode: null, signal: "SIGSEGV" },
    { ending: "timed_out", exitCode: null, signal: "SIGKILL" },
    { ending: "out_of_memory", exitCode: null, signal: "SIGKILL" },
    // As long as it was given and the wait after it, to the millisecond.
    { ms: WORKBENCH_LIMITS.timeoutMs + 10_000 },
    // A hundred characters of three bytes each, and far more printed than was kept.
    { stdout: kept, stdoutBytes: 300, stderr: "x", stderrBytes: 9_000_000 },
    // Exactly as many bytes as characters: plain text, all of it kept.
    { stdout: "abc", stdoutBytes: 3 },
    { skipped: 4_000 },
  ];
  for (const report of said) {
    const { socketPath } = fakeDaemon(() => honest(report));
    const answer = await createWorkbench({
      key: KEY,
      socketPath,
      log: quiet,
    }).run({ script, files: [] });
    expect({ report, ok: answer.ok }).toEqual({ report, ok: true });
    if (!answer.ok) continue;
    expect(answer.run).toMatchObject(report);
  }
});

test("files that fit one by one and not together are not passed on either", async () => {
  // A daemon for each client: a path has one client, with the bounds it was first made with.
  const twelveBytes = () =>
    fakeDaemon(() =>
      honest(
        {
          products: [
            { name: "a.txt", bytes: 6, part: "product0" },
            { name: "b.txt", bytes: 6, part: "product1" },
          ],
        },
        { product0: "aaaaaa", product1: "bbbbbb" },
      ),
    );
  const run = (productsBytes: number) =>
    createWorkbench({
      key: KEY,
      socketPath: twelveBytes().socketPath,
      log: quiet,
      limits: { ...WORKBENCH_LIMITS, productBytes: 6, productsBytes },
    }).run({ script, files: [] });
  expect(await run(11)).toEqual({ ok: false, failure: "malformed" });
  expect((await run(12)).ok).toBe(true);
});

test("each refusal of the daemon's is this side's word for it", async () => {
  const refusal = (code: string, status: number, extra = {}) =>
    Response.json({ error: code, code, ...extra }, { status });
  const told = async (response: Response) => {
    const { socketPath } = fakeDaemon(() => response);
    return createWorkbench({ key: KEY, socketPath, log: quiet }).run({
      script,
      files: [],
    });
  };
  expect(await told(refusal("laf:workbench_busy", 503))).toEqual({
    ok: false,
    failure: "busy",
  });
  expect(await told(refusal("laf:workbench_not_isolated", 503))).toEqual({
    ok: false,
    failure: "not_isolated",
  });
  expect(
    await told(
      refusal("laf:workbench_request_invalid", 400, { field: "files" }),
    ),
  ).toEqual({ ok: false, failure: "invalid", field: "files" });
  // A field this side does not know is not repeated.
  expect(
    await told(
      refusal("laf:workbench_request_invalid", 400, { field: "<script>" }),
    ),
  ).toEqual({ ok: false, failure: "invalid" });
  expect(await told(refusal("laf:workbench_failed", 500))).toEqual({
    ok: false,
    failure: "failed",
  });
  // The runtime's own refusal of a body over the daemon's bound is sent before the daemon saw the
  // request: it carries no code of ours and no proof, so it says only that there was no run.
  const runtimes = fakeDaemon(
    () => new Response("too large", { status: 413 }),
    idle,
    { bare: ["run"] },
  );
  expect(
    await createWorkbench({
      key: KEY,
      socketPath: runtimes.socketPath,
      log: quiet,
    }).run({ script, files: [] }),
  ).toEqual({ ok: false, failure: "failed" });
  // Anything else that is not a yes.
  expect(await told(new Response("<html>", { status: 502 }))).toEqual({
    ok: false,
    failure: "failed",
  });
  expect(await told(refusal("laf:something_new", 418))).toEqual({
    ok: false,
    failure: "failed",
  });
});

test("no socket, or nobody behind it, is `unavailable` — the service is not running here", async () => {
  const root = mkdtempSync(join(tmpdir(), "wc-"));
  opened.push({ stop: () => {}, root });
  const missing = createWorkbench({
    key: KEY,
    socketPath: join(root, "none.sock"),
    log: quiet,
    absentMs: 60,
  });
  expect(await missing.run({ script, files: [] })).toEqual({
    ok: false,
    failure: "unavailable",
  });
  expect(await missing.health()).toBeNull();
  // A file where the socket should be, with nobody listening.
  writeFileSync(join(root, "stale.sock"), "");
  expect(
    await createWorkbench({
      key: KEY,
      socketPath: join(root, "stale.sock"),
      log: quiet,
      absentMs: 60,
    }).run({ script, files: [] }),
  ).toEqual({ ok: false, failure: "unavailable" });
});

test("a daemon that goes away during a run is `failed`, not `unavailable`: something did start", async () => {
  const daemon = fakeDaemon(async () => {
    // The container ending under the request: the connection closes with nothing said.
    setTimeout(() => void daemon.server.stop(true), 50);
    await Bun.sleep(5_000);
    return honest();
  });
  expect(
    await createWorkbench({
      key: KEY,
      socketPath: daemon.socketPath,
      log: quiet,
    }).run({
      script,
      files: [],
    }),
  ).toEqual({ ok: false, failure: "failed" });
});

test("a daemon that never answers is given the script's own time and a margin, and no longer", async () => {
  const { socketPath } = fakeDaemon(async () => {
    await Bun.sleep(10_000);
    return honest();
  });
  const started = performance.now();
  expect(
    await createWorkbench({
      key: KEY,
      socketPath,
      log: quiet,
      marginMs: 100,
    }).run({
      script,
      files: [],
      timeoutMs: 200,
    }),
  ).toEqual({ ok: false, failure: "failed" });
  const waited = performance.now() - started;
  expect(waited).toBeGreaterThanOrEqual(290);
  expect(waited).toBeLessThan(3_000);
});

test("a caller that gives up is told `stopped`, before sending or during", async () => {
  const { socketPath, asked } = fakeDaemon(async () => {
    await Bun.sleep(10_000);
    return honest();
  });
  const workbench = createWorkbench({ key: KEY, socketPath, log: quiet });
  const already = new AbortController();
  already.abort();
  expect(await workbench.run({ script, files: [] }, already.signal)).toEqual({
    ok: false,
    failure: "stopped",
  });
  expect(asked()).toBe(0);
  const during = new AbortController();
  const run = workbench.run({ script, files: [] }, during.signal);
  await Bun.sleep(100);
  during.abort();
  expect(await run).toEqual({ ok: false, failure: "stopped" });
  expect(asked()).toBe(1);
});

test("one run is in flight and four may wait; a sixth caller is told `busy` at once", async () => {
  let inFlight = 0;
  let most = 0;
  const { socketPath } = fakeDaemon(async () => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await Bun.sleep(40);
    inFlight -= 1;
    return honest();
  });
  const workbench = createWorkbench({ key: KEY, socketPath, log: quiet });
  const runs = Array.from({ length: 6 }, () =>
    workbench.run({ script, files: [] }),
  );
  const answers = await Promise.all(runs);
  expect(answers.map((answer) => (answer.ok ? "ran" : answer.failure))).toEqual(
    ["ran", "ran", "ran", "ran", "ran", "busy"],
  );
  // Never two at the socket at once: a script that can reach the socket's file never meets one.
  expect(most).toBe(1);
  // And the queue empties: the next caller is served.
  expect((await workbench.run({ script, files: [] })).ok).toBe(true);
});

test("health says whether the service answers, whether it is running something, and which daemon it is", async () => {
  let body: unknown = { status: "ok", busy: true, boot: "abc" };
  const { socketPath } = fakeDaemon(
    () => honest(),
    () => Response.json(body),
  );
  const workbench = createWorkbench({ key: KEY, socketPath, log: quiet });
  expect(await workbench.health()).toEqual({ busy: true, boot: "abc" });
  body = { status: "ok", busy: false, boot: "def" };
  expect(await workbench.health()).toEqual({ busy: false, boot: "def" });
  // Anything that is not that shape is no answer.
  for (const other of [
    { status: "ok" },
    { status: "ok", busy: false },
    { status: "no", busy: false, boot: "abc" },
    { status: "ok", busy: false, boot: "x".repeat(65) },
    { status: "ok", busy: "no", boot: "abc" },
    [],
  ]) {
    body = other;
    expect(await workbench.health()).toBeNull();
  }
});

/*
 * WHAT THE DAEMON SENDS IS HELD TO A SIZE AS IT ARRIVES (the independent read of 2026-10-06). Every
 * lie above is a lie of shape; none was a lie of SIZE, and the client read each answer whole before
 * it looked at any of it. This process is the API server — the one process on the VM — and the
 * far end is the one container where a stranger's code runs.
 */

/** A body that never ends: 64 KiB at a time for as long as anybody reads, counting what was handed over. */
function endless() {
  let served = 0;
  const piece = new Uint8Array(64 * 1024);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await Bun.sleep(2);
      served += piece.byteLength;
      controller.enqueue(piece);
    },
  });
  return {
    body,
    served: () => served,
    /** Whether anybody is still taking it: nothing more handed over across a third of a second. */
    async letGo() {
      const before = served;
      await Bun.sleep(300);
      return served === before;
    },
  };
}

const MEBIBYTE = 1024 * 1024;

test("an answer that never ends is let go of at the bound: what the daemon served, not what the client kept", async () => {
  const flood = endless();
  const began = performance.now();
  const { socketPath } = fakeDaemon(
    () =>
      new Response(flood.body, {
        headers: { "content-type": "multipart/form-data; boundary=x" },
      }),
    idle,
    { bare: ["run"] },
  );
  const answer = await createWorkbench({
    key: KEY,
    socketPath,
    log: quiet,
    limits: {
      ...WORKBENCH_LIMITS,
      productBytes: 128 * 1024,
      productsBytes: 128 * 1024,
      streamBytes: 4 * 1024,
    },
    marginMs: 1_500,
  }).run({ script, files: [], timeoutMs: 1_500 });
  expect(answer).toEqual({ ok: false, failure: "malformed" });
  // Answered when the bound was passed — not three seconds later, when its own time ran out.
  expect(performance.now() - began).toBeLessThan(1_500);
  await Bun.sleep(100);
  /*
   * 128 KiB of files and a report of two 4 KiB streams: the client reads a few hundred KiB and
   * lets go. What the fake had handed over by then is that and whatever was already on its way —
   * a few megabytes sit in a socket's buffers. Read whole, as it was, three seconds of this was
   * 77 MB held by the client (measured before the bound, 2026-10-06).
   */
  expect(flood.served()).toBeLessThan(16 * MEBIBYTE);
  expect(await flood.letGo()).toBe(true);
});

test("a refusal that never ends, and a health answer that never ends, are let go of too", async () => {
  const asJson = { "content-type": "application/json" };
  const refusal = endless();
  const refusing = fakeDaemon(
    () => new Response(refusal.body, { status: 503, headers: asJson }),
    idle,
    { bare: ["run"] },
  );
  expect(
    await createWorkbench({
      key: KEY,
      socketPath: refusing.socketPath,
      log: quiet,
      marginMs: 1_000,
    }).run({ script, files: [], timeoutMs: 1_000 }),
  ).toEqual({ ok: false, failure: "failed" });
  const health = endless();
  const answering = fakeDaemon(
    () => honest(),
    () => new Response(health.body, { headers: asJson }),
    { bare: ["health"] },
  );
  expect(
    await createWorkbench({
      key: KEY,
      socketPath: answering.socketPath,
      log: quiet,
    }).health(),
  ).toBeNull();
  await Bun.sleep(100);
  // Eight kibibytes are read of each; the rest of what was served never left the socket's buffers.
  expect(refusal.served()).toBeLessThan(16 * MEBIBYTE);
  expect(health.served()).toBeLessThan(16 * MEBIBYTE);
  expect(await refusal.letGo()).toBe(true);
  expect(await health.letGo()).toBe(true);
});

test("a redirect is not followed: the socket's answer cannot send this server anywhere else", async () => {
  let elsewhere = 0;
  const network = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      elsewhere += 1;
      return honest();
    },
  });
  opened.push({ stop: () => network.stop(true), root: "/nonexistent-nothing" });
  for (const status of [301, 302, 307, 308]) {
    const elsewhereOf = () =>
      new Response(null, {
        status,
        headers: { location: `http://127.0.0.1:${network.port}/run` },
      });
    // The run's answer points elsewhere: asked once, and followed nowhere.
    const running = fakeDaemon(elsewhereOf, idle, { bare: ["run"] });
    expect(
      await createWorkbench({
        key: KEY,
        socketPath: running.socketPath,
        log: quiet,
      }).run({ script, files: [{ path: "a", bytes: new Uint8Array([1]) }] }),
      String(status),
    ).toEqual({ ok: false, failure: "failed" });
    expect(running.asked(), String(status)).toBe(1);
    // Health's does: no answer — and so nothing to send a run to.
    const asking = fakeDaemon(() => honest(), elsewhereOf, {
      bare: ["health"],
    });
    const workbench = createWorkbench({
      key: KEY,
      socketPath: asking.socketPath,
      log: quiet,
      marginMs: 60,
    });
    expect(await workbench.health(), String(status)).toBeNull();
    expect(await workbench.run({ script, files: [] }), String(status)).toEqual({
      ok: false,
      failure: "unavailable",
    });
    expect(asking.asked(), String(status)).toBe(0);
  }
  expect(elsewhere).toBe(0);
});

test("the signal a run ended by is a signal's name or the answer is not passed on", async () => {
  for (const signal of ["SIGKILL", "SIGTERM", "SIGSEGV", "SIGUSR1"]) {
    const { socketPath } = fakeDaemon(() =>
      honest({ ending: "exited", exitCode: null, signal }),
    );
    const answer = await createWorkbench({
      key: KEY,
      socketPath,
      log: quiet,
    }).run({
      script,
      files: [],
    });
    expect(answer.ok && answer.run.signal).toBe(signal);
  }
  for (const signal of [
    "owner@example.com",
    "SIG",
    "sigkill",
    "SIGKILL; rm -rf",
    `SIG${"A".repeat(40)}`,
    "x".repeat(200_000),
    "",
  ]) {
    const { socketPath } = fakeDaemon(() =>
      honest({ ending: "exited", exitCode: null, signal }),
    );
    expect(
      await createWorkbench({ key: KEY, socketPath, log: quiet }).run({
        script,
        files: [],
      }),
      signal.slice(0, 20),
    ).toEqual({ ok: false, failure: "malformed" });
  }
});

// Six runs of 600 ms each through one queue: 3.7 seconds with four workers sharing the cores.
test("a caller that gives up while waiting its turn is told at once, and its run is never sent", async () => {
  const { socketPath, asked } = fakeDaemon(async () => {
    await Bun.sleep(600);
    return honest();
  });
  const workbench = createWorkbench({ key: KEY, socketPath, log: quiet });
  const first = workbench.run({ script, files: [] });
  const gaveUp = new AbortController();
  const started = performance.now();
  const second = workbench.run({ script, files: [] }, gaveUp.signal);
  setTimeout(() => gaveUp.abort(), 50);
  expect(await second).toEqual({ ok: false, failure: "stopped" });
  // Told when it stopped, not when the run ahead of it ended.
  expect(performance.now() - started).toBeLessThan(400);
  expect((await first).ok).toBe(true);
  // And its place in the queue is given back: five more are taken, as when nothing was waiting.
  const more = await Promise.all(
    Array.from({ length: 5 }, () => workbench.run({ script, files: [] })),
  );
  expect(more.every((answer) => answer.ok)).toBe(true);
  expect(asked()).toBe(6);
}, 30_000);

/*
 * WHAT THE FAR SIDE SAYS ITS ANSWER IS, IS THE FAR SIDE'S TO SAY (the second independent read of
 * 2026-10-06). The bound above is on the bytes this side pulls — and two headers decide what
 * becomes of them before and after: `Content-Encoding`, which the runtime obeys by inflating
 * inside `fetch`, before a byte is counted; and `Content-Type`, which decides what parser the
 * bytes are handed to. Measured against the client as it was, with a listener that is not the
 * daemon: 1.6 kB of brotli grew this process by 1.2 GB and held it three seconds; a megabyte of
 * gzip by 0.6 GB; thirteen megabytes sent as a url-encoded form by 0.7 GB. And a form with ten
 * thousand parts nobody named, or a megabyte of headers on one, was passed on as a run.
 */

/**
 * For a test that squeezes its own bombs before it starts. Three times half a gigabyte of zeros is
 * real compression work, about 2.3 seconds alone, and over Bun's default of five seconds with four
 * workers sharing the cores. The refusal it is checking still has to land inside a second.
 */
const BOMB_BUILD_MS = 30_000;

/** `megabytes` of zeros through a compressor, a megabyte at a time: what they are on the wire. */
async function squeezed(
  compressor: Transform,
  megabytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const pieces: Buffer[] = [];
  compressor.on("data", (piece: Buffer) => pieces.push(piece));
  const ended = new Promise<void>((resolve, reject) => {
    compressor.on("end", () => resolve());
    compressor.on("error", reject);
  });
  const zeros = Buffer.alloc(MEBIBYTE);
  for (let sent = 0; sent < megabytes; sent += 1) {
    if (!compressor.write(zeros)) {
      await new Promise<void>((resolve) =>
        compressor.once("drain", () => resolve()),
      );
    }
  }
  compressor.end();
  await ended;
  return new Uint8Array(Buffer.concat(pieces));
}

/** How much this process grew while `work` ran, at most. */
async function grownBy<T>(
  work: () => Promise<T>,
): Promise<{ value: T; grew: number }> {
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  let most = before;
  const watch = setInterval(() => {
    most = Math.max(most, process.memoryUsage().rss);
  }, 2);
  try {
    const value = await work();
    most = Math.max(most, process.memoryUsage().rss);
    return { value, grew: most - before };
  } finally {
    clearInterval(watch);
  }
}

/** Bytes handed over a few at a time, counting what was taken. */
function trickled(bytes: Uint8Array, piece = 64 * 1024) {
  let served = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (served >= bytes.byteLength) return controller.close();
      await Bun.sleep(2);
      controller.enqueue(bytes.subarray(served, served + piece));
      served += piece;
    },
  });
  return { body, served: () => Math.min(served, bytes.byteLength) };
}

/** What a logger was told, by event. */
function recorded() {
  const events: [string, Record<string, unknown> | undefined][] = [];
  const log: Logger = {
    svc: "test",
    info() {},
    warn: (event, fields) => void events.push([event, fields]),
    error() {},
  };
  return { log, events };
}

/** A multipart body written by hand: each part is its own header lines and what follows them. */
const handBuilt = (parts: string[], boundary = "x") =>
  new TextEncoder().encode(
    `${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join("")}--${boundary}--\r\n`,
  );

const reportPart = (extra = "") =>
  `Content-Disposition: form-data; name="${REPORT_PART}"${extra}\r\n\r\n${JSON.stringify(
    {
      ending: "exited",
      exitCode: 0,
      signal: null,
      ms: 1,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      products: [],
      skipped: 0,
    },
  )}`;

const FORM_TYPE = { "content-type": "multipart/form-data; boundary=x" };

test(
  "an answer that names an encoding is refused by that name and never inflated",
  async () => {
    const half = 512;
    const bombs: [string, Uint8Array<ArrayBuffer>][] = [
      ["gzip", await squeezed(createGzip(), half)],
      ["deflate", await squeezed(createDeflate(), half)],
      [
        "br",
        await squeezed(
          createBrotliCompress({
            params: { [zlib.BROTLI_PARAM_QUALITY]: 4 },
          }),
          half,
        ),
      ],
    ];
    for (const [encoding, bytes] of bombs) {
      // Half a gigabyte of nothing, in a megabyte or less on the wire.
      expect(bytes.byteLength, encoding).toBeLessThan(2 * MEBIBYTE);
      const { socketPath } = fakeDaemon(
        () =>
          new Response(bytes, {
            headers: { ...FORM_TYPE, "content-encoding": encoding },
          }),
      );
      const { log, events } = recorded();
      const began = performance.now();
      const { value, grew } = await grownBy(() =>
        createWorkbench({ key: KEY, socketPath, log }).run({
          script,
          files: [],
        }),
      );
      expect(value, encoding).toEqual({ ok: false, failure: "malformed" });
      expect(events, encoding).toContainEqual([
        "workbench_answer_malformed",
        { reason: "encoded" },
      ]);
      // What this process held: nothing of the half gigabyte. It was 0.6 and 1.2 GB.
      expect(grew / MEBIBYTE, encoding).toBeLessThan(64);
      expect(performance.now() - began, encoding).toBeLessThan(1_000);
    }
    // Any encoding at all is a lie here, the one that means "none" included: none was asked for.
    const named = fakeDaemon(() => {
      const answer = honest();
      answer.headers.set("content-encoding", "identity");
      return answer;
    });
    expect(
      await createWorkbench({
        key: KEY,
        socketPath: named.socketPath,
        log: quiet,
      }).run({
        script,
        files: [],
      }),
    ).toEqual({ ok: false, failure: "malformed" });
  },
  BOMB_BUILD_MS,
);

test("no encoding is asked for, of a run or of health", async () => {
  const asked: (string | null)[] = [];
  const { socketPath } = fakeDaemon(
    (request) => {
      asked.push(request.headers.get("accept-encoding"));
      return honest();
    },
    // Health's request is not handed to this fake: the header is read off the next run instead.
  );
  const workbench = createWorkbench({ key: KEY, socketPath, log: quiet });
  expect((await workbench.run({ script, files: [] })).ok).toBe(true);
  expect(asked).toEqual(["identity"]);
});

test(
  "a refusal or a health answer that names an encoding is not believed either",
  async () => {
    const bomb = await squeezed(createGzip(), 256);
    const encoded = (status: number) =>
      new Response(bomb, {
        status,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      });
    const refusing = fakeDaemon(() => encoded(503));
    const answering = fakeDaemon(
      () => honest(),
      () => encoded(200),
    );
    const { value, grew } = await grownBy(async () => [
      await createWorkbench({
        key: KEY,
        socketPath: refusing.socketPath,
        log: quiet,
      }).run({ script, files: [] }),
      await createWorkbench({
        key: KEY,
        socketPath: answering.socketPath,
        log: quiet,
      }).health(),
    ]);
    expect(value).toEqual([{ ok: false, failure: "failed" }, null]);
    expect(grew / MEBIBYTE).toBeLessThan(64);
  },
  BOMB_BUILD_MS,
);

test("only a form is read as a run, and only JSON as a refusal or as health", async () => {
  // Thirteen megabytes that are a form of four million fields, if anybody parses them as one.
  const fields = new TextEncoder().encode(
    "a=&".repeat(Math.floor((13 * MEBIBYTE) / 3)),
  );
  const flood = trickled(fields);
  const urlencoded = fakeDaemon(
    () =>
      new Response(flood.body, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    idle,
    // As it comes, a piece at a time: what is counted is how much of it was ever taken.
    { bare: ["run"] },
  );
  const { log, events } = recorded();
  const began = performance.now();
  const { value, grew } = await grownBy(() =>
    createWorkbench({ key: KEY, socketPath: urlencoded.socketPath, log }).run({
      script,
      files: [],
    }),
  );
  expect(value).toEqual({ ok: false, failure: "malformed" });
  expect(events).toContainEqual([
    "workbench_answer_malformed",
    { reason: "not_a_form" },
  ]);
  expect(performance.now() - began).toBeLessThan(500);
  // Refused on what it said it was: not read to its end, and not parsed. It was 0.7 GB.
  expect(grew / MEBIBYTE).toBeLessThan(64);
  await Bun.sleep(100);
  expect(flood.served()).toBeLessThan(4 * MEBIBYTE);

  const honestBytes = new Uint8Array(await honest().arrayBuffer());
  for (const type of [
    "text/plain",
    "application/json",
    "multipart/form-data",
    "multipart/form-data; boundary=",
    `multipart/form-data; boundary=${"b".repeat(200)}`,
    "multipart/mixed; boundary=x",
  ]) {
    const { socketPath } = fakeDaemon(
      () => new Response(honestBytes, { headers: { "content-type": type } }),
    );
    expect(
      await createWorkbench({ key: KEY, socketPath, log: quiet }).run({
        script,
        files: [],
      }),
      type,
    ).toEqual({ ok: false, failure: "malformed" });
  }

  // A refusal's code is read out of JSON that says it is JSON, and out of nothing else.
  const busy = JSON.stringify({ code: "laf:workbench_busy" });
  const there = JSON.stringify({ status: "ok", busy: false, boot: "fake" });
  const refusing = (type: string) =>
    fakeDaemon(
      () =>
        new Response(busy, { status: 503, headers: { "content-type": type } }),
    );
  const answering = (type: string) =>
    fakeDaemon(
      () => honest(),
      () => new Response(there, { headers: { "content-type": type } }),
    );
  const client = (socketPath: string) =>
    createWorkbench({ key: KEY, socketPath, log: quiet, marginMs: 60 });
  for (const type of ["application/json", "application/json;charset=utf-8"]) {
    expect(
      await client(refusing(type).socketPath).run({ script, files: [] }),
      type,
    ).toEqual({ ok: false, failure: "busy" });
    expect(await client(answering(type).socketPath).health(), type).toEqual({
      busy: false,
      boot: "fake",
    });
  }
  for (const type of ["text/html", "application/x-www-form-urlencoded", ""]) {
    expect(
      await client(refusing(type).socketPath).run({ script, files: [] }),
      type,
    ).toEqual({ ok: false, failure: "failed" });
    const unsaid = answering(type);
    expect(await client(unsaid.socketPath).health(), type).toBeNull();
    // And a daemon whose health is not believed is sent no run.
    expect(
      await client(unsaid.socketPath).run({ script, files: [] }),
      type,
    ).toEqual({ ok: false, failure: "unavailable" });
    expect(unsaid.asked(), type).toBe(0);
  }
});

test("a form with more parts than a run can have, or a part nobody named, is not passed on", async () => {
  const stray = (n: number) =>
    `Content-Disposition: form-data; name="p${n}"; filename="p${n}"\r\nContent-Type: application/octet-stream\r\n\r\nx`;
  const crowd = handBuilt([
    reportPart(),
    ...Array.from({ length: 10_000 }, (_, n) => stray(n)),
  ]);
  for (const [what, bytes] of [
    ["ten thousand parts", crowd],
    ["one part the report does not name", handBuilt([reportPart(), stray(0)])],
    ["the report twice", handBuilt([reportPart(), reportPart()])],
  ] as const) {
    const { socketPath } = fakeDaemon(
      () => new Response(bytes, { headers: FORM_TYPE }),
    );
    const { log, events } = recorded();
    expect(
      await createWorkbench({ key: KEY, socketPath, log }).run({
        script,
        files: [],
      }),
      what,
    ).toEqual({ ok: false, failure: "malformed" });
    expect(
      events.map(([event]) => event),
      what,
    ).toEqual(["workbench_answer_malformed"]);
  }
  // And the same form with nothing stray in it is a run: the hand-built one is not what is refused.
  const alone = fakeDaemon(
    () => new Response(handBuilt([reportPart()]), { headers: FORM_TYPE }),
  );
  expect(
    (
      await createWorkbench({
        key: KEY,
        socketPath: alone.socketPath,
        log: quiet,
      }).run({
        script,
        files: [],
      })
    ).ok,
  ).toBe(true);
});

test("a part with a megabyte of headers is not passed on", async () => {
  const heavy = handBuilt([reportPart(`; junk="${"h".repeat(MEBIBYTE)}"`)]);
  const { socketPath } = fakeDaemon(
    () => new Response(heavy, { headers: FORM_TYPE }),
  );
  const { log, events } = recorded();
  expect(
    await createWorkbench({ key: KEY, socketPath, log }).run({
      script,
      files: [],
    }),
  ).toEqual({ ok: false, failure: "malformed" });
  expect(events).toContainEqual([
    "workbench_answer_malformed",
    { reason: "form" },
  ]);
});

/*
 * WHO ANSWERS AT THE PATH IS PROVEN (the second independent read of 2026-10-06). A script runs as
 * the daemon's own user and can put a listener of its own where the daemon's socket was. Measured
 * on the service before this: this client's `health()` was answered by a script, and the run
 * waiting behind one that was given up on was handed — script and file — to a child that one had
 * left running, whose answer came back as the run, three times of three. Every fake above holds
 * the key; these are the ones that do not, or that prove the wrong thing.
 */

const next = {
  path: "uploads/next.csv",
  bytes: text("the next run's workbook"),
};

function text(value: string) {
  return new TextEncoder().encode(value);
}

test("what answers at the path without the key is believed about nothing, and is sent nothing", async () => {
  let received = 0;
  const taking = async (request: Request) => {
    received += (await request.arrayBuffer()).byteLength;
    return honest({ stdout: "a stranger answered" });
  };
  for (const [who, key] of [
    ["no key at all", null],
    ["another deployment's key", "another-deployment's-key-0123456789abcdef"],
  ] as const) {
    // It says what an idle daemon says, and answers a run as a run is answered.
    const stranger = fakeDaemon(taking, idle, { key });
    const { log, events } = recorded();
    const workbench = createWorkbench({
      key: KEY,
      socketPath: stranger.socketPath,
      log,
      marginMs: 120,
    });
    expect(await workbench.health(), who).toBeNull();
    const began = performance.now();
    expect(await workbench.run({ script, files: [next] }), who).toEqual({
      ok: false,
      failure: "unavailable",
    });
    // Asked again for as long as a daemon is given to clear up after a run, then given up on.
    expect(performance.now() - began, who).toBeGreaterThanOrEqual(110);
    expect(events, who).toContainEqual([
      "workbench_unreachable",
      { failure: "unavailable", reason: "unproven" },
    ]);
    // Not a byte of the run left this process.
    expect(stranger.asked(), who).toBe(0);
  }
  expect(received).toBe(0);
});

test("a proof is of one answer to one request: any other answer under it is not believed", async () => {
  /** The proof a daemon with the key would give, of something else than what is sent. */
  const proving = (
    how: (right: Parameters<typeof proofOf>[1]) => string | null,
    status = 200,
  ) =>
    fakeDaemon(
      async (request) => {
        const answer =
          status === 200
            ? honest()
            : Response.json({ code: "laf:workbench_busy" }, { status });
        const type = answer.headers.get("content-type") ?? "";
        const headers = new Headers(answer.headers);
        const body = new Uint8Array(await answer.arrayBuffer());
        const proof = how({
          route: routeOf(request),
          nonce: request.headers.get(NONCE_HEADER) ?? "",
          status,
          type,
          body,
        });
        if (proof !== null) headers.set(PROOF_HEADER, proof);
        return new Response(body, { status, headers });
      },
      idle,
      { bare: ["run"] },
    );
  const answered = async (fake: ReturnType<typeof fakeDaemon>) => {
    const { log, events } = recorded();
    const answer = await createWorkbench({
      key: KEY,
      socketPath: fake.socketPath,
      log,
    }).run({ script, files: [] });
    return { answer, events };
  };
  // The control: the right proof of the right thing is a run.
  expect(
    (await answered(proving((right) => proofOf(KEY, right)))).answer.ok,
  ).toBe(true);
  const wrong: [
    string,
    (right: Parameters<typeof proofOf>[1]) => string | null,
  ][] = [
    ["no proof", () => null],
    ["not a proof", () => "yes"],
    ["a proof under another key", (right) => proofOf(`${KEY}x`, right)],
    [
      "of another request",
      (right) => proofOf(KEY, { ...right, nonce: "0".repeat(32) }),
    ],
    [
      "of another route",
      (right) => proofOf(KEY, { ...right, route: "GET /health" }),
    ],
    ["of another status", (right) => proofOf(KEY, { ...right, status: 201 })],
    [
      "of another type",
      (right) =>
        proofOf(KEY, { ...right, type: "multipart/form-data; boundary=y" }),
    ],
    [
      "of other bytes",
      (right) =>
        proofOf(KEY, { ...right, body: new Uint8Array([...right.body, 0x0a]) }),
    ],
  ];
  for (const [what, how] of wrong) {
    const run = await answered(proving(how));
    expect(run.answer, what).toEqual({ ok: false, failure: "malformed" });
    expect(run.events, what).toEqual([
      ["workbench_answer_malformed", { reason: "unproven" }],
    ]);
    // A refusal nobody proved is not the daemon's word: no run, and no more is said of why.
    const refusal = await answered(proving(how, 503));
    expect(refusal.answer, what).toEqual({ ok: false, failure: "failed" });
  }
  // And the daemon's word, proven: busy.
  expect(
    (await answered(proving((right) => proofOf(KEY, right), 503))).answer,
  ).toEqual({ ok: false, failure: "busy" });
});

test("every request carries a number used once", async () => {
  const numbers: (string | null)[] = [];
  const { socketPath } = fakeDaemon(
    (request) => {
      numbers.push(request.headers.get(NONCE_HEADER));
      return honest();
    },
    (request) => {
      numbers.push(request.headers.get(NONCE_HEADER));
      return idle();
    },
  );
  const workbench = createWorkbench({ key: KEY, socketPath, log: quiet });
  await workbench.health();
  await workbench.run({ script, files: [] });
  await workbench.run({ script, files: [] });
  // Health, then for each run: who is there, and the run.
  expect(numbers).toHaveLength(5);
  expect(numbers.every(isNonce)).toBe(true);
  expect(new Set(numbers).size).toBe(5);
});

test("the run behind one that was given up on is not sent until the daemon, proven, says it has cleared up", async () => {
  let inFlight = false;
  let clearing = false;
  let sentMeanwhile = 0;
  const scripts: string[] = [];
  const { socketPath } = fakeDaemon(
    async (request) => {
      if (clearing) sentMeanwhile += 1;
      const form = await request.formData();
      const sent = await (form.get(SCRIPT_PART) as Blob).text();
      scripts.push(sent);
      if (sent !== "first") return honest({ stdout: sent });
      inFlight = true;
      // The caller gives up; and then ending what the run had started takes a while (the sweep).
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      clearing = true;
      await Bun.sleep(300);
      clearing = false;
      inFlight = false;
      return new Response(null, { status: 499 });
    },
    () => Response.json({ status: "ok", busy: inFlight, boot: "fake" }),
  );
  const workbench = createWorkbench({ key: KEY, socketPath, log: quiet });
  const gaveUp = new AbortController();
  const first = workbench.run({ script: "first", files: [] }, gaveUp.signal);
  const second = workbench.run({ script: "second", files: [next] });
  await Bun.sleep(100);
  const at = performance.now();
  gaveUp.abort();
  expect(await first).toEqual({ ok: false, failure: "stopped" });
  // The caller is told at once: the daemon's clearing up is not its wait.
  expect(performance.now() - at).toBeLessThan(150);
  const answer = await second;
  // What the fake was sent while it cleared up: nothing. It was the next run, whole.
  expect(sentMeanwhile).toBe(0);
  expect(answer.ok && answer.run.stdout).toBe("second");
  expect(performance.now() - at).toBeGreaterThanOrEqual(280);
  expect(scripts).toEqual(["first", "second"]);
});

test("an unproven voice saying it has cleared up lets nothing go", async () => {
  // The daemon is still ending what a run left; what that run left answers at the path meanwhile.
  let sent = 0;
  const stranger = fakeDaemon(
    async (request) => {
      sent += (await request.arrayBuffer()).byteLength;
      return honest();
    },
    idle,
    { key: null },
  );
  const workbench = createWorkbench({
    key: KEY,
    socketPath: stranger.socketPath,
    log: quiet,
    marginMs: 200,
  });
  const gaveUp = new AbortController();
  const behind = workbench.run({ script, files: [next] }, gaveUp.signal);
  await Bun.sleep(80);
  // Still asking who is there, and a caller that gives up meanwhile is told at once.
  const at = performance.now();
  gaveUp.abort();
  expect(await behind).toEqual({ ok: false, failure: "stopped" });
  expect(performance.now() - at).toBeLessThan(100);
  expect(sent).toBe(0);
});

test("a daemon still busy is waited for as long as it is given to clear up, and no longer", async () => {
  const busyFor = (ms: number) => {
    const until = performance.now() + ms;
    return fakeDaemon(
      () => honest(),
      () =>
        Response.json({
          status: "ok",
          busy: performance.now() < until,
          boot: "fake",
        }),
    );
  };
  const soon = busyFor(150);
  const began = performance.now();
  expect(
    (
      await createWorkbench({
        key: KEY,
        socketPath: soon.socketPath,
        log: quiet,
      }).run({ script, files: [] })
    ).ok,
  ).toBe(true);
  expect(performance.now() - began).toBeGreaterThanOrEqual(140);
  // One that stays busy past what it is given: `busy`, and the run was never sent.
  const never = busyFor(Number.POSITIVE_INFINITY);
  expect(
    await createWorkbench({
      key: KEY,
      socketPath: never.socketPath,
      log: quiet,
      marginMs: 100,
    }).run({ script, files: [] }),
  ).toEqual({ ok: false, failure: "busy" });
  expect(never.asked()).toBe(0);
});

/*
 * ONE SENDER, HELD BY SOMETHING (the third read of 2026-10-07). A proof is of the ANSWER. It says
 * neither who read the request nor that the daemon was sent it — so what keeps a run's bytes from
 * a script is that nothing a script started is at the path when they leave, and that rests on a
 * proven "idle" being still true when the run is sent. With two senders it need not be: one is
 * told "idle", the other's script starts and sits at the path, and the first then sends. The
 * reader showed the end of that with a listener standing for the second sender's script: it kept
 * a run's script and a 2 MB file, passed on only the number, and handed back the daemon's own
 * proven `busy` — and the client said `busy`, as of any other refusal.
 *
 * One process is the deployment's (one API server per VM). One client per path in it is this
 * file's to hold: `createWorkbench` was a factory, each client with a queue of its own.
 */
test("two callers in one process are one client: neither sends while the other's run is in flight", async () => {
  let inFlight = 0;
  let sentMeanwhile = 0;
  let asked = 0;
  // The first "who is there" is answered as of when it was asked — idle — and the answer is a
  // moment on its way: until the other caller's run has arrived, or a fifth of a second.
  let arrived: () => void = () => {};
  const otherArrived = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const { socketPath } = fakeDaemon(
    async (request) => {
      if (inFlight > 0) sentMeanwhile += 1;
      inFlight += 1;
      arrived();
      await request.arrayBuffer();
      await Bun.sleep(150);
      inFlight -= 1;
      return honest();
    },
    async () => {
      asked += 1;
      const said = Response.json({
        status: "ok",
        busy: inFlight > 0,
        boot: "fake",
      });
      if (asked === 1) await Promise.race([otherArrived, Bun.sleep(200)]);
      return said;
    },
  );
  const one = createWorkbench({ key: KEY, socketPath, log: quiet });
  const other = createWorkbench({ key: KEY, socketPath, log: quiet });
  // By construction, and then by what the far side saw.
  expect(other).toBe(one);
  const first = one.run({ script, files: [next] });
  const second = other.run({ script, files: [next] });
  expect([(await first).ok, (await second).ok]).toEqual([true, true]);
  // It was 1: the first caller, told "idle" a moment before, sent into the second's run.
  expect(sentMeanwhile).toBe(0);
});

test("one path has one key: a second client for it with another is a mistake, said at once", () => {
  const { socketPath } = fakeDaemon(() => honest());
  const one = createWorkbench({ key: KEY, socketPath, log: quiet });
  // The same path written another way is the same path.
  expect(
    createWorkbench({
      key: KEY,
      socketPath: join(socketPath, "..", "w.sock"),
      log: quiet,
    }),
  ).toBe(one);
  expect(() =>
    createWorkbench({ key: `${KEY}-another`, socketPath, log: quiet }),
  ).toThrow("one key");
});

/*
 * NOTHING AT THE PATH IS A DAEMON BETWEEN TWO LIVES, FOR A FEW SECONDS (the third read, LOW 1). A
 * daemon that retired, or stopped because a script had been at its socket, is back in a quarter of
 * a second to a second; "nobody there" used to be `unavailable` at once, which is what the run
 * behind an abandoned one was told every time, and any run that met a restart.
 *
 * A DAEMON THAT WAS THERE, since 2026-10-07: the wait is for one that has been seen at this path
 * (the tests at the end of this file — where none ever was, there is nothing to wait for). The
 * one that does not come back, and the end of its wait, are held there too.
 */
test("a daemon that was there and is back within a few seconds is used", async () => {
  const first = fakeDaemon(() =>
    honest({ stdout: "the daemon that was there" }),
  );
  const { socketPath } = first;
  const workbench = createWorkbench({
    key: KEY,
    socketPath,
    log: quiet,
    absentMs: 2_000,
  });
  // Seen: one proven answer at this path.
  expect(await workbench.health()).toEqual({ busy: false, boot: "fake" });
  // It goes, and leaves what a daemon that has just gone leaves at its path: a socket's file
  // with nobody behind it.
  await first.server.stop(true);
  rmSync(socketPath, { force: true });
  writeFileSync(socketPath, "");
  const began = performance.now();
  const waiting = workbench.run({ script, files: [next] });
  await Bun.sleep(300);
  // The next daemon: it clears what was at its path and binds.
  rmSync(socketPath);
  const back = fakeDaemon(
    () => honest({ stdout: "the daemon that came back" }),
    idle,
    {
      at: socketPath,
    },
  );
  const answer = await waiting;
  expect(answer.ok && answer.run.stdout).toBe("the daemon that came back");
  expect(performance.now() - began).toBeGreaterThanOrEqual(290);
  expect(back.asked()).toBe(1);
});

test("whatever is at the path, and however it changes, a caller is answered within the two waits together", async () => {
  const root = mkdtempSync(join(tmpdir(), "wc-"));
  opened.push({ stop: () => {}, root });
  const socketPath = join(root, "flap.sock");
  // A stranger that comes and goes: there (and proving nothing) for 60 ms, gone for 60 ms, for ever.
  let stopped = false;
  let sent = 0;
  const flapping = (async () => {
    while (!stopped) {
      const stranger = Bun.serve({
        unix: socketPath,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/health") {
            sent += (await request.arrayBuffer()).byteLength;
          }
          return idle();
        },
      });
      await Bun.sleep(60);
      await stranger.stop(true);
      rmSync(socketPath, { force: true });
      await Bun.sleep(60);
    }
  })();
  try {
    const began = performance.now();
    expect(
      await createWorkbench({
        key: KEY,
        socketPath,
        log: quiet,
        marginMs: 300,
        absentMs: 200,
      }).run({ script, files: [next] }),
    ).toEqual({ ok: false, failure: "unavailable" });
    // 300 ms of something there and 200 ms of nothing, at the very most — and a knock in hand.
    expect(performance.now() - began).toBeLessThan(300 + 200 + 1_000);
    expect(sent).toBe(0);
  } finally {
    stopped = true;
    await flapping;
  }
});

/*
 * WHAT THE FOURTH READ LEFT FOR THE CHANGE THAT ADDS A CALLER (2026-10-07; none of it was reachable
 * while nothing called this). That change is the gateway's act (`computer/gateway/acts.ts`,
 * `runScript`), and each test below failed on the client as that read found it.
 */

/*
 * "ONE CLIENT PER PATH" WAS LEXICAL. The registry was keyed by `resolve()`, which makes `./` and
 * `//` one spelling and knows nothing of the filesystem: the same socket reached through a link to
 * its directory — on Debian `/var/run/…` is that spelling of `/run/…` — was a second client with a
 * queue of its own, and two queues are one caller told "idle" while the other's script runs. And
 * the test that meant to try "written another way" passed a string `join` had already made
 * identical. Written here as strings nothing has tidied.
 */
test("one socket has one client, however the path to it is written: `./`, `//`, relative, or through a link to its directory", async () => {
  const { socketPath } = fakeDaemon(() => honest());
  const directory = join(socketPath, "..");
  const one = createWorkbench({ key: KEY, socketPath, log: quiet });

  expect(
    createWorkbench({
      key: KEY,
      socketPath: `${directory}/./w.sock`,
      log: quiet,
    }),
  ).toBe(one);
  expect(
    createWorkbench({
      key: KEY,
      socketPath: `${directory}//w.sock`,
      log: quiet,
    }),
  ).toBe(one);
  expect(
    createWorkbench({
      key: KEY,
      socketPath: relative(process.cwd(), socketPath),
      log: quiet,
    }),
  ).toBe(one);
  // Another name for the same directory. It was a second client: `toBe` failed here.
  const link = `${directory}-link`;
  symlinkSync(directory, link);
  opened.push({ stop: () => {}, root: link });
  const through = createWorkbench({
    key: KEY,
    socketPath: `${link}/w.sock`,
    log: quiet,
  });
  expect(through).toBe(one);
  // And it is the socket's own path that is one client's — another socket beside it is another's.
  expect(
    createWorkbench({ key: KEY, socketPath: `${link}/other.sock`, log: quiet }),
  ).not.toBe(one);
  expect((await through.run({ script, files: [] })).ok).toBe(true);
});

test("a socket in a directory that is not there has no client: where it really is cannot be said", () => {
  const root = mkdtempSync(join(tmpdir(), "wc-"));
  opened.push({ stop: () => {}, root });
  expect(() =>
    createWorkbench({
      key: KEY,
      socketPath: join(root, "not-made", "w.sock"),
      log: quiet,
    }),
  ).toThrow("cannot (ENOENT)");
});

/*
 * THE CLIENT TOOK ANY STRING AS ITS KEY, while the daemon holds its own to what a key is and does
 * not start without one. A client made with an empty or a short one would have asked a daemon it
 * could never believe, and the mistake would have shown only as a service that proves nothing.
 */
test("a client's key is held to what a key is, as the daemon's is — and is never said back", () => {
  const { socketPath } = fakeDaemon(() => honest());
  for (const key of ["", "short", "x".repeat(31)]) {
    let said = "";
    try {
      createWorkbench({ key, socketPath, log: quiet });
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    expect({ key: key.length, refused: said.includes("key") }).toEqual({
      key: key.length,
      refused: true,
    });
    if (key) expect(said).not.toContain(key);
  }
  // Thirty-two characters is one.
  expect(() =>
    createWorkbench({ key: "x".repeat(32), socketPath, log: quiet }),
  ).not.toThrow();
});

/*
 * A SECOND CALLER'S BOUNDS, WAITS AND LOG WERE DROPPED WITHOUT A WORD. It was handed the first
 * caller's client — rightly — and what it had asked for besides the path was not looked at: a
 * caller that meant its runs to be held to smaller bounds, or to be written to its own log, got
 * neither and was not told. Like another key, it is a mistake said at once.
 */
test("a second caller that asks for other bounds, other waits or another log is refused, as for another key", () => {
  const { socketPath } = fakeDaemon(() => honest());
  const first = {
    key: KEY,
    socketPath,
    log: quiet,
    limits: { ...WORKBENCH_LIMITS, files: 2 },
    marginMs: 500,
    absentMs: 300,
  };
  const one = createWorkbench(first);
  // The same again — written out again, not the same object — is the same client.
  expect(
    createWorkbench({ ...first, limits: { ...WORKBENCH_LIMITS, files: 2 } }),
  ).toBe(one);

  const other: Logger = { svc: "other", info() {}, warn() {}, error() {} };
  const differing: [string, Parameters<typeof createWorkbench>[0]][] = [
    ["other bounds", { ...first, limits: { ...WORKBENCH_LIMITS, files: 3 } }],
    [
      "the bounds it would have by default",
      { key: KEY, socketPath, log: quiet, marginMs: 500, absentMs: 300 },
    ],
    ["another margin", { ...first, marginMs: 501 }],
    [
      "the margin it would have by default",
      { key: KEY, socketPath, log: quiet, limits: first.limits, absentMs: 300 },
    ],
    ["another wait for an absent daemon", { ...first, absentMs: 301 }],
    ["another log", { ...first, log: other }],
  ];
  for (const [what, options] of differing) {
    let said = "";
    try {
      createWorkbench(options);
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    expect({ what, refused: said !== "" }).toEqual({ what, refused: true });
  }
});

/*
 * THE WAIT FOR A DAEMON BETWEEN TWO LIVES WAS PAID WHERE NO DAEMON HAD EVER LIVED. Nothing at the
 * path is waited for a few seconds, because a daemon that has just gone is back within that — and
 * on a deployment that has no such service every run paid those seconds, and each run waiting
 * behind it paid them again in turn. So the wait is for a daemon that HAS been there: one proven
 * answer at this path, in this process — `health()`, or any run's own knock. Before that, nobody
 * there is `unavailable` at once.
 */
test("where the daemon has never answered, nothing at the path costs a run no wait — nor the runs queued behind it", async () => {
  const root = mkdtempSync(join(tmpdir(), "wc-"));
  opened.push({ stop: () => {}, root });
  const { log, events } = recorded();
  const workbench = createWorkbench({
    key: KEY,
    socketPath: join(root, "never.sock"),
    log,
    absentMs: 1_500,
  });
  const began = performance.now();
  const answers = await Promise.all(
    [1, 2, 3].map(() => workbench.run({ script, files: [next] })),
  );
  const waited = performance.now() - began;

  expect(answers).toEqual([
    { ok: false, failure: "unavailable" },
    { ok: false, failure: "unavailable" },
    { ok: false, failure: "unavailable" },
  ]);
  // It was three waits, one after another: four and a half seconds here, twelve on a server.
  expect(waited).toBeLessThan(700);
  expect(events).toEqual([
    ["workbench_unreachable", { failure: "unavailable", reason: "never_seen" }],
    ["workbench_unreachable", { failure: "unavailable", reason: "never_seen" }],
    ["workbench_unreachable", { failure: "unavailable", reason: "never_seen" }],
  ]);
});

test("where the daemon has answered once, by `health()` alone, nothing at the path is waited for as before", async () => {
  const daemon = fakeDaemon(() => honest());
  const { log, events } = recorded();
  const workbench = createWorkbench({
    key: KEY,
    socketPath: daemon.socketPath,
    log,
    absentMs: 250,
  });
  // Seen, and never asked to run anything.
  expect(await workbench.health()).toEqual({ busy: false, boot: "fake" });
  await daemon.server.stop(true);

  const at = performance.now();
  expect(await workbench.run({ script, files: [next] })).toEqual({
    ok: false,
    failure: "unavailable",
  });
  const waited = performance.now() - at;
  expect(waited).toBeGreaterThanOrEqual(240);
  expect(waited).toBeLessThan(1_500);
  expect(events).toEqual([
    ["workbench_unreachable", { failure: "unavailable", reason: "nobody" }],
  ]);
});
