import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createDevRequireUser, DEV_ACTOR } from "../src/auth/dev-actor";
import {
  type AppVariables,
  type BotOwnerLookup,
  requireBotAccess,
} from "../src/auth/guards";

/*
 * The local stand-in for a signed-in person has to answer the same ownership question the real
 * guard answers. When 2026-09-16 took the administrator exception out of `actorMayDriveBot`, the
 * development guard was still putting only the actor on the context, and `requireBotAccess` reads a
 * missing answer as "not here" — so with `LAF_DEV_NO_AUTH=true` every Bot-scoped route (its screen,
 * its questions, its grants) answered 404 to the developer's own Bots.
 */

const owners: Record<string, string | null> = {
  "agent-mine": DEV_ACTOR.id,
  "agent-shipped": null,
  "agent-theirs": "someone-else",
};
const lookup: BotOwnerLookup = async (botId) => owners[botId];

function appWith(botOwner?: BotOwnerLookup) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.get(
    "/bots/:botId",
    createDevRequireUser(botOwner),
    requireBotAccess(),
    (context) => context.json({ ok: true, actor: context.var.actor.id }),
  );
  return app;
}

describe("the development guard answers whose Bot it is", () => {
  test("the developer's own Bot opens", async () => {
    const response = await appWith(lookup).request(
      "http://laf.local/bots/agent-mine",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      actor: DEV_ACTOR.id,
    });
  });

  test("a Bot nobody made opens, as it does for anybody signed in", async () => {
    const response = await appWith(lookup).request(
      "http://laf.local/bots/agent-shipped",
    );
    expect(response.status).toBe(200);
  });

  test("somebody else's Bot and a Bot that is not there are both not here", async () => {
    for (const botId of ["agent-theirs", "agent-missing"]) {
      const response = await appWith(lookup).request(
        `http://laf.local/bots/${botId}`,
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: "laf:bot_not_found",
      });
    }
  });

  test("without a lookup nothing is driven, as with the real guard", async () => {
    const response = await appWith().request(
      "http://laf.local/bots/agent-mine",
    );
    expect(response.status).toBe(404);
  });
});
