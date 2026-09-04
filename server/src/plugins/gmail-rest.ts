import type { McpCallResult, McpTool } from "./mcp";
import {
  asResult,
  countArg,
  failure,
  readJson,
  type RestConnection,
  stringArg,
  vendorRequest,
} from "./rest-support";

/**
 * Gmail over its ordinary REST API: search, read, draft, send.
 *
 * THE SEND IS THE POINT AND THE DANGER. Everything else here is a read a person can undo by
 * ignoring it; a sent mail is gone, under their name, to somebody who is not in the room. That is
 * why `send_message` is guarded in the catalogue entry rather than merely marked a write: a person
 * answers for every single one, whatever the written boundary says.
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

/** How much of one mail's body a model is given. Enough to answer from, short of a whole thread. */
const MAX_BODY_CHARS = 4_000;

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

/** One plain-text mail as the raw bytes Gmail's `raw` field takes. */
export function mimeMessage(input: {
  to: string;
  subject: string;
  body: string;
}): string {
  const headers = [
    `To: ${input.to}`,
    `Subject: ${encodedHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${Buffer.from(input.body, "utf8").toString("base64")}`;
}

export async function callTool(
  connection: RestConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const base = connection.url.replace(/\/+$/, "");

  if (toolName === "search_messages") {
    const listed = await vendorRequest("Gmail", connection, {
      url: `${base}/messages`,
      query: {
        q: stringArg(args, "query") ?? undefined,
        maxResults: String(
          countArg(args, "max", DEFAULT_MESSAGES, MAX_MESSAGES),
        ),
      },
    });
    if (!listed.ok) return failure(listed.message);

    const body = await readJson<{ messages?: { id?: string }[] }>(
      listed.response,
    );
    if (!body) return failure("지메일이 읽을 수 없는 답을 보냈습니다.");
    const ids = (body.messages ?? [])
      .map((message) => message.id)
      .filter(Boolean);
    if (ids.length === 0) return asResult("");

    /*
     * One request per message, for the headers only.
     *
     * Gmail's list endpoint returns ids and nothing else — no subject, no sender — so a list without
     * this is a page of identifiers a model cannot say anything about. `metadata` format keeps each
     * of these small, and the count is bounded by `max` above.
     */
    const lines: string[] = [];
    for (const id of ids) {
      const detail = await vendorRequest("Gmail", connection, {
        url: `${base}/messages/${encodeURIComponent(id as string)}`,
        // `metadata`, not `full`: the headers are the whole of a list line, and the bodies of ten
        // mails are ten times the tokens for something nobody asked to read yet.
        query: { format: "metadata" },
      });
      if (!detail.ok) continue;
      const message = await readJson<GmailMessage>(detail.response);
      if (!message) continue;
      lines.push(
        `- ${headerOf(message, "Subject") || "(제목 없음)"} · ${headerOf(message, "From")} · ${headerOf(message, "Date")} · id: ${message.id ?? id}`,
      );
    }
    return asResult(lines.join("\n"));
  }

  if (toolName === "read_message") {
    const messageId = stringArg(args, "messageId");
    if (!messageId) return failure("어느 메일인지 id가 필요합니다.");

    const result = await vendorRequest("Gmail", connection, {
      url: `${base}/messages/${encodeURIComponent(messageId)}`,
      query: { format: "full" },
    });
    if (!result.ok) return failure(result.message);

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
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ id?: string }>(result.response);
    return asResult(
      draft
        ? `초안을 만들었습니다. 지메일 임시보관함에서 확인하세요. (id: ${body?.id ?? "?"})`
        : `${to} 에게 보냈습니다. (id: ${body?.id ?? "?"})`,
    );
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}
