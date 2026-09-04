/**
 * The one place that speaks 솔라피 (api.solapi.com), and the one place that holds LAF's key.
 *
 * WHY THERE IS EXACTLY ONE. Everything else in this connector — the connect flow, the Bot's tools,
 * the notification door — is about what a person or a Bot is allowed to do. This module is about
 * what bytes go on the wire. Keeping them apart is what lets every one of those be tested against a
 * recorded fixture instead of against somebody else's server, and it is what makes the day the key
 * arrives a matter of running the calls in `SOLAPI_UNVERIFIED` and correcting one file.
 *
 * WHAT IS KNOWN AND WHAT IS NOT. The shapes below are written from 솔라피's published REST
 * documentation. The authentication scheme, the send call and the message body are the parts this
 * fork is confident about. The 발신프로필 (Kakao channel) registration pair and the template
 * inspection fields are the parts that must be confirmed against the live API the first time LAF's
 * key exists — every one of them is named in {@link SOLAPI_UNVERIFIED}, which the connections doc
 * quotes, so the list is a checklist rather than a note somebody has to remember.
 *
 * NOTHING HERE READS A DATABASE OR DECIDES ANYTHING. It takes settings, makes a call and returns
 * what came back.
 */

/** How long any one vendor call may take. Ten seconds, the same bound the webhook door uses. */
const CALL_TIMEOUT_MS = 10_000;

/** Where 솔라피 answers, unless a deployment (or a test's fake) says otherwise. */
export const SOLAPI_DEFAULT_BASE_URL = "https://api.solapi.com";

/**
 * The exact facts that must be confirmed against the live API once LAF's key exists.
 *
 * Exported as data rather than left in prose, because a comment is not a checklist and this is one.
 * `docs/laf/connections.md` prints it; a test asserts it is not empty, so deleting an entry is a
 * deliberate act by somebody who has actually run the call.
 */
export const SOLAPI_UNVERIFIED: readonly {
  call: string;
  what: string;
}[] = Object.freeze([
  {
    call: "requestChannelToken",
    what: "The path and body of the 인증번호 request (POST /kakao/v1/channels/token with searchId and phoneNumber), and whether the code arrives by 알림톡 or by SMS.",
  },
  {
    call: "registerChannel",
    what: "Whether the 발신프로필 key comes back as `channelId` or under another name, and whether a 카테고리 코드 is required at registration rather than at template time.",
  },
  {
    call: "registerTemplate",
    what: "The template body's field names (`content`, `buttons`, `categoryCode`, `messageType`) and which of them the agency API demands.",
  },
  {
    call: "readTemplate",
    what: "Which field carries the inspection result — `status`, `inspectionStatus`, or both — and the exact words each uses.",
  },
  {
    call: "sendTemplateMessage",
    what: "Whether a registered 발신번호 (`from`) is required when `disableSms` is true, and the success shape (`statusCode` 2000 versus a per-message result list).",
  },
]);

/** LAF's fleet-wide 솔라피 account, as the environment carries it. */
export type SolapiSettings = {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  /**
   * The fleet's registered 발신번호, for the SMS fallback. Optional and usually absent: an 알림톡
   * that cannot fall back is still an 알림톡, and a number nobody registered would fail the send.
   */
  from?: string | undefined;
};

/**
 * The account out of the environment, or null when this deployment has none.
 *
 * `LAF_ALIMTALK_API_KEY` is `key:secret`, one variable rather than two, because they are issued
 * together and a deployment holding one half is a deployment that cannot call anything — a state
 * worth being unable to express.
 */
export function solapiSettings(
  environment: Record<string, string | undefined> = process.env,
): SolapiSettings | null {
  const pair = environment.LAF_ALIMTALK_API_KEY?.trim();
  if (!pair) return null;
  const separator = pair.indexOf(":");
  if (separator <= 0 || separator === pair.length - 1) return null;
  return {
    apiKey: pair.slice(0, separator),
    apiSecret: pair.slice(separator + 1),
    baseUrl:
      environment.LAF_ALIMTALK_BASE_URL?.trim() || SOLAPI_DEFAULT_BASE_URL,
    from: environment.LAF_ALIMTALK_FROM?.trim() || undefined,
  };
}

/**
 * A call 솔라피 refused, with the vendor's own code kept as a value.
 *
 * The code rather than the sentence, for the reason this repository has written down twice already:
 * a caller that branches on prose breaks when the prose is reworded or translated. `ValidationError`
 * on the 인증번호 step is a person mistyping and is worth saying differently from an outage.
 */
export class SolapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "SolapiError";
  }
}

/**
 * 솔라피's HMAC authorisation header.
 *
 * `HMAC-SHA256 apiKey=…, date=…, salt=…, signature=…`, where the signature is the hex HMAC-SHA256 of
 * `date + salt` under the API secret. The date is ISO-8601 and the salt is a per-request nonce, so
 * two identical calls carry two different signatures — which is what makes a captured header useless
 * a moment later.
 */
export async function solapiAuthorization(
  settings: SolapiSettings,
  now: () => Date = () => new Date(),
  randomSalt: () => string = () => crypto.randomUUID().replaceAll("-", ""),
): Promise<string> {
  const date = now().toISOString();
  const salt = randomSalt();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(settings.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${date}${salt}`),
  );
  const signature = Array.from(new Uint8Array(signed))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `HMAC-SHA256 apiKey=${settings.apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

type SolapiCall = {
  settings: SolapiSettings;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  /** Injected by tests that assert the header without a clock. */
  authorization?: string;
};

/**
 * One request, one answer, and every failure turned into {@link SolapiError}.
 *
 * A non-2xx is the vendor refusing and carries its `errorCode`. A body that is not JSON is the
 * vendor being broken or something else answering at that address, and is refused rather than
 * guessed at — an HTML error page parsed leniently is how a connector reports success at a proxy.
 */
async function callSolapi<T>(call: SolapiCall): Promise<T> {
  const url = `${call.settings.baseUrl.replace(/\/$/, "")}${call.path}`;
  const authorization =
    call.authorization ?? (await solapiAuthorization(call.settings));

  let response: Response;
  try {
    response = await fetch(url, {
      method: call.method,
      headers: {
        authorization,
        "content-type": "application/json",
      },
      ...(call.body ? { body: JSON.stringify(call.body) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SolapiError(
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

  if (!response.ok) {
    const body = (parsed ?? {}) as {
      errorCode?: string;
      errorMessage?: string;
    };
    throw new SolapiError(
      body.errorMessage ?? `solapi answered ${response.status}`,
      response.status,
      body.errorCode ?? null,
    );
  }
  if (parsed === null) {
    throw new SolapiError(
      "solapi answered with something that is not JSON",
      response.status,
      null,
    );
  }
  return parsed as T;
}

/**
 * Ask 솔라피 to send the channel's manager a 인증번호.
 *
 * MUST BE VERIFIED LIVE. See {@link SOLAPI_UNVERIFIED}: the path and the two field names are written
 * from the documentation and have never been run against the real endpoint.
 */
export async function requestChannelToken(input: {
  settings: SolapiSettings;
  /** The channel's 검색용 아이디, `@` included, as the person typed it. */
  searchId: string;
  /** The 채널 관리자's mobile number, digits only. */
  phoneNumber: string;
  authorization?: string;
}): Promise<void> {
  await callSolapi({
    settings: input.settings,
    method: "POST",
    path: "/kakao/v1/channels/token",
    body: { searchId: input.searchId, phoneNumber: input.phoneNumber },
    ...(input.authorization ? { authorization: input.authorization } : {}),
  });
}

/** What a registered 발신프로필 is, as far as anything outside this module needs to know. */
export type SolapiChannel = {
  /** The 발신프로필 key every send carries. 솔라피 calls it the channel id. */
  senderKey: string;
  searchId: string;
};

/**
 * Complete the registration with the code the person read on their phone.
 *
 * MUST BE VERIFIED LIVE. Which field carries the 발신프로필 key is the single most important thing
 * on this list: read from the wrong one, every send would be addressed to nothing.
 */
export async function registerChannel(input: {
  settings: SolapiSettings;
  searchId: string;
  phoneNumber: string;
  /** The 인증번호 the person typed back. */
  token: string;
  /** 업종 카테고리, where the vendor asks for one at registration. */
  categoryCode?: string | undefined;
  authorization?: string;
}): Promise<SolapiChannel> {
  const answered = await callSolapi<{
    channelId?: string;
    pfId?: string;
    senderKey?: string;
    searchId?: string;
  }>({
    settings: input.settings,
    method: "POST",
    path: "/kakao/v1/channels",
    body: {
      searchId: input.searchId,
      phoneNumber: input.phoneNumber,
      token: input.token,
      ...(input.categoryCode ? { categoryCode: input.categoryCode } : {}),
    },
    ...(input.authorization ? { authorization: input.authorization } : {}),
  });

  /*
   * Three spellings accepted, in order, and a refusal when none of them is there.
   *
   * Not leniency for its own sake: the same key is `channelId` in 솔라피's channel API, `pfId` in
   * its message options and `senderKey` in 카카오's own documentation, and which one this endpoint
   * answers with is exactly what has never been run. A missing key is refused rather than defaulted,
   * because an empty senderKey stored here is a connection that looks finished and can send nothing.
   */
  const senderKey = answered.channelId ?? answered.pfId ?? answered.senderKey;
  if (!senderKey) {
    throw new SolapiError(
      "solapi registered the channel without returning a sender key",
      200,
      "laf:no_sender_key",
    );
  }
  return { senderKey, searchId: answered.searchId ?? input.searchId };
}

/** Where a template's inspection got to, in the three words this product draws. */
export type TemplateInspection = "pending" | "approved" | "rejected";

export type SolapiTemplate = {
  templateId: string;
  status: TemplateInspection;
  /** What the inspector said, when it said anything. */
  reason: string;
};

/**
 * The vendor's inspection words, mapped to the three this product has.
 *
 * Both fields are read because both exist: `status` carries the template's lifecycle
 * (PENDING/INSPECTING/APPROVED/REJECTED) and `inspectionStatus` carries 카카오's own three-letter
 * codes (REG/REQ/APR/REJ). Anything unrecognised is `pending`, which is the honest reading of a word
 * this build has never seen: an unknown status must never be drawn as 사용 가능.
 */
export function inspectionOf(input: {
  status?: string | null;
  inspectionStatus?: string | null;
}): TemplateInspection {
  const words = [input.status, input.inspectionStatus]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toUpperCase());
  if (words.some((word) => word === "REJECTED" || word === "REJ")) {
    return "rejected";
  }
  if (words.some((word) => word === "APPROVED" || word === "APR")) {
    return "approved";
  }
  return "pending";
}

/**
 * Register one of LAF's standard templates under a person's 발신프로필.
 *
 * MUST BE VERIFIED LIVE — the field names below come from the documentation. A template that is
 * registered and rejected is a normal outcome and not an error: it comes back as `rejected` with the
 * inspector's words, which is what the card shows.
 */
export async function registerTemplate(input: {
  settings: SolapiSettings;
  senderKey: string;
  name: string;
  content: string;
  /** Buttons the template declares. Empty for every one LAF ships today. */
  buttons?: readonly Record<string, unknown>[];
  categoryCode?: string | undefined;
  authorization?: string;
}): Promise<SolapiTemplate> {
  const answered = await callSolapi<{
    templateId?: string;
    status?: string;
    inspectionStatus?: string;
    comments?: { content?: string }[];
  }>({
    settings: input.settings,
    method: "POST",
    path: "/kakao/v1/templates",
    body: {
      channelId: input.senderKey,
      name: input.name,
      content: input.content,
      buttons: input.buttons ?? [],
      ...(input.categoryCode ? { categoryCode: input.categoryCode } : {}),
    },
    ...(input.authorization ? { authorization: input.authorization } : {}),
  });

  if (!answered.templateId) {
    throw new SolapiError(
      "solapi accepted the template without returning an id",
      200,
      "laf:no_template_id",
    );
  }
  return {
    templateId: answered.templateId,
    status: inspectionOf(answered),
    reason: answered.comments?.[0]?.content ?? "",
  };
}

/**
 * What 솔라피 says about one template now.
 *
 * MUST BE VERIFIED LIVE. This is how 심사 중 becomes 사용 가능 without anybody watching a mailbox,
 * so the field it reads is the difference between a card that updates and one that never does.
 */
export async function readTemplate(input: {
  settings: SolapiSettings;
  templateId: string;
  authorization?: string;
}): Promise<SolapiTemplate> {
  const answered = await callSolapi<{
    templateId?: string;
    status?: string;
    inspectionStatus?: string;
    comments?: { content?: string }[];
  }>({
    settings: input.settings,
    method: "GET",
    path: `/kakao/v1/templates/${encodeURIComponent(input.templateId)}`,
    ...(input.authorization ? { authorization: input.authorization } : {}),
  });
  return {
    templateId: answered.templateId ?? input.templateId,
    status: inspectionOf(answered),
    reason: answered.comments?.[0]?.content ?? "",
  };
}

/**
 * Send one 알림톡 through the agency, as one person's channel.
 *
 * `disableSms` is true on purpose. The fallback would leave as an ordinary text message from
 * whatever number the fleet has registered, which is a different thing arriving on somebody's phone
 * from a different sender — and it costs money per message. A deployment that wants the fallback
 * sets `LAF_ALIMTALK_FROM`; without a registered number there is nothing to fall back to anyway.
 *
 * MUST BE VERIFIED LIVE: whether `from` is required even with the fallback disabled, and which field
 * of the answer says the message was accepted.
 */
export async function sendTemplateMessage(input: {
  settings: SolapiSettings;
  /** The 발신프로필 key of the channel this leaves from. */
  senderKey: string;
  templateId: string;
  /** The recipient's number, digits only. */
  to: string;
  /** `#{name}` to value, exactly as the approved template spells them. */
  variables: Record<string, string>;
  authorization?: string;
}): Promise<{ accepted: boolean; messageId: string | null }> {
  const answered = await callSolapi<{
    statusCode?: string;
    messageId?: string;
    groupInfo?: { count?: { total?: number; registeredFailed?: number } };
    failedMessageList?: unknown[];
  }>({
    settings: input.settings,
    method: "POST",
    path: "/messages/v4/send",
    body: {
      message: {
        to: input.to,
        ...(input.settings.from ? { from: input.settings.from } : {}),
        kakaoOptions: {
          pfId: input.senderKey,
          templateId: input.templateId,
          variables: input.variables,
          disableSms: true,
        },
      },
    },
    ...(input.authorization ? { authorization: input.authorization } : {}),
  });

  /*
   * Accepted means accepted, and a per-message failure is not.
   *
   * 솔라피 answers 200 with a list of the messages it could not register, so a door that read only
   * the HTTP status would write "delivered" for a message the vendor had just refused — which is the
   * one thing the outbox's `delivered_via` column must never say.
   */
  const failed = Array.isArray(answered.failedMessageList)
    ? answered.failedMessageList.length
    : (answered.groupInfo?.count?.registeredFailed ?? 0);
  const accepted =
    failed === 0 && (!answered.statusCode || answered.statusCode === "2000");
  return { accepted, messageId: answered.messageId ?? null };
}
