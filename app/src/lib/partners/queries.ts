import { queryOptions } from "@tanstack/react-query";

/**
 * What the 알림톡 and 세금계산서 cards ask the server, and nothing else.
 *
 * THIS MODULE HOLDS NO WORDS. Every field below is a fact — connected or not, which template is
 * still being inspected, whether a certificate is registered — and every sentence a person reads
 * about them is written in the component, in Korean. The server sends `laf:` codes for its
 * refusals and this turns them into nothing: the component decides what each one says.
 *
 * A DEPLOYMENT WITH NEITHER KEY ANSWERS WITH AN EMPTY LIST, and a deployment with no partner
 * runtime at all answers 404. Both mean the same thing to this screen — no partner cards — which is
 * why the 404 is not an error here. A real failure still throws, so a broken deployment does not
 * masquerade as an unconfigured one.
 */

/** Which partner. The catalogue key, so one word names the row, the tools and the card. */
export type PartnerId = "kakao-alimtalk" | "tax-invoice";

/** Where 카카오's inspection of one of LAF's templates got to. */
export type TemplateStatus = "pending" | "approved" | "rejected";

export type AlimtalkStatus = {
  isConfigured: boolean;
  connected: boolean;
  /** The 검색용 아이디 the person typed, shown back to them. The 발신프로필 key never crosses. */
  searchId: string | null;
  connectedAt: string | null;
  templates: {
    code: string;
    /** `owner` templates are the app's own buzz; `customer` ones are what a Bot may send. */
    audience: "owner" | "customer";
    status: TemplateStatus;
    /** 카카오's own words when it refused one. The only vendor prose this screen shows. */
    reason: string;
  }[];
};

export type TaxStatus = {
  isConfigured: boolean;
  /** True while this deployment talks to 팝빌's test service, where nothing reaches the 국세청. */
  isTest: boolean;
  connected: boolean;
  /** The business's own 사업자등록번호, which they typed and which is on every invoice they issue. */
  businessNumber: string | null;
  corpName: string | null;
  connectedAt: string | null;
  certificate: {
    registered: boolean;
    expiresAt: string | null;
    checkedAt: string | null;
  };
};

export type PartnerCard =
  | {
      id: "kakao-alimtalk";
      title: string;
      summary: string;
      docsUrl: string;
      status: AlimtalkStatus;
    }
  | {
      id: "tax-invoice";
      title: string;
      summary: string;
      docsUrl: string;
      status: TaxStatus;
    };

export const partnerKeys = {
  all: ["partners"] as const,
  list: () => ["partners", "list"] as const,
};

export function partnersQueryOptions() {
  return queryOptions({
    queryKey: partnerKeys.list(),
    queryFn: async (): Promise<PartnerCard[]> => {
      const response = await fetch("/api/partners", { credentials: "include" });
      // A deployment with no partner runtime does not mount these routes. Not an error worth a red
      // line across somebody's settings screen — there is simply nothing here to connect.
      if (response.status === 404) return [];
      if (!response.ok) throw new Error("Could not load partner connections");
      return ((await response.json()) as { partners: PartnerCard[] }).partners;
    },
  });
}

/**
 * What the server would not do, as a code rather than a sentence.
 *
 * `ok: false` carries the `laf:` fact the server sent. The component maps it; an unmapped code
 * falls back to a general line, which is the visible-and-fixable failure rather than a blank card.
 */
export type PartnerOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: string };

async function post<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<PartnerOutcome<T>> {
  const response = await fetch(`/api/partners${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await response.json().catch(() => null)) as
    | (T & { code?: string })
    | null;
  if (!response.ok) {
    return { ok: false, code: parsed?.code ?? "laf:partner_unreachable" };
  }
  return { ok: true, value: (parsed ?? {}) as T };
}

/** Step one: 솔라피 sends a 인증번호 to the 담당자's phone. Nothing is stored yet. */
export const requestAlimtalkCode = (searchId: string, phone: string) =>
  post<{ searchId: string }>("/kakao-alimtalk/code", { searchId, phone });

/** Step two: the code, the channel, and LAF's four templates registered under it. */
export const confirmAlimtalkCode = (
  searchId: string,
  phone: string,
  code: string,
) =>
  post<{ status: AlimtalkStatus }>("/kakao-alimtalk/connect", {
    searchId,
    phone,
    code,
  });

/** Ask 카카오 where each template's inspection got to. */
export const refreshAlimtalkTemplates = () =>
  post<{ status: AlimtalkStatus }>("/kakao-alimtalk/refresh");

/** The 팝빌 연동회원 join. No id and no password is asked for or sent back. */
export const joinTaxMember = (member: {
  businessNumber: string;
  corpName: string;
  ceoName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  address?: string;
}) => post<{ status: TaxStatus }>("/tax-invoice/connect", { ...member });

/**
 * The address of 팝빌's own certificate popup.
 *
 * ASKED AT THE MOMENT OF THE PRESS, never on page load: the URL carries a live session and 팝빌
 * gives it thirty seconds. Fetched and opened in the same gesture, and never stored.
 */
export const taxCertificateUrl = (kind: "certificate" | "seal") =>
  post<{ url: string }>("/tax-invoice/certificate-url", { kind });

/** Ask 팝빌 whether the certificate is registered now, and until when. */
export const refreshTaxCertificate = () =>
  post<{ status: TaxStatus }>("/tax-invoice/refresh");

/** One person dropping their own registration. Nothing is withdrawn at the vendor. */
export const disconnectPartner = (id: PartnerId) =>
  post<{ disconnected: boolean }>(`/${id}/disconnect`);
