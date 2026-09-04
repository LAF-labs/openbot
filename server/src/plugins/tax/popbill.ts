/**
 * The one place that speaks 팝빌, and the one place that holds LAF's LinkID.
 *
 * WHY THERE IS NO SDK. 팝빌 publishes one, and it carries a token cache, a point ledger, sixty-odd
 * services and a dependency on a second package for the auth server. What this connector needs is
 * six calls. A dependency whose surface is a hundred times the part in use is a hundred times the
 * surface to review, and the auth scheme below is forty lines. So it is written here, from the
 * published REST reference (developers.popbill.com/api-reference/taxinvoice), and every field name
 * in this file was read off that reference rather than off a sample.
 *
 * TWO SERVERS, AND ONLY ONE OF THEM HAS A TEST HALF. `auth.linkhub.co.kr` issues session tokens for
 * both environments and has no test hostname at all — which environment you are in is the SERVICE
 * ID in the path (`POPBILL_TEST` or `POPBILL`), not the host. Getting that wrong is the failure that
 * looks like a signature problem: the auth server answers, the token is real, and it is a token for
 * the other environment.
 *
 * NOTHING HERE READS A DATABASE OR DECIDES ANYTHING. It takes settings, makes a call and returns
 * what came back. Whose invoice, whether a person was asked, and what a Bot may do with it are all
 * `connect.ts` and `tools.ts`.
 */

/** How long any one vendor call may take. Ten seconds, the same bound every other door uses. */
const CALL_TIMEOUT_MS = 10_000;

/** Where session tokens are issued. There is no test variant of this host — see the module note. */
export const LINKHUB_AUTH_URL = "https://auth.linkhub.co.kr";

/** The two 팝빌 API hosts, chosen by `POPBILL_TEST`. */
export const POPBILL_TEST_URL = "https://popbill-test.linkhub.co.kr";
export const POPBILL_PRODUCTION_URL = "https://popbill.linkhub.co.kr";

/**
 * 팝빌's Linkhub protocol version, sent and signed.
 *
 * A constant rather than a setting, because it decides the hash: 2.0 signs a SHA-256 body digest
 * and an earlier scheme signed an MD5 one. A deployment that could change this would be able to
 * choose a weaker signature by editing an environment variable.
 */
const LINKHUB_VERSION = "2.0";

/**
 * What LAF's session token is allowed to do. `member` plus 전자세금계산서's own code.
 *
 * Narrow on purpose, the same reasoning as an OAuth scope: `140` would add 현금영수증 and `150` SMS,
 * and a token that can do things this connector never does is a permission nobody agreed to.
 */
const TAXINVOICE_SCOPES = ["member", "110"] as const;

/**
 * The facts about 팝빌 that this fork has NOT run against a live partner account.
 *
 * Exported as data rather than left in prose, because a comment is not a checklist and this is one.
 * `docs/laf/connections.md` prints it and a test asserts it is not empty, so deleting an entry is a
 * deliberate act by somebody who has actually made the call with LAF's own LinkID.
 *
 * Everything NOT on this list was read off the published reference and, where it needs no partner
 * credential, probed against the sandbox: the signature layout, the two hosts, the error shape, the
 * unauthenticated `/Join` pair, and the header table.
 */
export const POPBILL_UNVERIFIED: readonly {
  call: string;
  what: string;
}[] = Object.freeze([
  {
    call: "joinMember",
    what: "Whether a business already registered under ANOTHER partner's LinkID can be joined under LAF's, and which code 팝빌 refuses that with. `checkIsMember` is asked first and a refusal is surfaced rather than retried, so the failure is visible rather than silent.",
  },
  {
    call: "joinMember",
    what: "The charset 팝빌 accepts in `ID`. The reference states the 6–50 length and no charset rule, so the derived id uses letters, digits and a hyphen only.",
  },
  {
    call: "memberPopupUrl",
    what: "That the returned URL opens 팝빌's own certificate registration for the member the session token names. The 30-second validity is documented; what the page then does has never been watched.",
  },
  {
    call: "issueTaxinvoice",
    what: "That a 정발행 issued through this path reaches the 국세청 as expected. The test service accepts and reports it; production has never been called.",
  },
]);

/** LAF's fleet-wide 팝빌 partner account, as the environment carries it. */
export type PopbillSettings = {
  linkId: string;
  secretKey: string;
  /** True while this deployment talks to the test service, where nothing reaches the 국세청. */
  isTest: boolean;
  /** Where the invoices are. */
  apiBaseUrl: string;
  /** Where session tokens come from. One host for both environments. */
  authBaseUrl: string;
  /** `POPBILL_TEST` or `POPBILL`. The path segment that decides which environment. */
  serviceId: string;
};

/**
 * The partner account out of the environment, or null when this deployment has none.
 *
 * `POPBILL_TEST` defaults to the TEST service, which is the direction a mistake should go: a
 * deployment somebody stood up to try things out must not be able to issue a real 세금계산서 to the
 * 국세청 because a variable was left unset. `server/src/config.ts` refuses to start on a value that
 * is neither word, so "true" is the only spelling of true and everything else is a boot failure
 * rather than a silent production.
 */
export function popbillSettings(
  environment: Record<string, string | undefined> = process.env,
): PopbillSettings | null {
  const linkId = environment.POPBILL_LINK_ID?.trim();
  const secretKey = environment.POPBILL_SECRET_KEY?.trim();
  if (!linkId || !secretKey) return null;
  const isTest = environment.POPBILL_TEST?.trim() !== "false";
  return {
    linkId,
    secretKey,
    isTest,
    apiBaseUrl:
      environment.POPBILL_BASE_URL?.trim() ||
      (isTest ? POPBILL_TEST_URL : POPBILL_PRODUCTION_URL),
    authBaseUrl: environment.POPBILL_AUTH_URL?.trim() || LINKHUB_AUTH_URL,
    serviceId: isTest ? "POPBILL_TEST" : "POPBILL",
  };
}

/**
 * A call 팝빌 refused, with the vendor's own numeric code kept as a value.
 *
 * The code rather than the sentence, for the reason this repository has written down three times:
 * a caller that branches on prose breaks when the prose is reworded — and 팝빌 genuinely translates
 * its messages on `Accept-Language`. The code is what tells a clock-skew failure (-99010004) from a
 * signature failure (-99010007) from a business that is not a member (-10010006).
 */
export class PopbillError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "PopbillError";
  }
}

const encoder = new TextEncoder();

function base64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The moment, in the only spelling the auth server accepts: `yyyy-MM-ddTHH:mm:ssZ`, UTC.
 *
 * Milliseconds dropped. Both spellings are accepted by the server as long as the header and the
 * signed line agree — and they agree here because both come from this one function, which is the
 * property worth having rather than the format itself.
 */
function linkhubDate(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

/**
 * Linkhub's `Authorization` header for the token request.
 *
 * The canonical string is six lines and every one of them is also a header or the path, so the
 * server can rebuild it. Written out rather than assembled in a loop because the ORDER is the
 * protocol and a loop invites somebody to sort it:
 *
 *   POST \n  base64(sha256(body)) \n  X-LH-Date \n  X-LH-Forwarded \n  2.0 \n  /<serviceId>/Token
 *
 * The last line carries no newline after it.
 *
 * `X-LH-Forwarded` IS ALWAYS SENT, as `*`. The header is optional, and when it is omitted its line
 * is omitted from the canonical string too rather than left blank — an ambiguity that produces a
 * signature mismatch nothing in the answer explains. Sending it always removes the branch. `*` means
 * the token is usable from any address, which is what a fleet of VMs with changing egress needs.
 *
 * The secret is BASE64-DECODED to raw bytes before it is used as a key. Signing with the printable
 * form instead produces a well-formed signature the server rejects, which is the other failure that
 * looks like a protocol misunderstanding.
 */
export async function linkhubAuthorization(input: {
  settings: PopbillSettings;
  body: string;
  date: string;
  forwarded: string;
}): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(input.body),
  );
  const canonical = [
    "POST",
    base64(digest),
    input.date,
    input.forwarded,
    LINKHUB_VERSION,
    `/${input.settings.serviceId}/Token`,
  ].join("\n");

  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64(input.settings.secretKey) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(canonical),
  );
  return `LINKHUB ${input.settings.linkId} ${base64(signed)}`;
}

/** A session token and when it stops working. */
export type LinkhubToken = { token: string; expiresAt: number };

/**
 * How long before a token's stated expiry this deployment goes and gets another.
 *
 * Two minutes. 팝빌's own SDK refreshes only AFTER the expiry has passed, with no margin at all,
 * which is a race every long call can lose: the token is valid when the check runs and dead when the
 * request lands. A token costs one round trip and an expired one costs a failed issue.
 */
const TOKEN_MARGIN_MS = 120_000;

/**
 * One session token per 사업자등록번호, cached in this process.
 *
 * PER BUSINESS, NOT PER DEPLOYMENT. The token names the member it was issued for — `access_id` is
 * the 사업자등록번호 — so one cache entry serving two businesses would issue one business's invoice
 * under the other's number. In this deployment shape there is only ever one (one VM per person), and
 * the map is keyed anyway because the failure it prevents is not one anybody would notice.
 *
 * In-process on purpose, like the approval registry and the repeat counter: one API server process
 * per VM (docs/laf/deployment-model.md). A restart costs one round trip.
 */
const tokens = new Map<string, LinkhubToken>();

/** Every cached token, gone. For a test that must not inherit another test's session. */
export function forgetPopbillTokens(): void {
  tokens.clear();
}

/**
 * A session token for this business, from the cache or from the auth server.
 *
 * `now` is injected so a test can drive the expiry without waiting half an hour for one.
 */
export async function linkhubToken(input: {
  settings: PopbillSettings;
  /** The member's 사업자등록번호, digits only. */
  corpNum: string;
  now?: () => Date;
}): Promise<string> {
  const now = input.now ?? (() => new Date());
  const cacheKey = `${input.settings.serviceId}:${input.settings.linkId}:${input.corpNum}`;
  const held = tokens.get(cacheKey);
  if (held && held.expiresAt - TOKEN_MARGIN_MS > now().getTime()) {
    return held.token;
  }

  /*
   * The body string is built ONCE and both hashed and sent.
   *
   * Re-serialising it for the wire is how a digest stops matching the bytes: a different key order,
   * a space, and the signature is over something the server never saw. The same discipline 팝빌's
   * own bulk endpoint demands in writing.
   */
  const body = JSON.stringify({
    access_id: input.corpNum,
    scope: [...TAXINVOICE_SCOPES],
  });
  const date = linkhubDate(now());
  const forwarded = "*";
  const authorization = await linkhubAuthorization({
    settings: input.settings,
    body,
    date,
    forwarded,
  });

  const answered = await callJson<{
    session_token?: string;
    expiration?: string;
  }>({
    url: `${input.settings.authBaseUrl.replace(/\/$/, "")}/${input.settings.serviceId}/Token`,
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-lh-version": LINKHUB_VERSION,
      "x-lh-date": date,
      "x-lh-forwarded": forwarded,
    },
    body,
  });

  const token = answered.session_token;
  if (!token) {
    throw new PopbillError(
      "the auth server answered without a session token",
      200,
      null,
    );
  }
  /*
   * An unparseable expiry is treated as one minute rather than as forever.
   *
   * The documented format carries milliseconds in the vendor's own example and not in its own
   * specification, so this parses leniently — and where it cannot, a short life means the next call
   * fetches a fresh token, which is the recoverable direction. Caching a token with an expiry of
   * `NaN` would make every later comparison false and the cache permanent.
   */
  const parsed = Date.parse(answered.expiration ?? "");
  tokens.set(cacheKey, {
    token,
    expiresAt: Number.isNaN(parsed) ? now().getTime() + 60_000 : parsed,
  });
  return token;
}

type JsonCall = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
};

/**
 * One request, one answer, and every failure turned into {@link PopbillError}.
 *
 * A non-2xx carries 팝빌's numeric `code`. A 200 whose body says `code` is negative is ALSO a
 * failure: the two `/Join` companions answer 200 with a code that is data, and everything else
 * answers `code: 1` on success — so a caller that read only the HTTP status would take
 * `{"code":-11000005}` for a document that exists.
 *
 * A body that is not JSON is refused rather than guessed at. An HTML error page parsed leniently is
 * how a connector reports success at a proxy.
 */
async function callJson<T>(call: JsonCall): Promise<T> {
  let response: Response;
  try {
    response = await fetch(call.url, {
      method: call.method,
      headers: call.headers,
      ...(call.body === undefined ? {} : { body: call.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PopbillError(
      error instanceof Error ? error.message : String(error),
      0,
      null,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new PopbillError(
      "팝빌 answered with something that is not JSON",
      response.status,
      null,
    );
  }

  const body = parsed as { code?: number; message?: string };
  if (!response.ok) {
    throw new PopbillError(
      body.message ?? `팝빌 answered ${response.status}`,
      response.status,
      typeof body.code === "number" ? body.code : null,
    );
  }
  return parsed as T;
}

/** An authenticated call to the 팝빌 API host, as this connector makes one. */
async function callPopbill<T>(input: {
  settings: PopbillSettings;
  corpNum: string;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown> | unknown[];
  /** `ISSUE`, `DELETE`, … — how 팝빌 tells two operations on one URL apart. */
  override?: string;
  now?: () => Date;
}): Promise<T> {
  const token = await linkhubToken({
    settings: input.settings,
    corpNum: input.corpNum,
    ...(input.now ? { now: input.now } : {}),
  });
  const serialised =
    input.body === undefined ? undefined : JSON.stringify(input.body);
  return await callJson<T>({
    url: `${input.settings.apiBaseUrl.replace(/\/$/, "")}${input.path}`,
    method: input.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(serialised === undefined
        ? {}
        : { "content-type": "application/json" }),
      // Korean, because the code is what this fork branches on and the message is only ever logged.
      "accept-language": "ko-KR",
      ...(input.override ? { "x-http-method-override": input.override } : {}),
    },
    ...(serialised === undefined ? {} : { body: serialised }),
  });
}

/**
 * Is this business already a 연동회원 under LAF's LinkID?
 *
 * UNAUTHENTICATED, and it has to be: there is no session token for a member who has not joined, so
 * this is the one question that can be asked before there is anything to sign with.
 *
 * `code` here is DATA, not a status — 1 means joined and 0 means not. That inversion of the usual
 * convention is why this does not go through the shared success check.
 */
export async function checkIsMember(input: {
  settings: PopbillSettings;
  corpNum: string;
}): Promise<boolean> {
  const answered = await callJson<{ code?: number }>({
    url: `${input.settings.apiBaseUrl.replace(/\/$/, "")}/Join?CorpNum=${encodeURIComponent(input.corpNum)}&LID=${encodeURIComponent(input.settings.linkId)}`,
    method: "GET",
    headers: { "accept-language": "ko-KR" },
  });
  return answered.code === 1;
}

/** What a business tells 팝빌 about itself, which is what it would tell any 세금계산서 form. */
export type PopbillMember = {
  corpNum: string;
  corpName: string;
  ceoName: string;
  address: string;
  bizType: string;
  bizClass: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
};

/**
 * Join this business as a 연동회원 under LAF's LinkID.
 *
 * UNAUTHENTICATED for the same reason `checkIsMember` is. The `ID` and `Password` are minted by the
 * caller (`connect.ts`) and are not stored anywhere: nothing in this product ever signs into 팝빌's
 * own site as the business, and a password kept for a login nobody makes is a secret held for
 * nothing.
 */
export async function joinMember(input: {
  settings: PopbillSettings;
  member: PopbillMember;
  /** 6–50 characters. Derived from the business number; see `connect.ts`. */
  id: string;
  /** 8–20 characters with a letter, a digit and a symbol. Minted and forgotten. */
  password: string;
}): Promise<void> {
  await callJson<{ code?: number }>({
    url: `${input.settings.apiBaseUrl.replace(/\/$/, "")}/Join`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-language": "ko-KR",
    },
    body: JSON.stringify({
      ID: input.id,
      Password: input.password,
      LinkID: input.settings.linkId,
      CorpNum: input.member.corpNum,
      CEOName: input.member.ceoName,
      CorpName: input.member.corpName,
      Addr: input.member.address,
      BizType: input.member.bizType,
      BizClass: input.member.bizClass,
      ContactName: input.member.contactName,
      ContactEmail: input.member.contactEmail,
      // `ContactTEL`, capitalised exactly so. There is no `ContactHP` in the REST body: the
      // reference's own example carries the 담당자 휴대폰 in this field.
      ContactTEL: input.member.contactPhone,
    }),
  });
}

/** When the business's 공동인증서 expires, or null when 팝빌 holds none for it. */
export async function certificateExpiry(input: {
  settings: PopbillSettings;
  corpNum: string;
}): Promise<string | null> {
  /*
   * `?cfg=CERT` on the collection path, which is the same base path a search uses.
   *
   * Not a mistake and not ours: 팝빌 routes several operations onto one URL and tells them apart by
   * a query parameter or by `X-HTTP-Method-Override`. Written out here so nobody "tidies" it into
   * `/Taxinvoice/CERT` and gets a search for a document called CERT.
   */
  const answered = await callPopbill<{ certificateExpiration?: string }>({
    settings: input.settings,
    corpNum: input.corpNum,
    method: "GET",
    path: "/Taxinvoice?cfg=CERT",
  }).catch((error: unknown) => {
    // A member with no certificate registered is not a failure of this call; it is the answer.
    if (error instanceof PopbillError && error.code !== null) return null;
    throw error;
  });
  const raw = answered?.certificateExpiration?.trim();
  if (!raw || !/^\d{14}$/.test(raw)) return null;
  // `yyyyMMddHHmmss`, KST, turned into the ISO instant every surface here reads.
  const asIso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+09:00`;
  const parsed = Date.parse(asIso);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * The address of 팝빌's own popup, for the person to open themselves.
 *
 * THE URL IS A CREDENTIAL AND LASTS THIRTY SECONDS. It carries a live session, so it is handed
 * straight to the browser that asked for it and is never logged, never stored and never put in an
 * audit payload. Thirty seconds is 팝빌's number, not a guess, and it is why the card asks for the
 * URL at the moment of the press rather than when the page loads.
 *
 * `CERT` is the 공동인증서 registration; `SEAL` is the 인감·사업자등록증·통장사본 upload.
 */
export async function memberPopupUrl(input: {
  settings: PopbillSettings;
  corpNum: string;
  target: "CERT" | "SEAL";
}): Promise<string> {
  const answered = await callPopbill<{ url?: string }>({
    settings: input.settings,
    corpNum: input.corpNum,
    method: "GET",
    path: `/Member?TG=${input.target}`,
  });
  const url = answered.url?.trim();
  if (!url) {
    throw new PopbillError("팝빌 returned no popup address", 200, null);
  }
  return url;
}

/** One row of a 세금계산서 listing, as far as anything outside this module needs to know. */
export type TaxinvoiceSummary = {
  itemKey: string;
  mgtKey: string;
  writeDate: string;
  /** 100 임시저장, 300 발행완료, … See the state table in `tools.ts`. */
  stateCode: number;
  supplyCostTotal: string;
  taxTotal: string;
  invoiceeCorpName: string;
  invoiceeCorpNum: string;
  /** The 국세청 approval number, once it has one. */
  ntsConfirmNum: string;
};

type RawSummary = {
  itemKey?: string;
  invoicerMgtKey?: string;
  invoiceeMgtKey?: string;
  writeDate?: string;
  stateCode?: number | string;
  supplyCostTotal?: string | number;
  taxTotal?: string | number;
  invoiceeCorpName?: string;
  invoiceeCorpNum?: string;
  /*
   * BOTH SPELLINGS, because 팝빌 genuinely uses two. The listing and the detail answer
   * `ntsconfirmNum`; the issue call answers `ntsConfirmNum`. Reading only one of them would leave
   * the approval number blank on whichever half somebody looked at second.
   */
  ntsconfirmNum?: string;
  ntsConfirmNum?: string;
};

function toSummary(row: RawSummary, keyType: TaxinvoiceKeyType) {
  return {
    itemKey: row.itemKey ?? "",
    // Whose document number this is depends on which side of the invoice was asked about.
    mgtKey: (keyType === "BUY" ? row.invoiceeMgtKey : row.invoicerMgtKey) ?? "",
    writeDate: row.writeDate ?? "",
    // Documented `string(3)` and returned as a number in the reference's own example. Both.
    stateCode: Number(row.stateCode ?? 0),
    supplyCostTotal: String(row.supplyCostTotal ?? ""),
    taxTotal: String(row.taxTotal ?? ""),
    invoiceeCorpName: row.invoiceeCorpName ?? "",
    invoiceeCorpNum: row.invoiceeCorpNum ?? "",
    ntsConfirmNum: row.ntsConfirmNum ?? row.ntsconfirmNum ?? "",
  } satisfies TaxinvoiceSummary;
}

/** Which side of an invoice a document number belongs to. `TRUSTEE` is 위수탁. */
export type TaxinvoiceKeyType = "SELL" | "BUY" | "TRUSTEE";

/**
 * A page of this business's 세금계산서.
 *
 * The search window is six months at the vendor, which is checked in `tools.ts` where there is
 * somebody to tell rather than here.
 */
export async function searchTaxinvoices(input: {
  settings: PopbillSettings;
  corpNum: string;
  keyType: TaxinvoiceKeyType;
  /** `R` 등록일자, `W` 작성일자, `I` 발행일자. */
  dateType: "R" | "W" | "I";
  /** `yyyyMMdd`. */
  from: string;
  to: string;
  page: number;
  perPage: number;
}): Promise<{ total: number; page: number; list: TaxinvoiceSummary[] }> {
  const query = new URLSearchParams({
    DType: input.dateType,
    SDate: input.from,
    EDate: input.to,
    Page: String(input.page),
    PerPage: String(input.perPage),
    // Newest first. A shop owner asking "what did we issue" means the recent ones.
    Order: "D",
  });
  const answered = await callPopbill<{
    total?: number;
    pageNum?: number;
    list?: RawSummary[];
  }>({
    settings: input.settings,
    corpNum: input.corpNum,
    method: "GET",
    path: `/Taxinvoice/${input.keyType}?${query.toString()}`,
  });
  return {
    total: answered.total ?? 0,
    page: answered.pageNum ?? input.page,
    list: (answered.list ?? []).map((row) => toSummary(row, input.keyType)),
  };
}

/** One 세금계산서's summary, by the document number the business gave it. */
export async function taxinvoiceInfo(input: {
  settings: PopbillSettings;
  corpNum: string;
  keyType: TaxinvoiceKeyType;
  mgtKey: string;
}): Promise<TaxinvoiceSummary | null> {
  const answered = await callPopbill<RawSummary>({
    settings: input.settings,
    corpNum: input.corpNum,
    method: "GET",
    path: `/Taxinvoice/${input.keyType}/${encodeURIComponent(input.mgtKey)}`,
  }).catch((error: unknown) => {
    // A document number nothing was ever written under is an answer, not a failure.
    if (error instanceof PopbillError && error.code !== null) return null;
    throw error;
  });
  return answered?.itemKey ? toSummary(answered, input.keyType) : null;
}

/**
 * Write a 세금계산서 down without issuing it. 임시저장, and nothing has left the building.
 *
 * `POST /Taxinvoice` with NO `X-HTTP-Method-Override` is Register. The same URL with `ISSUE` is
 * 즉시발행 — write and issue in one call — which this connector deliberately does not offer: a Bot
 * composing an invoice and issuing it in the same breath is one call for two decisions, and only
 * one of them is a person's.
 */
export async function registerTaxinvoice(input: {
  settings: PopbillSettings;
  corpNum: string;
  invoice: Record<string, unknown>;
}): Promise<void> {
  await callPopbill<{ code?: number }>({
    settings: input.settings,
    corpNum: input.corpNum,
    method: "POST",
    path: "/Taxinvoice",
    body: input.invoice,
  });
}

/**
 * Issue a 세금계산서 that was written down earlier. This is the one that costs money and cannot be
 * taken back without a 수정세금계산서.
 *
 * `SELL` or `TRUSTEE` only — 팝빌 refuses `BUY` here, because the buyer's copy is not theirs to
 * issue.
 */
export async function issueTaxinvoice(input: {
  settings: PopbillSettings;
  corpNum: string;
  keyType: "SELL" | "TRUSTEE";
  mgtKey: string;
  memo?: string;
}): Promise<{ ntsConfirmNum: string; issuedAt: string | null }> {
  const answered = await callPopbill<{
    ntsConfirmNum?: string;
    issueDT?: string | null;
  }>({
    settings: input.settings,
    corpNum: input.corpNum,
    method: "POST",
    path: `/Taxinvoice/${input.keyType}/${encodeURIComponent(input.mgtKey)}`,
    override: "ISSUE",
    body: input.memo ? { memo: input.memo } : {},
  });
  return {
    ntsConfirmNum: answered.ntsConfirmNum ?? "",
    // The reference's own example returns null here, so it is typed as absent rather than as "".
    issuedAt: answered.issueDT ?? null,
  };
}
