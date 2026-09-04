/**
 * Connecting one business's 전자세금계산서, in the one form they actually fill in.
 *
 * 사업자등록번호, 상호, 대표자, and who to contact. That is the whole of it — no console, no LinkID,
 * no ID and no password, because the partner account at 팝빌 is LAF's and the business is joined as
 * a 연동회원 UNDER it (see `../partner-connections.ts`).
 *
 * THE MEMBER ID IS DERIVED AND THE PASSWORD IS MINTED AND FORGOTTEN. 팝빌 requires both at join
 * time. Asking a shop owner to invent a second set of credentials for a site they will never visit
 * is asking them to write it on a sticky note; and keeping the password here would mean holding a
 * secret for a login nothing in this product ever makes. So the id is `laf-<사업자등록번호>` — the
 * one value that is already unique per member and that a support conversation can reconstruct — and
 * the password is random bytes that exist for the length of one HTTP request.
 *
 * THE CERTIFICATE IS NEVER AUTOMATED. Registering a 공동인증서 means picking a file off the person's
 * own machine and typing its password. 팝빌 has a popup for exactly that, this asks for its address,
 * and the person opens it in their own browser. Nothing here drives it, watches it or reads it —
 * and the address it returns lasts thirty seconds and is never written down.
 *
 * WITHOUT A CERTIFICATE, NOTHING CAN BE ISSUED, and the card says so rather than letting somebody
 * find out when a Bot fails. That check is a read of 팝빌, stored on the row like the 알림톡
 * inspection status and for the same reason: a card that asked on every render would make drawing a
 * page depend on somebody else's server being up.
 */
import { recordAuditEvent } from "../../audit";
import {
  type PartnerConnections,
  type PartnerContext,
  PartnerRefusedError,
} from "../partner-connections";
import {
  certificateExpiry,
  checkIsMember,
  joinMember,
  memberPopupUrl,
  PopbillError,
  type PopbillSettings,
  popbillSettings,
} from "./popbill";

const PROVIDER = "tax-invoice" as const;

/** What the card draws, and every field of it is a fact. */
export type TaxStatus = {
  /** Whether this deployment holds LAF's 팝빌 LinkID at all. False hides the card. */
  isConfigured: boolean;
  /** True while this deployment talks to the test service, where nothing reaches the 국세청. */
  isTest: boolean;
  connected: boolean;
  /** The business's own 사업자등록번호, shown back to them because it is theirs and they typed it. */
  businessNumber: string | null;
  corpName: string | null;
  connectedAt: string | null;
  /**
   * Whether 팝빌 holds a 공동인증서 for this business, and until when.
   *
   * `checkedAt` is on it because a status is only as fresh as the last time somebody asked, and a
   * certificate expires on a date nothing here is watching.
   */
  certificate: {
    registered: boolean;
    expiresAt: string | null;
    checkedAt: string | null;
  };
};

/**
 * A 사업자등록번호, digits only.
 *
 * Hyphens dropped because every one of them is written `123-45-67890` somewhere. Ten digits exactly,
 * and refused otherwise: a nine-digit number is a typo and joining with it would register a member
 * under a number that is not the business's.
 *
 * THE CHECK DIGIT IS NOT VERIFIED HERE. 팝빌 rejects an invalid one and says so, and a second
 * implementation of the national rule in this file is a second thing to be wrong.
 */
export function normalizeBusinessNumber(raw: string): string {
  const digits = raw.replaceAll(/\D/g, "");
  if (!/^\d{10}$/.test(digits)) {
    throw new PartnerRefusedError("laf:tax_business_number_invalid");
  }
  return digits;
}

/** A contact number, digits only. Mobile or landline: 팝빌 asks for a 담당자 휴대폰 and takes both. */
export function normalizeContactPhone(raw: string): string {
  const digits = raw
    .trim()
    .replace(/^\+?82/, "0")
    .replaceAll(/\D/g, "");
  if (!/^0\d{8,10}$/.test(digits)) {
    throw new PartnerRefusedError("laf:tax_contact_phone_invalid");
  }
  return digits;
}

/**
 * An address 팝빌 will mail to.
 *
 * Deliberately shallow — an `@`, a dot after it, no spaces. Anything stricter is a rule that refuses
 * somebody's real address, and 팝빌 is the one that has to be able to deliver to it.
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new PartnerRefusedError("laf:tax_contact_email_invalid");
  }
  return trimmed;
}

/** The member id for one business. Derived, never chosen. See the module note. */
export function memberIdFor(businessNumber: string): string {
  return `laf-${businessNumber}`;
}

/**
 * A password that satisfies 팝빌's rule and is then forgotten.
 *
 * Eight to twenty characters with a letter, a digit and a symbol from the set 팝빌 names. Built by
 * construction rather than by generating and testing, so it cannot loop and cannot occasionally
 * produce one that is refused — a join that failed on a password nobody will ever type would be the
 * most confusing failure in this flow.
 */
export function mintMemberPassword(
  randomBytes: (count: number) => Uint8Array = (count) =>
    crypto.getRandomValues(new Uint8Array(count)),
): string {
  const letters = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const symbols = "~!@#$%^&*()_+";
  const alphabet = letters + digits + symbols;
  const bytes = randomBytes(16);
  const pick = (source: string, at: number) =>
    source[(bytes[at] ?? 0) % source.length] ?? source[0] ?? "";
  return [
    pick(letters, 0),
    pick(digits, 1),
    pick(symbols, 2),
    ...Array.from({ length: 13 }, (_value, index) => pick(alphabet, index + 3)),
  ].join("");
}

export function createTaxConnect(
  context: PartnerContext,
  partners: PartnerConnections,
  environment: Record<string, string | undefined> = process.env,
) {
  /**
   * LAF's LinkID, or the refusal for holding none.
   *
   * 503 rather than 400: nothing the person types can fix it, and a card offering a 연결 button in
   * this state would be a control that saves and does nothing.
   */
  function requireSettings(): PopbillSettings {
    const settings = popbillSettings(environment);
    if (!settings) {
      throw new PartnerRefusedError("laf:tax_not_configured", 503);
    }
    return settings;
  }

  /** A vendor refusal, carried across with a code of ours so the surface can tell them apart. */
  function refusalFor(error: unknown): unknown {
    if (error instanceof PopbillError) {
      /*
       * The clock, told apart from everything else, because it is the one failure an operator can
       * fix and the one that reads as a signature bug. 팝빌 answers -99010004 when the signed
       * timestamp is outside its window, which on a VM means the host clock has drifted.
       */
      if (error.code === -99010004) {
        return new PartnerRefusedError(
          "laf:tax_clock_skew",
          502,
          error.message,
        );
      }
      return new PartnerRefusedError(
        "laf:tax_vendor_failed",
        502,
        error.message,
      );
    }
    return error;
  }

  /**
   * What the card draws. Safe to call for somebody who has connected nothing.
   *
   * A named function rather than a method, because three of the others call it: a method reached
   * through `this` breaks the moment somebody destructures, which is how the routes take these.
   */
  async function statusFor(userId: string): Promise<TaxStatus> {
    const settings = popbillSettings(environment);
    const connection = await partners.find(PROVIDER, userId);
    const details = connection?.details ?? {};
    const certificate = (details.certificate ?? {}) as {
      registered?: boolean;
      expiresAt?: string | null;
      checkedAt?: string | null;
    };
    return {
      isConfigured: settings !== null,
      isTest: settings?.isTest ?? true,
      connected: connection !== null,
      // The account column holds the 사업자등록번호 for this provider. It is the business's own
      // number, which they typed and which is on every invoice they have ever issued.
      businessNumber: connection?.account ?? null,
      corpName: typeof details.corpName === "string" ? details.corpName : null,
      connectedAt: connection?.connectedAt ?? null,
      certificate: {
        registered: certificate.registered === true,
        expiresAt: certificate.expiresAt ?? null,
        checkedAt: certificate.checkedAt ?? null,
      },
    };
  }

  /** Ask 팝빌 about the certificate and fold the answer into the row. Never throws. */
  async function refreshCertificateFor(
    settings: PopbillSettings,
    userId: string,
    corpNum: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    let expiresAt: string | null = null;
    try {
      expiresAt = await certificateExpiry({ settings, corpNum });
    } catch {
      /*
       * The vendor being unreachable leaves the row as it was, which is the honest answer: nothing
       * here learned anything, so nothing here should change. A `registered: false` written on an
       * outage would tell somebody to go and register a certificate they already have.
       */
      return;
    }
    await partners.save({
      provider: PROVIDER,
      userId,
      account: corpNum,
      details: {
        ...details,
        certificate: {
          registered: expiresAt !== null,
          expiresAt,
          checkedAt: new Date().toISOString(),
        },
      },
      // Never the number. The trail says which connector, not whose business.
      label: "member:joined",
    });
  }

  return {
    status: statusFor,

    /**
     * Join this business as a 연동회원 under LAF's LinkID, or adopt one that already is.
     *
     * ASKED BEFORE IT IS DONE. A business already joined under LAF — somebody reconnecting, somebody
     * whose earlier attempt wrote at the vendor and failed here — is adopted rather than joined
     * again, because a second join is refused at 팝빌 with a code that reads as the business being
     * at fault.
     */
    async join(input: {
      userId: string;
      businessNumber: string;
      corpName: string;
      ceoName: string;
      contactName: string;
      contactPhone: string;
      contactEmail: string;
      address?: string;
      bizType?: string;
      bizClass?: string;
    }): Promise<TaxStatus> {
      const settings = requireSettings();
      const corpNum = normalizeBusinessNumber(input.businessNumber);
      const member = {
        corpNum,
        corpName: input.corpName.trim(),
        ceoName: input.ceoName.trim(),
        address: input.address?.trim() ?? "",
        // 업태 and 종목 are required by 팝빌 and are not on the card: a shop owner reading a form
        // that asks for both, to connect a Bot, is a form they abandon. What goes up is what the
        // person can be asked for later on an invoice, and 팝빌 takes a placeholder here.
        bizType: input.bizType?.trim() || "기타",
        bizClass: input.bizClass?.trim() || "기타",
        contactName: input.contactName.trim(),
        contactPhone: normalizeContactPhone(input.contactPhone),
        contactEmail: normalizeEmail(input.contactEmail),
      };

      let alreadyMember: boolean;
      try {
        alreadyMember = await checkIsMember({ settings, corpNum });
      } catch (error) {
        throw refusalFor(error);
      }

      if (!alreadyMember) {
        try {
          await joinMember({
            settings,
            member,
            id: memberIdFor(corpNum),
            // Minted here and referenced nowhere else. It leaves this scope on one HTTP request.
            password: mintMemberPassword(),
          });
        } catch (error) {
          throw refusalFor(error);
        }
      }

      const details: Record<string, unknown> = {
        corpName: member.corpName,
        ceoName: member.ceoName,
        contactName: member.contactName,
        // Kept because 팝빌 mails the recipient's copy and a support question about a bounced
        // invoice is answered by it. Never in an audit payload and never in a tool result.
        contactEmail: member.contactEmail,
        certificate: { registered: false, expiresAt: null, checkedAt: null },
      };
      await partners.save({
        provider: PROVIDER,
        userId: input.userId,
        account: corpNum,
        details,
        // The fact, not the number: the trail says a business joined, not which one.
        label: alreadyMember ? "member:adopted" : "member:joined",
      });

      await recordAuditEvent(context.auditStore, {
        eventType: "configuration.changed",
        targetType: "mcp_server",
        targetId: PROVIDER,
        payload: {
          actor: input.userId,
          change: "tax_member_joined",
          server: PROVIDER,
          adopted: alreadyMember,
          // Said out loud rather than left to be assumed: this deployment is talking to the test
          // service, where an issued 세금계산서 reaches nobody.
          service: settings.isTest ? "test" : "production",
          note: "Joined under LAF's 팝빌 LinkID. Nothing can be issued until the business registers its own 공동인증서 through 팝빌's popup.",
        },
      });

      await refreshCertificateFor(settings, input.userId, corpNum, details);
      return await statusFor(input.userId);
    },

    /**
     * The address of 팝빌's certificate popup, for the person to open in their own window.
     *
     * NOT RETURNED TO ANYBODY BUT THE PERSON WHO ASKED, and not written down anywhere. It carries a
     * live session and lasts thirty seconds — see `memberPopupUrl`.
     */
    async certificateUrl(input: {
      userId: string;
      kind: "certificate" | "seal";
    }): Promise<{ url: string }> {
      const settings = requireSettings();
      const connection = await partners.find(PROVIDER, input.userId);
      if (!connection) {
        throw new PartnerRefusedError("laf:tax_not_connected", 409);
      }
      try {
        const url = await memberPopupUrl({
          settings,
          corpNum: connection.account,
          target: input.kind === "seal" ? "SEAL" : "CERT",
        });
        return { url };
      } catch (error) {
        throw refusalFor(error);
      }
    },

    /** Ask 팝빌 whether the certificate is registered now, and until when. */
    async refreshCertificate(userId: string): Promise<TaxStatus> {
      const settings = requireSettings();
      const connection = await partners.find(PROVIDER, userId);
      if (!connection) {
        throw new PartnerRefusedError("laf:tax_not_connected", 409);
      }
      await refreshCertificateFor(
        settings,
        userId,
        connection.account,
        connection.details,
      );
      return await statusFor(userId);
    },

    /** One person dropping their registration. Nothing is withdrawn at 팝빌; see `remove`. */
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

export type TaxConnect = ReturnType<typeof createTaxConnect>;
