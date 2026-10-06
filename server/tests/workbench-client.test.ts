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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../shared/log";
import {
  type InvalidField,
  JOB_PART,
  REPORT_PART,
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

/** A daemon that answers every `/run` with whatever `answer` makes of the request. */
function fakeDaemon(
  answer: (request: Request) => Response | Promise<Response>,
  health: () => Response = () => Response.json({ status: "ok", busy: false }),
) {
  const root = mkdtempSync(join(tmpdir(), "wc-"));
  const socketPath = join(root, "w.sock");
  let asked = 0;
  const server = Bun.serve({
    unix: socketPath,
    fetch(request) {
      if (new URL(request.url).pathname === "/health") return health();
      asked += 1;
      return answer(request);
    },
  });
  opened.push({ stop: () => server.stop(true), root });
  return { socketPath, asked: () => asked, server };
}

/** A report a real daemon could have sent, and the parts it names. */
function honest(
  report: Record<string, unknown> = {},
  parts: Record<string, string> = {},
): Response {
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
      stdoutBytes: 0,
      stderrBytes: 0,
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
  const answer = await createWorkbench({ socketPath, log: quiet }).run({
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
  await createWorkbench({ socketPath, log: quiet }).run({
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
      await createWorkbench({ socketPath, log: quiet }).run({
        script,
        files: [],
      }),
    ).toEqual({ ok: false, failure: "malformed" });
  });
}

test("files that fit one by one and not together are not passed on either", async () => {
  const { socketPath } = fakeDaemon(() =>
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
      socketPath,
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
    return createWorkbench({ socketPath, log: quiet }).run({
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
  // Bun's own refusal of a body over the daemon's bound, which carries no code of ours.
  expect(await told(new Response("too large", { status: 413 }))).toEqual({
    ok: false,
    failure: "invalid",
    field: "files",
  });
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
    socketPath: join(root, "none.sock"),
    log: quiet,
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
      socketPath: join(root, "stale.sock"),
      log: quiet,
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
    await createWorkbench({ socketPath: daemon.socketPath, log: quiet }).run({
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
    await createWorkbench({ socketPath, log: quiet, marginMs: 100 }).run({
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
  const workbench = createWorkbench({ socketPath, log: quiet });
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
  const workbench = createWorkbench({ socketPath, log: quiet });
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

test("health says whether the service answers and whether it is running something", async () => {
  let body: unknown = { status: "ok", busy: true, boot: "abc" };
  const { socketPath } = fakeDaemon(
    () => honest(),
    () => Response.json(body),
  );
  const workbench = createWorkbench({ socketPath, log: quiet });
  expect(await workbench.health()).toEqual({ busy: true });
  body = { status: "ok", busy: false };
  expect(await workbench.health()).toEqual({ busy: false });
  // Anything that is not that shape is no answer.
  for (const other of [{ status: "ok" }, { status: "no", busy: false }, []]) {
    body = other;
    expect(await workbench.health()).toBeNull();
  }
});
