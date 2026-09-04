/**
 * Connecting one person's 카카오톡 채널, in the two steps they actually see.
 *
 * They type their channel's 검색용 아이디 and the 관리자 휴대폰 번호; a 인증번호 arrives on that
 * phone; they type it back. That is the whole of it — there is no console, no API key and no
 * developer account, because the account at the vendor is LAF's and the person is registered under
 * it (see `partner-connections.ts`).
 *
 * WHAT HAPPENS AFTER THE CODE IS ACCEPTED. The 발신프로필 key comes back and is stored, and LAF's four
 * standard templates are registered under it in the same call. Registration is not approval:
 * 카카오 inspects each body and takes days over it, so the card shows 심사 중 until it does not, and
 * nothing may be sent through a template before then. That is why the connect does not wait for it.
 *
 * A TEMPLATE THAT WILL NOT REGISTER DOES NOT FAIL THE CONNECT. The channel is connected either way,
 * and a channel with no templates is a real, if temporarily useless, state; failing the whole flow
 * would leave the person with a 발신프로필 registered at the vendor and no row here saying so.
 */
import { recordAuditEvent } from "../../audit";
import {
  type PartnerConnections,
  type PartnerContext,
  PartnerRefusedError,
} from "../partner-connections";
import {
  readTemplate,
  registerChannel,
  registerTemplate,
  requestChannelToken,
  SolapiError,
  type SolapiSettings,
  solapiSettings,
} from "./solapi";
import { STANDARD_TEMPLATES } from "./templates";

const PROVIDER = "kakao-alimtalk" as const;

/** What the card draws, and every field of it is a fact. */
export type AlimtalkStatus = {
  /** Whether this deployment holds LAF's 솔라피 key at all. False hides the card. */
  isConfigured: boolean;
  connected: boolean;
  /** The 검색용 아이디 the person typed. Shown back to them; the senderKey never is. */
  searchId: string | null;
  connectedAt: string | null;
  templates: {
    code: string;
    /** Which of LAF's four this is, so the surface names it in Korean. */
    audience: "owner" | "customer";
    status: "pending" | "approved" | "rejected";
    reason: string;
  }[];
};

/**
 * A channel's 검색용 아이디, as the vendor wants it.
 *
 * Refused rather than repaired past the leading `@`, which people leave off about half the time and
 * which is unambiguous to add. Everything else — a space, a full URL pasted out of the 채널 관리자
 * 센터 — is a different value from the one they think they typed, and guessing at it would register
 * a channel that is not theirs.
 */
export function normalizeSearchId(raw: string): string {
  const trimmed = raw.trim();
  const withMark = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  if (!/^@[^\s@]{1,63}$/.test(withMark)) {
    throw new PartnerRefusedError("laf:alimtalk_search_id_invalid");
  }
  return withMark;
}

/**
 * A Korean mobile number, digits only.
 *
 * Hyphens and spaces are dropped because every phone in the country is written with them somewhere;
 * a leading `+82` is rewritten to the domestic `0`, because that is the same number and refusing it
 * would be pedantry aimed at somebody reading their own SIM card.
 */
export function normalizePhone(raw: string): string {
  const digits = raw
    .trim()
    .replace(/^\+?82/, "0")
    .replaceAll(/\D/g, "");
  /*
   * TEN OR ELEVEN DIGITS, and the first spelling of this rule allowed nine or ten — so every
   * `010-1234-5678` in the country, which is eleven, was refused before the vendor was ever asked.
   * Nothing about that is visible from a green typecheck: the flow simply never connected.
   *
   * The prefix is named rather than left as `[0-9]`, because `020` is not a mobile number and the
   * 인증번호 has to arrive on a phone somebody is holding.
   */
  if (!/^01[016789][0-9]{7,8}$/.test(digits)) {
    throw new PartnerRefusedError("laf:alimtalk_phone_invalid");
  }
  return digits;
}

/** A recipient number for a send: the same rules, said with the send's own fact. */
export function normalizeRecipient(raw: string): string {
  const digits = raw
    .trim()
    .replace(/^\+?82/, "0")
    .replaceAll(/\D/g, "");
  if (!/^0[1-9][0-9]{7,9}$/.test(digits)) {
    throw new PartnerRefusedError("laf:alimtalk_recipient_invalid");
  }
  return digits;
}

export function createAlimtalkConnect(
  context: PartnerContext,
  partners: PartnerConnections,
  environment: Record<string, string | undefined> = process.env,
) {
  /**
   * LAF's key, or the refusal for holding none.
   *
   * 503 rather than 400: nothing the person types can fix it, and a card that offered a Connect
   * button in this state would be a control that saves and does nothing.
   */
  function requireSettings(): SolapiSettings {
    const settings = solapiSettings(environment);
    if (!settings) {
      throw new PartnerRefusedError("laf:alimtalk_not_configured", 503);
    }
    return settings;
  }

  /**
   * A vendor refusal, carried across with its own code so the surface can tell them apart.
   *
   * Returns the error rather than throwing it, so every call site reads `throw refusalFor(error)`
   * and the compiler can see the branch ends there.
   */
  function refusalFor(error: unknown): unknown {
    if (error instanceof SolapiError) {
      // The vendor's code is the useful half and this deployment does not translate it. A
      // validation refusal on the 인증번호 step is a person mistyping; anything else is 502.
      const mistyped = error.code === "ValidationError";
      return new PartnerRefusedError(
        mistyped ? "laf:alimtalk_code_refused" : "laf:alimtalk_vendor_failed",
        mistyped ? 400 : 502,
        error.message,
      );
    }
    return error;
  }

  /** Register LAF's four under one channel, and record how each landed. Never throws. */
  async function registerStandardTemplates(input: {
    userId: string;
    senderKey: string;
  }): Promise<void> {
    const settings = requireSettings();
    const registered: string[] = [];
    for (const entry of STANDARD_TEMPLATES) {
      try {
        const result = await registerTemplate({
          settings,
          senderKey: input.senderKey,
          name: entry.name,
          content: entry.content,
        });
        await partners.recordTemplate({
          userId: input.userId,
          code: entry.code,
          templateId: result.templateId,
          status: result.status,
          reason: result.reason,
        });
        registered.push(entry.code);
      } catch {
        /*
         * Left unrecorded rather than recorded as pending.
         *
         * A row saying 심사 중 for a template the vendor never accepted is the card lying about a
         * wait that is not happening. Absent, the card offers "다시 시도" — and `refreshTemplates`
         * registers whatever is missing, so the recovery is one press.
         */
      }
    }
    if (registered.length > 0) {
      await recordAuditEvent(context.auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: PROVIDER,
        payload: {
          actor: input.userId,
          change: "alimtalk_templates_registered",
          server: PROVIDER,
          templates: registered,
          note: "Registered under this person's 발신프로필. Registration is not approval: 카카오 inspects each one, and nothing may be sent through it until it is approved.",
        },
      });
    }
  }

  /**
   * What the card draws. Safe to call for somebody who has connected nothing.
   *
   * A named function rather than a method on the object below, because two of those call it: a
   * method reached through `this` breaks the moment somebody destructures, which is how the routes
   * take these.
   */
  async function statusFor(userId: string): Promise<AlimtalkStatus> {
    const isConfigured = solapiSettings(environment) !== null;
    const connection = await partners.find(PROVIDER, userId);
    const rows = connection ? await partners.templatesFor(userId) : [];
    const byCode = new Map(rows.map((row) => [row.code, row]));
    return {
      isConfigured,
      connected: connection !== null,
      searchId:
        typeof connection?.details.searchId === "string"
          ? connection.details.searchId
          : null,
      connectedAt: connection?.connectedAt ?? null,
      /*
       * Every standard template, whether or not it has a row.
       *
       * A card drawn from the rows alone would silently shrink to three when one failed to register,
       * and the person would have no way to know a fourth was ever meant to be there.
       */
      templates: STANDARD_TEMPLATES.map((entry) => {
        const known = byCode.get(entry.code);
        return {
          code: entry.code,
          audience: entry.audience,
          status: known?.status ?? "pending",
          reason: known?.reason ?? "",
        };
      }),
    };
  }

  return {
    status: statusFor,

    /** Step one: the vendor sends a 인증번호 to the number the person gave. */
    async requestCode(input: {
      userId: string;
      searchId: string;
      phone: string;
    }): Promise<{ searchId: string }> {
      const settings = requireSettings();
      const searchId = normalizeSearchId(input.searchId);
      const phoneNumber = normalizePhone(input.phone);
      try {
        await requestChannelToken({ settings, searchId, phoneNumber });
      } catch (error) {
        throw refusalFor(error);
      }
      return { searchId };
    },

    /** Step two: the code, the 발신프로필 key, and LAF's templates under it. */
    async confirmCode(input: {
      userId: string;
      searchId: string;
      phone: string;
      code: string;
    }): Promise<AlimtalkStatus> {
      const settings = requireSettings();
      const searchId = normalizeSearchId(input.searchId);
      const phoneNumber = normalizePhone(input.phone);
      const token = input.code.trim();
      if (!/^[0-9A-Za-z]{4,12}$/.test(token)) {
        throw new PartnerRefusedError("laf:alimtalk_code_invalid");
      }

      const channel = await registerChannel({
        settings,
        searchId,
        phoneNumber,
        token,
      }).catch((error: unknown) => {
        throw refusalFor(error);
      });

      await partners.save({
        provider: PROVIDER,
        userId: input.userId,
        account: channel.senderKey,
        /*
         * The manager's number is kept because it is where the approval buzz goes.
         *
         * This deployment has one person on it (docs/laf/deployment-model.md), and the number they
         * proved they control during this flow is the one their own notifications should reach. It
         * is theirs, it never leaves this row, and it goes with them when they withdraw.
         */
        details: { searchId: channel.searchId, managerPhone: phoneNumber },
        // Never the senderKey. See the column's note.
        label: `channel:${channel.searchId}`,
      });

      await registerStandardTemplates({
        userId: input.userId,
        senderKey: channel.senderKey,
      });

      return await statusFor(input.userId);
    },

    /**
     * Ask the vendor where each template's inspection got to, and register any that are missing.
     *
     * Both halves in one call because they are one question from the card's side: "is this usable
     * yet". A template that failed to register during the connect is registered here, and one that
     * is waiting is asked about.
     */
    async refreshTemplates(userId: string): Promise<AlimtalkStatus> {
      const settings = requireSettings();
      const connection = await partners.find(PROVIDER, userId);
      if (!connection) {
        throw new PartnerRefusedError("laf:alimtalk_not_connected", 409);
      }
      const held = new Map(
        (await partners.templatesFor(userId)).map((row) => [row.code, row]),
      );

      for (const entry of STANDARD_TEMPLATES) {
        const known = held.get(entry.code);
        if (!known) {
          try {
            const result = await registerTemplate({
              settings,
              senderKey: connection.account,
              name: entry.name,
              content: entry.content,
            });
            await partners.recordTemplate({
              userId,
              code: entry.code,
              templateId: result.templateId,
              status: result.status,
              reason: result.reason,
            });
          } catch {
            // Still nothing to record. The card keeps offering the retry.
          }
          continue;
        }
        // An approved template is not asked about again: 카카오 does not un-approve one, and the
        // call would be a round trip per card render for an answer that cannot change.
        if (known.status === "approved") continue;
        try {
          const result = await readTemplate({
            settings,
            templateId: known.templateId,
          });
          await partners.recordTemplate({
            userId,
            code: entry.code,
            templateId: result.templateId,
            status: result.status,
            reason: result.reason,
          });
        } catch {
          // The vendor being unreachable leaves the status as it was, which is the honest answer:
          // nothing here learned anything, so nothing here should change.
        }
      }
      return await statusFor(userId);
    },

    /** One person dropping their channel. Nothing is withdrawn at the vendor; see `remove`. */
    async disconnect(userId: string): Promise<{ disconnected: boolean }> {
      return await partners.remove({
        provider: PROVIDER,
        userId,
        by: userId,
        reason: "person_disconnected",
      });
    },
  };
}

export type AlimtalkConnect = ReturnType<typeof createAlimtalkConnect>;
