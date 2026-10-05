import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { AuditEventInput } from "../src/audit";
import type { DeploymentConfig } from "../src/config";
import type { Database } from "../src/db/client";
import { createServerModelCalls } from "../src/server-model-calls";
import { stubFetch } from "./support/fetch";

/**
 * WHO EACH JUDGE ASKS, HOW LONG IT WAITS, AND WHOSE NAME THE TOKENS GO UNDER.
 *
 * Four judges are built to one arrangement in `server-model-calls.ts` — Jev when the switch is on,
 * the server model in Jev's shape behind it or alone — and two more calls go to the server model by
 * themselves. What differs between them is a handful of facts, and each of those facts is somebody's
 * wait or somebody's bill: the two seconds a person stands in front of a press, the ten a mail is
 * held for, the name a call's tokens are counted under in a trial's day.
 *
 * So the facts are written down here, per judge, and read back off what actually leaves: the
 * request (which door, which model, with what effort), the bound the call was armed with, the
 * purpose in the log line, and the source on the `model.usage` row. Written before the arrangement
 * was said once instead of four times, and passing on both sides of that change.
 *
 * No network: `fetch` is a recorder, and the provider's address is never resolved.
 */

const SERVER_MODEL = "laf-small";
const DECISION_MODEL = "typesafe/jev-1.13-20260917";
const PROVIDER = "https://provider.test/v1";
const OPENROUTER_ORIGIN = "https://openrouter.ai/";
const OPENROUTER = `${OPENROUTER_ORIGIN}api/v1`;

/** The four judges, and what is each one's own. Milliseconds. */
const JUDGES = {
  compaction: { jevMs: 15_000, standInMs: 90_000 },
  memory: { jevMs: 10_000, standInMs: 30_000 },
  "mail-secrets": { jevMs: 3_000, standInMs: 10_000 },
  "high-risk": { jevMs: 2_000, standInMs: 10_000 },
} as const;
type Judge = keyof typeof JUDGES;
const EVERY_JUDGE = Object.keys(JUDGES) as Judge[];

type Left = {
  door: "server-model" | "jev";
  url: string;
  model: unknown;
  effort: unknown;
  key: string | null;
};

/** Everything one ask left behind it. */
let left: Left[] = [];
/** The bounds `askModel` armed (`AbortSignal.timeout`), in the order they were armed. */
let modelBounds: number[] = [];
/** The bound each question to Jev was put with: the `timeout` of the client it went through. */
let jevBounds: number[] = [];
let usageSources: unknown[] = [];
let logged: Record<string, unknown>[] = [];
/** What the decisions door answers with. A status that is not 200 is Jev unable to answer. */
let jevStatus = 200;

const realFetch = globalThis.fetch;
const spies: { mockRestore: () => void }[] = [];

beforeEach(() => {
  left = [];
  modelBounds = [];
  jevBounds = [];
  usageSources = [];
  logged = [];
  jevStatus = 200;

  /*
   * BY WHO ARMED IT, NOT ONLY BY WHEN. `AbortSignal.timeout` is the process's own, and every test
   * file of this workspace runs in one process: a bound another file's call armed would land in
   * this list as surely as this file's own. So one is kept only when the code that armed it is
   * the one being measured, `askModel`.
   */
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  spies.push(
    spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      if ((new Error().stack ?? "").includes("computer/model-call")) {
        modelBounds.push(ms);
      }
      return realTimeout(ms);
    }),
  );
  /*
   * JEV'S BOUND, OFF THE CLIENT THE QUESTION WENT THROUGH. `timeout` is the SDK's own public word
   * for how long an attempt may take and `systemOne` is its one door, so the bound is read where
   * the SDK promises it, and the call goes on as it was. It was read off the SDK's timer once, by
   * the stack that armed it: true, and one SDK release away from failing on an empty list, which
   * says nothing about this server.
   */
  const realSystemOne = TypeSafeClient.prototype.systemOne;
  spies.push(
    spyOn(TypeSafeClient.prototype, "systemOne").mockImplementation(function (
      this: TypeSafeClient,
      ...asked: Parameters<typeof realSystemOne>
    ) {
      jevBounds.push(this.timeout);
      return realSystemOne.apply(this, asked);
    } as typeof realSystemOne),
  );
  // The log is one JSON line a call, on the console: read, and kept off the test's own output.
  for (const level of ["log", "warn", "error"] as const) {
    spies.push(
      spyOn(console, level).mockImplementation((line: unknown) => {
        try {
          logged.push(JSON.parse(String(line)) as Record<string, unknown>);
        } catch {
          // Not one of the log's own lines.
        }
      }),
    );
  }

  globalThis.fetch = stubFetch(async (url, init) => {
    const target = String(url);
    // Only the two addresses a call here is given. Anything else is somebody else's request.
    if (!target.startsWith(PROVIDER) && !target.startsWith(OPENROUTER_ORIGIN)) {
      return realFetch(url, init);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    const headers = new Headers(init?.headers);
    const key = headers.get("authorization");
    if (target.endsWith("/v1/systemone")) {
      left.push({
        door: "jev",
        url: target,
        model: body.model,
        effort: null,
        key,
      });
      if (jevStatus !== 200) {
        return Response.json(
          { error: { message: "no" } },
          { status: jevStatus },
        );
      }
      const questions = (body.questions ?? {}) as Record<string, unknown>;
      return Response.json({
        id: "d1",
        model: DECISION_MODEL,
        provider: "TypeSafe",
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => [
            name,
            { type: "noul", noul: 0.5 },
          ]),
        ),
        usage: { input_tokens: 30, output_tokens: 2 },
      });
    }
    left.push({
      door: "server-model",
      url: target,
      model: body.model,
      effort: body.reasoning_effort ?? null,
      key,
    });
    // A judge is asked `{ state, questions }` and answers a probability a name; anything else that
    // reaches the server model here is the day's summary, which is prose.
    const asked = JSON.parse(
      String((body.messages as { content: string }[])[1]?.content ?? "{}"),
    ) as { questions?: Record<string, unknown> };
    const content = asked.questions
      ? JSON.stringify(
          Object.fromEntries(
            Object.keys(asked.questions).map((name) => [name, 0.5]),
          ),
        )
      : "어제는 주문 두 건을 확인했다.";
    return Response.json({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function calls(options: {
  /** The switch. Left out, the deployment has no harness block at all, which is the switch off. */
  jev?: boolean;
  effort?: boolean;
  /** Where the model is served, when it is not where the switch alone would put it. */
  baseUrl?: string;
}) {
  return createServerModelCalls({
    // Only `autoReviewFor` reads the database, and no judge here is the auto-review.
    database: {} as Database,
    auditStore: {
      insert: async (event: AuditEventInput) => {
        usageSources.push((event.payload as { source?: unknown }).source);
      },
    },
    credentials: { readModelSecret: async () => null },
    encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    endpoint: {
      baseUrl: options.baseUrl ?? (options.jev ? OPENROUTER : PROVIDER),
      apiKey: "sk-test",
    },
    model: {
      provider: "openai",
      credentialSecretRef: "model:openai",
      defaultModel: "laf-1",
      supportsEffort: false,
      serverModel: SERVER_MODEL,
      serverModelSupportsEffort: options.effort ?? true,
      reviewModel: "laf-review",
      decisionModel: DECISION_MODEL,
    },
    harness:
      options.jev === undefined
        ? undefined
        : ({
            jevEnabled: options.jev,
            compaction: "decisions",
          } as DeploymentConfig["harness"]),
  });
}

const QUESTIONS = { q: { type: "noul" as const, instructions: "Is it so?" } };

/** A conversation with something behind it to decide about: pages read, then two more turns. */
const CONVERSATION = [
  { id: "u0", role: "user", content: "주문 관리 좀 봐줘" },
  ...["c1", "c2", "c3"].flatMap((id) => [
    {
      id: `a_${id}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id,
          type: "function",
          function: { name: "computer_read", arguments: "{}" },
        },
      ],
    },
    {
      id: `t_${id}`,
      role: "tool",
      toolCallId: id,
      content: JSON.stringify({
        ok: true,
        url: `https://shop.example.test/orders/${id}`,
        title: "주문 목록",
        text: "주문 목록 ".repeat(400),
      }),
    },
  ]),
  { id: "s1", role: "assistant", content: "주문 목록을 확인했습니다." },
  { id: "u1", role: "user", content: "고마워. 환불 건만 다시 알려줘." },
  { id: "s2", role: "assistant", content: "환불 건은 한 건입니다." },
  { id: "u2", role: "user", content: "짧게." },
];

/** One question put to one judge, whichever way that judge is reached. */
async function ask(made: ReturnType<typeof calls>, judge: Judge) {
  switch (judge) {
    case "compaction":
      return made.compactor?.(CONVERSATION as never);
    case "memory":
      return made.memoryAsker.ask({ fact: "월요일은 쉰다" }, QUESTIONS);
    case "mail-secrets":
      return made.mailSecretJudge.ask(
        { around: "인증번호는 ▢▢▢▢▢▢" },
        QUESTIONS,
      );
    case "high-risk":
      return made.highRiskAsker.ask({ page: "결제" }, QUESTIONS);
  }
}

const purposesLogged = () =>
  logged
    .filter((line) => Object.values(line).includes("jev_consulted"))
    .map((line) => line.purpose);

describe("a judge with Jev off", () => {
  test("asks the server model alone, inside its own bound, and files the tokens under its own name", async () => {
    for (const judge of EVERY_JUDGE) {
      left = [];
      modelBounds = [];
      usageSources = [];
      await ask(calls({ jev: false }), judge);
      await Promise.resolve();

      expect({ judge, left }).toEqual({
        judge,
        left: [
          {
            door: "server-model",
            url: `${PROVIDER}/chat/completions`,
            model: SERVER_MODEL,
            effort: "low",
            key: "Bearer sk-test",
          },
        ],
      });
      expect({ judge, bounds: modelBounds }).toEqual({
        judge,
        bounds: [JUDGES[judge].standInMs],
      });
      expect({ judge, sources: usageSources }).toEqual({
        judge,
        sources: [judge],
      });
    }
    // The switch is the privacy switch: off, nothing is said to have consulted Jev.
    expect(purposesLogged()).toEqual([]);
  });

  test("sends no effort to a server model that takes none", async () => {
    for (const judge of EVERY_JUDGE) {
      left = [];
      await ask(calls({ jev: false, effort: false }), judge);
      expect({ judge, effort: left.map((sent) => sent.effort) }).toEqual({
        judge,
        effort: [null],
      });
    }
  });

  test("is not Jev's even where the endpoint could serve it", async () => {
    // OpenRouter, and no switch set at all: the address alone never turns Jev on.
    const made = calls({ baseUrl: OPENROUTER });
    await made.memoryAsker.ask({ fact: "월요일은 쉰다" }, QUESTIONS);
    expect(left.map((sent) => sent.door)).toEqual(["server-model"]);
    expect(made.highRiskModel).toBe(SERVER_MODEL);
  });
});

describe("a judge with Jev on", () => {
  test("asks Jev first, inside its own bound and under its own purpose, and nobody else when Jev answers", async () => {
    for (const judge of EVERY_JUDGE) {
      left = [];
      modelBounds = [];
      jevBounds = [];
      usageSources = [];
      logged = [];
      await ask(calls({ jev: true }), judge);
      await Promise.resolve();

      expect({ judge, left }).toEqual({
        judge,
        left: [
          {
            door: "jev",
            url: "https://openrouter.ai/api/v1/systemone",
            model: DECISION_MODEL,
            effort: null,
            key: "Bearer sk-test",
          },
        ],
      });
      // The bound is the judge's own and no other judge's: each of the four is a different number.
      expect({ judge, armed: jevBounds }).toEqual({
        judge,
        armed: [JUDGES[judge].jevMs],
      });
      expect({ judge, purposes: purposesLogged() }).toEqual({
        judge,
        purposes: [judge],
      });
      // Jev's tokens are counted under one name whoever asked; the server model was not asked.
      expect({ judge, sources: usageSources }).toEqual({
        judge,
        sources: ["decisions"],
      });
      expect(modelBounds).toEqual([]);
    }
  });

  test("falls to the server model, inside the stand-in's bound and under the judge's name, when Jev cannot answer", async () => {
    jevStatus = 503;
    for (const judge of EVERY_JUDGE) {
      left = [];
      modelBounds = [];
      usageSources = [];
      await ask(calls({ jev: true }), judge);
      await Promise.resolve();

      expect({
        judge,
        doors: left.map((sent) => [sent.door, sent.model]),
      }).toEqual({
        judge,
        doors: [
          ["jev", DECISION_MODEL],
          ["server-model", SERVER_MODEL],
        ],
      });
      expect(left[1]?.url).toBe(`${OPENROUTER}/chat/completions`);
      expect({ judge, bounds: modelBounds }).toEqual({
        judge,
        bounds: [JUDGES[judge].standInMs],
      });
      // A refusal has no usage to count, so the one row is the stand-in's, under the judge's name.
      expect({ judge, sources: usageSources }).toEqual({
        judge,
        sources: [judge],
      });
    }
  });

  test("names the decisions model as the high-risk check's", () => {
    expect(calls({ jev: true }).highRiskModel).toBe(DECISION_MODEL);
  });
});

describe("the two calls that are the server model's alone", () => {
  test("the day's summary waits two minutes and is counted as the day's summary, Jev on or off", async () => {
    for (const jev of [false, true]) {
      left = [];
      modelBounds = [];
      usageSources = [];
      const summary = await calls({ jev }).summarizeDay({
        previous: null,
        transcript: "사장님: 주문 확인해줘\n봇: 두 건입니다.",
        day: "2026-10-05",
      });
      await Promise.resolve();

      expect(summary).toBe("어제는 주문 두 건을 확인했다.");
      expect(left).toEqual([
        {
          door: "server-model",
          url: `${jev ? OPENROUTER : PROVIDER}/chat/completions`,
          model: SERVER_MODEL,
          effort: "low",
          key: "Bearer sk-test",
        },
      ]);
      expect(modelBounds).toEqual([120_000]);
      expect(usageSources).toEqual(["day-summary"]);
    }
  });

  test("the dream is handed the server model, its effort and its own name for the tokens", async () => {
    const { dreamCall } = calls({ jev: false });
    expect({
      baseUrl: dreamCall.baseUrl,
      model: dreamCall.model,
      supportsEffort: dreamCall.supportsEffort,
      key: await dreamCall.apiKey(),
    }).toEqual({
      baseUrl: PROVIDER,
      model: SERVER_MODEL,
      supportsEffort: true,
      key: "sk-test",
    });
    dreamCall.onUsage({
      model: SERVER_MODEL,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    });
    await Promise.resolve();
    expect(usageSources).toEqual(["dream"]);
    expect(calls({ jev: false, effort: false }).dreamCall.supportsEffort).toBe(
      false,
    );
  });
});
