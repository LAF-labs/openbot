import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "@ag-ui/client";
import { and, eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channelAgents,
  channelMemberships,
  channels,
  channelThreads,
  lafAnswerRatings,
  lafNotifications,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import { createNotificationOutbox } from "../src/notifications/outbox";
import { appendMessages } from "../src/runner/thread-store";
import {
  ANSWER_NOTE_MAX_LENGTH,
  createAnswerRatingStore,
} from "../src/support/answer-ratings";
import {
  createFeedbackStore,
  createSupportWebhookAdapter,
} from "../src/support/feedback";
import { createSupportRoutes } from "../src/support/routes";
import { TEST_POOL } from "./support/database";

/**
 * 좋아요·아쉬워요, FROM THE PRESS TO THE ROW TO THE OPERATOR'S CHANNEL, AGAINST THE REAL TABLES.
 *
 * Three things only a real database can say. Whose conversation an answer is in and whether it is a
 * Bot's answer at all are read from `channel_memberships`, `channel_threads` and the stored message
 * itself — a fake would be told the answer. The replace is a unique index and an upsert. And the
 * cascades are foreign keys.
 *
 * AND THAT THE ANSWER GOES NOWHERE. Every answer in these threads carries a sentence nobody should
 * ever see outside the conversation; the rating row, the outbox row and the body the operator's
 * webhook receives are serialised and searched for it. The webhook is a real HTTP server on an
 * ephemeral port, reached through the real door, so what is asserted is what was sent.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const tag = randomUUID().slice(0, 8);
/** What a Bot said, which must never leave the conversation it was said in. */
const ANSWER = `오늘 매출은 1,234,000원입니다 답변카나리아-${tag}`;
const BOT_NAME = `초롱-${tag}`;

type Fixture = {
  person: string;
  bot: string;
  channel: string;
  thread: string;
  asked: string;
  answered: string;
  unattributed: string;
};

const made = {
  people: [] as string[],
  bots: [] as string[],
  channels: [] as string[],
  threads: [] as string[],
};

async function conversation(label: string): Promise<Fixture> {
  const person = `rating-${label}-${tag}`;
  const bot = `rating-bot-${label}-${tag}`;
  const channel = `rating-channel-${label}-${tag}`;
  const thread = `rating-thread-${label}-${tag}`;
  made.people.push(person);
  made.bots.push(bot);
  made.channels.push(channel);
  made.threads.push(thread);

  await database.insert(users).values({
    id: person,
    email: `${person}@laf.test`,
    name: label,
    emailVerified: true,
  });
  await database.insert(agents).values({
    id: bot,
    name: BOT_NAME,
    type: "remote_ag_ui",
    configuration: { endpoint: "https://bot.example.test/ag-ui" },
  });
  await database.insert(agentProfiles).values({
    agentId: bot,
    ownerUserId: person,
    roleDescription: "매출을 알려 줍니다.",
    avatarSeed: "seed",
  });
  await database
    .insert(channels)
    .values({ id: channel, name: `${label} and the Bot`, description: "" });
  await database
    .insert(channelMemberships)
    .values({ channelId: channel, userId: person });
  await database
    .insert(channelAgents)
    .values({ channelId: channel, agentId: bot });
  await database
    .insert(channelThreads)
    .values({ userId: person, channelId: channel, threadId: thread });

  const asked = `m-asked-${label}-${tag}`;
  const answered = `m-answered-${label}-${tag}`;
  const unattributed = `m-unattributed-${label}-${tag}`;
  await appendMessages(database, thread, [
    { id: asked, role: "user", content: "오늘 매출 얼마야?" },
    {
      id: answered,
      role: "assistant",
      content: ANSWER,
      lafAgentId: bot,
    } as Message,
    // Said before speakers were recorded: a Bot's words, but no record of which Bot's.
    { id: unattributed, role: "assistant", content: ANSWER } as Message,
  ]);
  return { person, bot, channel, thread, asked, answered, unattributed };
}

/** The operator's alert channel: every body the support door posts, as it arrived. */
const received: unknown[] = [];
const webhook = Bun.serve({
  port: 0,
  fetch: async (request) => {
    received.push(await request.json());
    return new Response("ok");
  },
});

const outbox = createNotificationOutbox({
  database,
  adapters: [
    createSupportWebhookAdapter({
      webhookUrl: `http://127.0.0.1:${webhook.port}/alerts`,
      origin: "https://kim.agent.laf-co.com",
    }),
  ],
});

function surface(actorId: string) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", {
      id: actorId,
      email: `${actorId}@laf.test`,
      role: "user",
    });
    await next();
  };
  return new Hono<{ Variables: AppVariables }>().route(
    "/api/support",
    createSupportRoutes(
      {
        feedback: createFeedbackStore(database),
        auditStore: { insert: async () => {} },
        outbox,
        ratings: createAnswerRatingStore(database),
      },
      requireUser,
    ),
  );
}

const rate = (who: string, channel: string, message: string, body: unknown) =>
  surface(who).request(
    `/api/support/ratings/${encodeURIComponent(channel)}/${encodeURIComponent(message)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

const rowsFor = (person: string) =>
  database
    .select()
    .from(lafAnswerRatings)
    .where(eq(lafAnswerRatings.userId, person));

const toldAbout = (person: string) =>
  database
    .select()
    .from(lafNotifications)
    .where(
      and(
        eq(lafNotifications.userId, person),
        eq(lafNotifications.kind, "support.answer_rating"),
      ),
    );

let A: Fixture;
let B: Fixture;

beforeAll(async () => {
  A = await conversation("a");
  B = await conversation("b");
});

afterAll(async () => {
  webhook.stop(true);
  await database
    .delete(lafThreadMessages)
    .where(inArray(lafThreadMessages.threadId, made.threads));
  await database.delete(channels).where(inArray(channels.id, made.channels));
  await database.delete(agents).where(inArray(agents.id, made.bots));
  // The ratings and the outbox rows go with the people.
  await database.delete(users).where(inArray(users.id, made.people));
  await database.$client.end();
});

describe("a rating, through the route to the row", () => {
  test("좋아요 is kept with whose it is, which answer and which Bot — and nothing the answer said", async () => {
    const response = await rate(A.person, A.channel, A.answered, {
      rating: "up",
    });
    expect(response.status).toBe(200);
    const receipt = (await response.json()) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      messageId: A.answered,
      rating: "up",
      reason: null,
      note: null,
      told: [],
    });
    expect(typeof receipt.updatedAt).toBe("string");

    const rows = await rowsFor(A.person);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: A.person,
      channelId: A.channel,
      messageId: A.answered,
      agentId: A.bot,
      rating: "up",
      reason: null,
      note: null,
    });
    expect(JSON.stringify(rows)).not.toContain("답변카나리아");
    // A 좋아요 is only kept: nobody is paged about it.
    expect(await toldAbout(A.person)).toEqual([]);
  });

  test("a second press replaces the first, and when it was first said stays", async () => {
    const [first] = await rowsFor(A.person);
    const response = await rate(A.person, A.channel, A.answered, {
      rating: "down",
      reason: "wrong-facts",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rating: "down",
      reason: "wrong-facts",
      note: null,
      // 아쉬워요 with nothing written is a count, not a message: kept, and nobody paged.
      told: [],
    });

    const rows = await rowsFor(A.person);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id as string);
    expect(rows[0]?.createdAt.getTime()).toBe(
      first?.createdAt.getTime() as number,
    );
    expect(rows[0]?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      first?.updatedAt.getTime() as number,
    );
    expect(await toldAbout(A.person)).toEqual([]);
  });

  test("아쉬워요 with a note reaches the operator: the Bot, the reason, the note and the ids — never the answer", async () => {
    received.length = 0;
    const note = "매출 숫자가 어제 것 같아요";
    const response = await rate(A.person, A.channel, A.answered, {
      rating: "down",
      reason: "wrong-facts",
      note: `  ${note}  `,
    });
    expect(response.status).toBe(200);
    const receipt = (await response.json()) as { note: string; told: string[] };
    expect(receipt.note).toBe(note);
    expect(receipt.told).toEqual(["support-webhook"]);

    expect(received).toHaveLength(1);
    const body = received[0] as {
      text: string;
      content: string;
      rating: Record<string, unknown>;
    };
    expect(body.content).toBe(body.text);
    for (const said of [
      "https://kim.agent.laf-co.com",
      BOT_NAME,
      "사실과 달라요",
      note,
      A.channel,
      A.answered,
    ]) {
      expect({ said, found: body.text.includes(said) }).toEqual({
        said,
        found: true,
      });
    }
    expect(body.rating).toMatchObject({
      rating: "down",
      reason: "wrong-facts",
      note,
      bot: { id: A.bot, name: BOT_NAME },
      channelId: A.channel,
      messageId: A.answered,
    });

    // The answer is in none of the three places the rating went.
    const outboxRows = await toldAbout(A.person);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.deliveredVia).toEqual(["support-webhook"]);
    for (const [where, value] of [
      ["the webhook body", received],
      ["the outbox row", outboxRows],
      ["the rating row", await rowsFor(A.person)],
    ] as const) {
      expect({
        where,
        found: JSON.stringify(value).includes("답변카나리아"),
      }).toEqual({
        where,
        found: false,
      });
    }

    // The person's own notification list is theirs; their words to the operator are not in it.
    expect(
      (await outbox.list(A.person)).filter(
        (row) => row.kind === "support.answer_rating",
      ),
    ).toEqual([]);
  });

  test("the same note again is not told twice; a changed one is", async () => {
    received.length = 0;
    const again = await rate(A.person, A.channel, A.answered, {
      rating: "down",
      reason: "too-slow",
      note: "매출 숫자가 어제 것 같아요",
    });
    expect(((await again.json()) as { told: string[] }).told).toEqual([]);
    expect(received).toHaveLength(0);

    const changed = await rate(A.person, A.channel, A.answered, {
      rating: "down",
      reason: "too-slow",
      note: "그리고 너무 오래 걸렸어요",
    });
    expect(((await changed.json()) as { told: string[] }).told).toEqual([
      "support-webhook",
    ]);
    expect(received).toHaveLength(1);
    expect((received[0] as { text: string }).text).toContain("너무 느려요");
    expect(await rowsFor(A.person)).toHaveLength(1);
  });

  test("the conversation's ratings are read back as the person left them, and only theirs", async () => {
    const response = await surface(A.person).request(
      `/api/support/ratings/${encodeURIComponent(A.channel)}`,
    );
    expect(response.status).toBe(200);
    const { ratings } = (await response.json()) as {
      ratings: Array<Record<string, unknown>>;
    };
    expect(ratings).toEqual([
      {
        messageId: A.answered,
        rating: "down",
        reason: "too-slow",
        note: "그리고 너무 오래 걸렸어요",
        updatedAt: expect.any(String),
      },
    ]);
  });
});

describe("what cannot be rated", () => {
  test("anything that is not a Bot's answer in this conversation", async () => {
    for (const [what, message] of [
      ["the person's own message", A.asked],
      ["an answer no record says which Bot gave", A.unattributed],
      ["an id the thread does not hold", `m-nothing-${tag}`],
      ["an answer from somebody else's conversation", B.answered],
    ] as const) {
      const response = await rate(A.person, A.channel, message, {
        rating: "up",
      });
      expect({
        what,
        status: response.status,
        body: await response.json(),
      }).toEqual({
        what,
        status: 404,
        body: {
          error: "laf:rating_message_not_found",
          code: "laf:rating_message_not_found",
        },
      });
    }
  });

  test("a conversation the person is not in is not there, for a rating or for the list", async () => {
    const pressed = await rate(B.person, A.channel, A.answered, {
      rating: "down",
      note: "남의 대화",
    });
    expect(pressed.status).toBe(404);
    expect(await pressed.json()).toEqual({
      error: "laf:channel_not_found",
      code: "laf:channel_not_found",
    });
    const listed = await surface(B.person).request(
      `/api/support/ratings/${encodeURIComponent(A.channel)}`,
    );
    expect(listed.status).toBe(404);
    expect(await rowsFor(B.person)).toEqual([]);
  });

  test("a body the route does not take is refused before anything is written", async () => {
    for (const [what, body, expected] of [
      ["no rating", {}, { code: "laf:rating_invalid" }],
      ["a third kind", { rating: "meh" }, { code: "laf:rating_invalid" }],
      [
        "a reason nobody offered",
        { rating: "down", reason: "rude" },
        { code: "laf:rating_invalid" },
      ],
      [
        "a reason under 좋아요",
        { rating: "up", reason: "too-slow" },
        { code: "laf:rating_invalid" },
      ],
      [
        "a note under 좋아요",
        { rating: "up", note: "좋아요" },
        { code: "laf:rating_invalid" },
      ],
      [
        "a note that is not words",
        { rating: "down", note: 42 },
        { code: "laf:rating_invalid" },
      ],
      [
        "a note past the limit",
        { rating: "down", note: "가".repeat(ANSWER_NOTE_MAX_LENGTH + 1) },
        { code: "laf:rating_note_too_long", limit: ANSWER_NOTE_MAX_LENGTH },
      ],
    ] as const) {
      const response = await rate(B.person, B.channel, B.answered, body);
      expect({
        what,
        status: response.status,
        body: await response.json(),
      }).toEqual({
        what,
        status: 400,
        body: { error: expected.code, ...expected },
      });
    }
    expect(await rowsFor(B.person)).toEqual([]);
  });

  test("a note at exactly the limit is kept whole", async () => {
    const note = "가".repeat(ANSWER_NOTE_MAX_LENGTH);
    const response = await rate(B.person, B.channel, B.answered, {
      rating: "down",
      note,
    });
    expect(response.status).toBe(200);
    expect((await rowsFor(B.person))[0]?.note).toBe(note);
  });
});

describe("where a rating goes when what it is about goes", () => {
  test("with the conversation, with the Bot, and with the person", async () => {
    for (const parent of ["channel", "bot", "person"] as const) {
      const fixture = await conversation(`cascade-${parent}`);
      const response = await rate(
        fixture.person,
        fixture.channel,
        fixture.answered,
        {
          rating: "up",
        },
      );
      expect(response.status).toBe(200);
      expect(await rowsFor(fixture.person)).toHaveLength(1);

      if (parent === "channel") {
        await database.delete(channels).where(eq(channels.id, fixture.channel));
      } else if (parent === "bot") {
        await database.delete(agents).where(eq(agents.id, fixture.bot));
      } else {
        await database.delete(users).where(eq(users.id, fixture.person));
      }

      const left = await database
        .select({ id: lafAnswerRatings.id })
        .from(lafAnswerRatings)
        .where(eq(lafAnswerRatings.messageId, fixture.answered));
      expect({ parent, left }).toEqual({ parent, left: [] });
    }
  });
});
