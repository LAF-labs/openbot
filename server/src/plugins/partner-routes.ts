/**
 * The 알림톡 and 세금계산서 cards' own surface: connect, look, disconnect.
 *
 * SEPARATE FROM `/api/plugins/connections` BECAUSE THE GESTURE IS DIFFERENT. That one lists OAuth
 * entries and every card on it does the same thing — leave for the vendor, come back consented. A
 * partner is registered rather than consented to: two steps and a 인증번호 for 알림톡, a form and a
 * popup the person opens themselves for 세금계산서. One list with two gestures on it would be a
 * screen where half the buttons mean something else.
 *
 * ONLY WHAT THIS DEPLOYMENT HOLDS A KEY FOR. `GET /` answers with the configured partners and no
 * others, so a fleet VM without `LAF_ALIMTALK_API_KEY` draws no 알림톡 card at all — not a card with
 * a button that would 503. Everything below `GET /` refuses 503 for the same reason, in case a card
 * outlives a key being taken away.
 *
 * FACTS ONLY. Every refusal is a `laf:` code and the surface owns the sentence, which is the rule
 * the rest of this fork keeps; the one thing that crosses is a vendor's own inspection comment on a
 * rejected template, because it is 카카오's words about this person's template and nobody here can
 * write it for them.
 */

import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { catalogueEntry, type PartnerFamily } from "./catalogue";
import {
  isPartnerProvider,
  type PartnerProvider,
  PartnerRefusedError,
} from "./partner-connections";
import type { PartnerRuntime } from "./partners";
import { CatalogueEntryUnknownError, type PluginStore } from "./store";

/** A body field that must be a non-empty string, or the refusal for its absence. */
function required(
  body: Record<string, unknown> | null,
  name: string,
  fact: string,
): string {
  const value = body?.[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new PartnerRefusedError(fact);
  }
  return value.trim();
}

/** An optional string field, trimmed. Absent and empty are one thing here. */
function optional(
  body: Record<string, unknown> | null,
  name: string,
): string | undefined {
  const value = body?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createPartnerRoutes(
  store: PluginStore,
  partners: PartnerRuntime,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const actorEmail = (context: { var: AppVariables }) =>
    context.var.actor?.email ?? "unknown";

  /**
   * The connector for this provider, or the refusal for a deployment that holds no key for it.
   *
   * 503 rather than 404: the provider exists in this build and nothing the person types will make
   * it work. The two are told apart because they are different things to be told — one is "not a
   * thing", the other is "not here".
   */
  function connectorFor(provider: PartnerProvider) {
    const connector =
      provider === "kakao-alimtalk" ? partners.alimtalk : partners.tax;
    if (!connector) {
      throw new PartnerRefusedError(`laf:${provider}_not_configured`, 503);
    }
    return connector;
  }

  /**
   * The server row, its tools, and a grant on each for every Bot this person owns.
   *
   * WHY A CONNECT GRANTS. Everywhere else in this product a grant is an administrator's separate
   * decision, and that is right for a deployment several people share. This one is not shared — one
   * VM per person — and the person has just registered their own 카카오톡 채널 through a screen that
   * said what it was for. Making them then find an admin page to turn on the tools they just
   * connected is ceremony in front of a decision nobody makes; the audit rows `grant` writes still
   * name them and the moment.
   *
   * Hidden Bots are included: see {@link PartnerRuntime.botsOwnedBy}.
   *
   * NEVER FAILS THE CONNECT. The registration at the vendor has already happened by the time this
   * runs, and a row here that could not be written is recoverable by pressing again — a 503 thrown
   * over it would tell somebody their channel had not been connected when it had.
   */
  async function offerToolsTo(
    provider: PartnerFamily,
    userId: string,
    by: string,
  ): Promise<void> {
    try {
      await store.ensureCatalogueServer({ key: provider, by });
      await store.refreshTools(provider, userId);
      const bots = await partners.botsOwnedBy(userId);
      for (const tool of partners.toolsOf(provider)) {
        for (const botId of bots) {
          await store.grant("mcp", `${provider}/${tool.name}`, botId, by);
        }
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "partner-tools-not-offered",
          provider,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * The other direction: the grants back, then the server row and its tools.
   *
   * In this order on purpose. The grants are read against the tool list this build ships rather than
   * against the table, so they can be taken back after the tool rows have gone — but doing it the
   * other way round would leave a window where a Bot holds a grant on a tool that still exists.
   *
   * NEVER FAILS THE DISCONNECT, for the same reason the connect never fails on the grants: the
   * registration is already gone at this point, and telling somebody their channel is still
   * connected when it is not is the worse lie.
   */
  async function withdrawToolsFrom(
    provider: PartnerFamily,
    userId: string,
    by: string,
  ): Promise<void> {
    try {
      const bots = await partners.botsOwnedBy(userId);
      for (const tool of partners.toolsOf(provider)) {
        for (const botId of bots) {
          await store.revoke("mcp", `${provider}/${tool.name}`, botId, by);
        }
      }
      await store.removeServer(provider, by);
    } catch (error) {
      // A row that was never made, most likely: the tools were never offered. Nothing to undo.
      if (error instanceof CatalogueEntryUnknownError) return;
      console.error(
        JSON.stringify({
          type: "partner-tools-not-withdrawn",
          provider,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * Every partner this deployment can actually offer, with what it knows about this person's.
   *
   * The catalogue half — the title and the summary — comes from the entry, so the words a screen
   * falls back to are the reviewed ones. The status half is per person and is what makes the card
   * draw 연결됨 or 연결 안 됨 without a second request.
   */
  routes.get("/", requireUser, async (context) => {
    const userId = context.var.actor.id;
    const listed = [];
    for (const provider of partners.configured) {
      const entry = catalogueEntry(provider);
      const connector =
        provider === "kakao-alimtalk" ? partners.alimtalk : partners.tax;
      if (!entry || !connector) continue;
      listed.push({
        id: provider,
        title: entry.title,
        summary: entry.summary,
        docsUrl: entry.docsUrl,
        status: await connector.status(userId),
      });
    }
    return context.json({ partners: listed });
  });

  /** One partner's status on its own, for a card refreshing itself after a step. */
  routes.get("/:provider", requireUser, async (context) =>
    answer(context, async (provider, userId) => ({
      status: await connectorFor(provider).status(userId),
    })),
  );

  /**
   * Step one of the 알림톡 connect: 솔라피 sends a 인증번호 to the 담당자's phone.
   *
   * The number is normalised and used, and is not stored by this call: nothing is written until the
   * code comes back, because a row for a channel whose manager never answered would say this person
   * has a channel connected when they have not.
   */
  routes.post("/kakao-alimtalk/code", requireUser, async (context) =>
    answerWith(context, async (userId) => {
      const connector = partners.alimtalk;
      if (!connector) {
        throw new PartnerRefusedError("laf:kakao-alimtalk_not_configured", 503);
      }
      const body = await jsonBody(context);
      return await connector.requestCode({
        userId,
        searchId: required(body, "searchId", "laf:alimtalk_search_id_missing"),
        phone: required(body, "phone", "laf:alimtalk_phone_missing"),
      });
    }),
  );

  /**
   * Step two: the code, the 발신프로필, LAF's four templates, and the tools.
   *
   * Registration is not approval — 카카오 inspects each template and takes days — so what comes back
   * is a status with four `pending` rows in it, and the card says 심사 중 rather than 사용 가능.
   */
  routes.post("/kakao-alimtalk/connect", requireUser, async (context) =>
    answerWith(context, async (userId) => {
      const connector = partners.alimtalk;
      if (!connector) {
        throw new PartnerRefusedError("laf:kakao-alimtalk_not_configured", 503);
      }
      const body = await jsonBody(context);
      const status = await connector.confirmCode({
        userId,
        searchId: required(body, "searchId", "laf:alimtalk_search_id_missing"),
        phone: required(body, "phone", "laf:alimtalk_phone_missing"),
        code: required(body, "code", "laf:alimtalk_code_missing"),
      });
      await offerToolsTo("kakao-alimtalk", userId, actorEmail(context));
      return { status };
    }),
  );

  /** Ask 카카오 where each template's inspection got to, and register any that never landed. */
  routes.post("/kakao-alimtalk/refresh", requireUser, async (context) =>
    answerWith(context, async (userId) => {
      const connector = partners.alimtalk;
      if (!connector) {
        throw new PartnerRefusedError("laf:kakao-alimtalk_not_configured", 503);
      }
      return { status: await connector.refreshTemplates(userId) };
    }),
  );

  /**
   * The 팝빌 연동회원 join: this business becomes a member under LAF's LinkID.
   *
   * NO ID AND NO PASSWORD IS ASKED FOR OR SENT BACK. The member id is derived from the business
   * number and the password is minted inside the module and forgotten — see `tax/connect.ts`. What
   * the person types is what they would type on any 세금계산서 form.
   */
  routes.post("/tax-invoice/connect", requireUser, async (context) =>
    answerWith(context, async (userId) => {
      const connector = partners.tax;
      if (!connector) {
        throw new PartnerRefusedError("laf:tax-invoice_not_configured", 503);
      }
      const body = await jsonBody(context);
      const status = await connector.join({
        userId,
        businessNumber: required(
          body,
          "businessNumber",
          "laf:tax_business_number_missing",
        ),
        corpName: required(body, "corpName", "laf:tax_corp_name_missing"),
        ceoName: required(body, "ceoName", "laf:tax_ceo_name_missing"),
        contactName: required(
          body,
          "contactName",
          "laf:tax_contact_name_missing",
        ),
        contactPhone: required(
          body,
          "contactPhone",
          "laf:tax_contact_phone_missing",
        ),
        contactEmail: required(
          body,
          "contactEmail",
          "laf:tax_contact_email_missing",
        ),
        ...(optional(body, "address")
          ? { address: optional(body, "address") as string }
          : {}),
      });
      await offerToolsTo("tax-invoice", userId, actorEmail(context));
      return { status };
    }),
  );

  /**
   * The URL of 팝빌's own certificate popup, for the person to open in their own browser.
   *
   * A URL AND NOTHING MORE, DELIBERATELY. Registering a 공동인증서 means choosing a file on the
   * person's own machine and typing its password, and the only place that may happen is a window
   * they opened themselves at the vendor's address. Nothing here automates it, nothing here reads
   * it, and a password never crosses this process.
   */
  routes.post("/tax-invoice/certificate-url", requireUser, async (context) =>
    answerWith(context, async (userId) => {
      const connector = partners.tax;
      if (!connector) {
        throw new PartnerRefusedError("laf:tax-invoice_not_configured", 503);
      }
      const body = await jsonBody(context);
      const kind = optional(body, "kind") === "seal" ? "seal" : "certificate";
      return await connector.certificateUrl({ userId, kind });
    }),
  );

  /** Ask 팝빌 whether the certificate is registered now, and until when. */
  routes.post("/tax-invoice/refresh", requireUser, async (context) =>
    answerWith(context, async (userId) => {
      const connector = partners.tax;
      if (!connector) {
        throw new PartnerRefusedError("laf:tax-invoice_not_configured", 503);
      }
      return { status: await connector.refreshCertificate(userId) };
    }),
  );

  /**
   * One person dropping their own registration.
   *
   * The server row goes with it, which takes the tool rows — so a Bot stops being offered 알림톡
   * 보내기 the moment the channel it would have sent from is gone. A capability that exists only to
   * say no is worse than no capability.
   *
   * AND THE GRANTS, WHICH THE SERVER ROW DOES NOT TAKE. `plugin_grants.ref` is `<server>/<tool>` as
   * plain text with no key behind it, so removing the server leaves the rows: measured by pressing
   * 연결 해제 and reading the table. That state has a name — a WITHDRAWN grant — and it is drawn on
   * the admin Plugins page as a discrepancy somebody should look into, which would be a lie here.
   * Nothing is discrepant: the person pressed the button.
   *
   * NOTHING IS WITHDRAWN AT THE VENDOR. The 카카오톡 채널 and the 팝빌 회원 are the person's own and
   * outlive this; what stops is LAF acting as them. The audit row says so out loud.
   */
  routes.post("/:provider/disconnect", requireUser, async (context) =>
    answer(context, async (provider, userId) => {
      const result = await connectorFor(provider).disconnect(userId);
      if (result.disconnected) {
        await withdrawToolsFrom(provider, userId, actorEmail(context));
      }
      return result;
    }),
  );

  return routes;
}

/** The request body as an object, or null. A body that is not JSON is not a body. */
async function jsonBody(context: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  const parsed = await context.req.json().catch(() => null);
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : null;
}

/** What every handler here is handed and answers with. Narrow, so a test can call one directly. */
type PartnerRouteContext = {
  var: AppVariables;
  req: {
    param: (name: string) => string | undefined;
    json: () => Promise<unknown>;
  };
  json: (body: unknown, status?: 200 | 400 | 409 | 502 | 503) => Response;
};

/**
 * The person from the session, and every refusal turned into a `laf:` code.
 *
 * One wrapper rather than a try/catch per handler, because the shape of the answer is the same
 * every time and a handler that forgot one would answer 500 with a stack trace to somebody who had
 * typed their phone number wrong. The status is carried on the refusal (`PartnerRefusedError`)
 * because the three cases a person meets are genuinely different — see that class.
 */
async function answerWith<T>(
  context: PartnerRouteContext,
  run: (userId: string) => Promise<T>,
): Promise<Response> {
  const userId = context.var.actor?.id ?? "";
  if (!userId) return context.json({ code: "laf:partner_no_actor" }, 400);
  try {
    return context.json(await run(userId));
  } catch (error) {
    if (error instanceof PartnerRefusedError) {
      const { status } = error;
      return context.json(
        { code: error.fact },
        status === 503
          ? 503
          : status === 502
            ? 502
            : status === 409
              ? 409
              : 400,
      );
    }
    throw error;
  }
}

/** The same, for the two handlers whose provider is in the path rather than in their name. */
async function answer<T>(
  context: PartnerRouteContext,
  run: (provider: PartnerProvider, userId: string) => Promise<T>,
): Promise<Response> {
  const raw = context.req.param("provider") ?? "";
  // A path segment is not a provider until this says so. Refused rather than cast, because what
  // follows reads a connector and a table by this word.
  if (!isPartnerProvider(raw)) {
    return context.json({ code: "laf:partner_unknown" }, 400);
  }
  return await answerWith(context, (userId) => run(raw, userId));
}
