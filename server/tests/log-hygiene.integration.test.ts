import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

/**
 * What an operator's log actually contains after a whole turn, and what it must not.
 *
 * The other tests in this area prove the logger's shape and the source's discipline. Neither can
 * see what a running deployment writes: the CopilotKit runtime, the OpenAI client, Drizzle and Bun
 * itself all print on their own account, and a `console.error("…", error)` somewhere nobody
 * grepped prints the error object whole. So this starts the two processes an operator reads —
 * the API server and `agent-bot` — as subprocesses, points the Bot service at a fake provider
 * served from this file, drives one turn through the API the way a room or a coworker call would,
 * and then reads every byte both processes wrote.
 *
 * Three canaries, placed where a leak would carry them:
 *
 *   - the model key, in both services' environment, which the Bot service sends to the provider
 *     as `Authorization: Bearer …` on every request (the fake checks that it arrived);
 *   - the person's message, which names a password, and which travels through the runtime, the
 *     thread store and the provider request;
 *   - the provider's own error body, on a second turn the fake answers with a 429, which the
 *     OpenAI client folds into its error message.
 *
 * None of them may appear in the log. Every line must parse as one JSON object carrying `level`,
 * `at`, `svc` and `event`. And the lines the plan asks for must be there: a `boot` per service
 * with the build and the model, a `run_failed` whose reason is `provider_rate_limited` rather than
 * the provider's sentence, and a `shutdown` with its reason once each process is told to stop.
 *
 * Needs the test database, like every other integration test here: the server boots against
 * `DATABASE_URL`, which `scripts/test-ci.ts` has already pointed at `<name>_test`.
 */

const root = resolve(import.meta.dir, "../..");

/** The key. Never valid anywhere; distinctive enough that a grep for it means something. */
const CANARY_KEY = "sk-canary-0f3c9a7e2b1d4c6e8a0b7c5d";
/** The person's message. The digits are chosen so no port, id or timestamp can contain them. */
const CANARY_SECRET = "7391-5528";
const CANARY_MESSAGE = `내 계좌 비밀번호는 ${CANARY_SECRET}이야. 기억해 둬.`;
/** What the provider says when it refuses. The vendor's name and URL are the point. */
const CANARY_VENDOR = "canary-vendor-prose: model glm-9 at openrouter.example";
const MODEL = "laf-canary-model";
const IMAGE_TAG = "canary-build";
const REPLY = "네, 알겠습니다.";

/** The example key from .env.example, which the server warns about and accepts outside production. */
const EXAMPLE_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

type Line = Record<string, unknown> & { raw: string };

/** One subprocess and everything it wrote, line by line, as it wrote it. */
class Captured {
  readonly lines: string[] = [];
  private waiters: Array<() => void> = [];
  constructor(readonly process: ReturnType<typeof Bun.spawn>) {
    for (const stream of [process.stdout, process.stderr]) {
      if (stream && typeof stream !== "number") void this.drain(stream);
    }
  }

  private async drain(stream: ReadableStream<Uint8Array>) {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        this.lines.push(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      for (const wake of this.waiters.splice(0)) wake();
    }
    if (pending) this.lines.push(pending);
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Every line that parses as JSON, with the raw text kept beside it. */
  parsed(): Line[] {
    return this.lines
      .filter((line) => line.trim().length > 0)
      .map((raw) => {
        try {
          return { ...(JSON.parse(raw) as Record<string, unknown>), raw };
        } catch {
          return { raw };
        }
      });
  }

  /** The first line with this event, or a wait for it. */
  async event(name: string, timeoutMs = 30_000): Promise<Line> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.parsed().find((line) => line.event === name);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `No "${name}" line within ${timeoutMs}ms. Output so far:\n${this.lines.join("\n")}`,
        );
      }
      await new Promise<void>((wake) => {
        this.waiters.push(wake);
        setTimeout(wake, 200);
      });
    }
  }
}

/** The provider, as much of it as one turn needs. */
let provider: ReturnType<typeof Bun.serve>;
/** What the next completion request is answered with. */
let providerMode: "answer" | "rate_limit" = "answer";
/** Whether the canary key ever reached the provider, which is what makes the grep meaningful. */
let providerSawKey = false;

let bot: Captured | undefined;
let server: Captured | undefined;
let api = "";

const sse = (chunks: object[]) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  return (await response.json()) as T;
}

function spawn(cwd: string, env: Record<string, string>): Captured {
  return new Captured(
    Bun.spawn(["bun", "src/index.ts"], {
      cwd,
      // Only what is named: the developer's own environment — a real key in `.env`, an
      // `OPENAI_BASE_URL` pointing at a real provider — must not reach either process.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
}

beforeAll(async () => {
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      if (request.headers.get("authorization") === `Bearer ${CANARY_KEY}`) {
        providerSawKey = true;
      }
      const body = (await request.json()) as { stream?: boolean };
      if (providerMode === "rate_limit") {
        return Response.json(
          { error: { message: CANARY_VENDOR, type: "rate_limit_error" } },
          { status: 429 },
        );
      }
      const usage = {
        prompt_tokens: 40,
        completion_tokens: 6,
        total_tokens: 46,
      };
      if (body.stream) {
        return new Response(
          sse([
            {
              id: "chatcmpl-1",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: REPLY },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chatcmpl-1",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage,
            },
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      // The server's auto-review probe at boot asks without streaming and wants JSON back.
      return Response.json({
        choices: [
          { message: { content: '{"allowed": true, "reason": "yes"}' } },
        ],
        usage,
      });
    },
  });
  const providerUrl = `http://127.0.0.1:${provider.port}/v1`;

  bot = spawn(resolve(root, "agent-bot"), {
    PORT: "0",
    OPENAI_API_KEY: CANARY_KEY,
    OPENAI_BASE_URL: providerUrl,
    BOT_MODEL: MODEL,
    IMAGE_TAG,
  });
  const botBoot = await bot.event("boot");

  server = spawn(resolve(root, "server"), {
    PORT: "0",
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    KEY_ENCRYPTION_KEY: EXAMPLE_ENCRYPTION_KEY,
    TENANT_PACKAGE_DIR: "../tenant/laf",
    LAF_DEV_NO_AUTH: "true",
    TRUSTED_ORIGINS: "http://localhost:3010",
    MANAGED_AGENT_AG_UI_URL: `http://127.0.0.1:${botBoot.port}/ag-ui`,
    OPENAI_API_KEY: CANARY_KEY,
    OPENAI_BASE_URL: providerUrl,
    BOT_MODEL: MODEL,
    // Room for this file's two Bots beside whatever else the shared test database holds.
    BOT_SEATS_PER_ACCOUNT: "50",
    AUDIT_RETENTION_DAYS: "0",
    IMAGE_TAG,
  });
  const serverBoot = await server.event("boot", 60_000);
  api = `http://127.0.0.1:${serverBoot.port}`;
}, 90_000);

afterAll(async () => {
  provider?.stop(true);
  // `LOG_HYGIENE_DUMP=1 bun test …` prints what both processes wrote, which is the quickest way to
  // read a whole turn's worth of lines when changing what a line says.
  if (process.env.LOG_HYGIENE_DUMP) {
    for (const captured of [server, bot]) {
      for (const line of captured?.lines ?? []) console.log(line);
    }
  }
  for (const captured of [server, bot]) {
    if (!captured || captured.process.exitCode !== null) continue;
    captured.process.kill("SIGKILL");
    await captured.process.exited;
  }
});

/** Every line both processes wrote, in order, as one text and as parsed lines. */
function everything(): { text: string; lines: Line[] } {
  const lines = [...(server?.parsed() ?? []), ...(bot?.parsed() ?? [])];
  return { text: lines.map((line) => line.raw).join("\n"), lines };
}

const askerName = `Log canary asker ${Date.now()}`;
const answererName = `Log canary answerer ${Date.now()}`;
const made: string[] = [];

async function makeBot(name: string): Promise<string> {
  const { agent } = await json<{ agent: { id: string } }>("/api/agents", {
    method: "POST",
    body: JSON.stringify({
      name,
      title: "Log hygiene",
      roleDescription:
        "Made by log-hygiene.integration.test.ts. Safe to delete.",
      visibility: "private",
    }),
  });
  made.push(agent.id);
  return agent.id;
}

afterAll(async () => {
  if (!api) return;
  for (const id of made) {
    await fetch(`${api}/api/agents/${id}`, { method: "DELETE" }).catch(
      () => null,
    );
  }
});

describe("a running deployment's log", () => {
  test("carries a whole turn through the API and the Bot service without the key, the message or the provider's words", async () => {
    const asker = await makeBot(askerName);
    const answerer = await makeBot(answererName);

    // The turn: one Bot asks another, which runs the answerer through the runtime, through
    // `agent-bot`, to the fake provider and back. The answer is the proof that it went the whole way.
    const { answer } = await json<{ answer: string }>(
      `/api/agents/${answerer}/ask`,
      {
        method: "POST",
        body: JSON.stringify({ message: CANARY_MESSAGE, from: asker }),
      },
    );
    expect(answer).toContain(REPLY);
    expect(providerSawKey).toBe(true);
    const finished = await bot!.event("run_finished");
    expect(typeof finished.tools).toBe("number");

    // The refusal: the same turn again, answered with a 429 whose body names a vendor.
    providerMode = "rate_limit";
    const refused = await fetch(`${api}/api/agents/${answerer}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: CANARY_MESSAGE, from: asker }),
    });
    // Whatever the route answers with — a 502, or a 200 saying the coworker said nothing — it is
    // not the answer, and it is not the provider's sentence either.
    const refusedBody = await refused.text();
    expect(refusedBody).not.toContain(REPLY);
    expect(refusedBody).not.toContain(CANARY_VENDOR);
    const failed = await bot!.event("run_failed");
    expect(failed.reason).toBe("provider_rate_limited");
    expect(failed.code).toBe("laf:model_rate_limited");
    expect(failed.bot).toBe(answerer);

    const { text, lines } = everything();

    // Nothing that was in the environment, the message or the provider's answer.
    expect(text).not.toContain(CANARY_KEY);
    expect(text).not.toContain("sk-canary");
    expect(text).not.toContain(CANARY_SECRET);
    expect(text).not.toContain("비밀번호");
    expect(text).not.toContain(CANARY_VENDOR);
    expect(text).not.toContain("canary-vendor");
    expect(text).not.toContain("openrouter.example");
    // No header, no cookie, no connection string with its password, no SQL, no stack frame.
    expect(text).not.toMatch(/bearer/i);
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toMatch(/cookie/i);
    expect(text).not.toContain("openbot:openbot@");
    expect(text).not.toMatch(
      /\b(select|insert into|update|delete from)\b[^"]*\b(from|values|set|where)\b/i,
    );
    expect(text).not.toMatch(/^\s+at /m);

    // Every line is one JSON object with the four fields, from one of the two services.
    const bare = lines.filter((line) => line.event === undefined);
    expect(bare.map((line) => line.raw)).toEqual([]);
    for (const line of lines) {
      expect(["info", "warn", "error"]).toContain(String(line.level));
      expect(["server", "agent-bot"]).toContain(String(line.svc));
      expect(line.event).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(Date.parse(String(line.at))).not.toBeNaN();
    }
  }, 120_000);

  test("says which build, which model and how many tools at boot", async () => {
    const serverBoot = await server!.event("boot");
    expect(serverBoot.version).toBe(IMAGE_TAG);
    expect(serverBoot.model).toBe(MODEL);
    expect(serverBoot.tools).toBeGreaterThan(0);
    expect(serverBoot.computer).toBe("none");

    const botBoot = await bot!.event("boot");
    expect(botBoot.version).toBe(IMAGE_TAG);
    expect(botBoot.model).toBe(MODEL);
    expect(botBoot.baseUrl).toContain("127.0.0.1");
  });

  test("says why it stopped when it is told to", async () => {
    for (const captured of [server!, bot!]) {
      captured.process.kill("SIGTERM");
      const stopped = await captured.event("shutdown", 15_000);
      expect(stopped.reason).toBe("SIGTERM");
      expect(await captured.process.exited).toBe(0);
    }
  }, 40_000);
});
