import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { HUB_FACTS } from "../../../shared/hub/protocol";
import type { AppVariables } from "../auth/guards";
import type { HubAnswer, HubHttp, HubRequest } from "./http";
import type { HubLink } from "./link";

/**
 * 회사 → 문서's doors (`app/src/routes/_authed/_app/company_.docs.$docId.tsx`), behind the person's
 * session, beside the other 회사 doors (`routes-ui.ts`) and in a file of their own so the document
 * work and the rest of 회사 change apart. The server asks the hub with this VM's pass and hands the
 * answer back; the browser never learns the hub's address or the pass (design §5, "브라우저와 허브").
 *
 *   GET  /api/hub/docs                              the team's documents
 *   POST /api/hub/docs                              a new one, `{title}`
 *   GET  /api/hub/docs/:id                          one document: its blocks in order, who holds which
 *   POST /api/hub/docs/:id/blocks                   a batch of block changes, all or none
 *   POST /api/hub/docs/:id/blocks/:block/lock       "쓰는 중": take or renew the hold on one block
 *   POST /api/hub/docs/:id/blocks/:block/unlock     let go of it
 *
 * A PERSON CHANGES BLOCKS, NEVER THE DOCUMENT. The batch takes the four block ops — replace,
 * insert_after, delete, move — and nothing else: there is no op that rewrites a document whole,
 * here or at the hub. A person's op carries the block's `version` (the hub's 409 when somebody saved
 * first); `expectHash` is 라피's and is not forwarded from a screen. Only the fields an op uses are
 * passed on, spelled again, and the kinds are the design's fixed list.
 *
 * WHAT THE SERVER ADDS, AS FOR THE REST OF 회사. `x-laf-origin: person` on every call; an
 * `Idempotency-Key` on every write (the browser's own, or one made for the press); reads asked once.
 * The hold's two doors are asked once too: a renewal is sent every five seconds, so a retried one is
 * only ever late, and a hold not let go of ends on the hub's clock anyway.
 *
 * A HUB FAILURE KEEPS ITS MEANING HERE: a refusal the hub named (400, 403, 404, 409, 413) keeps its
 * status and code — 409 is `laf:doc_block_busy` (somebody holds the block) or the stale version the
 * screen reopens on; a 401 or a 5xx is 502 with the fact, since either would mean something else to
 * the app.
 */

type Hub = { http: HubHttp; link: HubLink };
type Ctx = Context<{ Variables: AppVariables }>;

/** The block kinds of design §5. A screen sends nothing else; the hub checks again. */
export const DOC_BLOCK_KINDS = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "list",
  "check",
  "quote",
  "code",
  "divider",
  "table",
  "file",
  "task-link",
] as const;

/** The most ops one batch carries: an Enter is two, a merge two; a paste of a page is the outlier. */
export const DOC_OPS_MAX = 200;
/** One block's text. A block is a paragraph, not a file; the hub holds the same bound. */
export const DOC_BLOCK_TEXT_MAX = 20_000;
const TITLE_MAX = 200;
const ATTRS_MAX_BYTES = 20_000;

const ID_SHAPE = /^[A-Za-z0-9_-]{1,100}$/;
const KEY_SHAPE = /^[A-Za-z0-9_.:-]{8,128}$/;
const WHOLE = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const invalid = (context: Ctx, field: string) =>
  context.json({ ok: false, code: "laf:request_invalid", field }, 400);

function statusFor(status: number | null): 400 | 403 | 404 | 409 | 413 | 502 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 413:
      return status;
    default:
      return 502;
  }
}

async function jsonOf(context: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await context.req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const isKind = (value: unknown): value is (typeof DOC_BLOCK_KINDS)[number] =>
  typeof value === "string" &&
  (DOC_BLOCK_KINDS as readonly string[]).includes(value);

const isId = (value: unknown): value is string =>
  typeof value === "string" && ID_SHAPE.test(value);

/** Attrs as plain JSON of a bounded size, or undefined when absent. False when unusable. */
function attrsOf(value: unknown): Record<string, unknown> | undefined | false {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const spelled = JSON.stringify(value);
  if (spelled.length > ATTRS_MAX_BYTES) return false;
  return JSON.parse(spelled) as Record<string, unknown>;
}

const textOf = (value: unknown): string | undefined | false => {
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= DOC_BLOCK_TEXT_MAX
    ? value
    : false;
};

/**
 * One op from a person's screen, spelled again with only the fields its kind uses — or null when it
 * is not one of the four, or a field is not what that op takes.
 */
export function personOp(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const op = value as Record<string, unknown>;
  const text = textOf(op.text);
  const attrs = attrsOf(op.attrs);
  if (text === false || attrs === false) return null;
  switch (op.op) {
    case "replace": {
      if (!isId(op.id) || !WHOLE(op.version)) return null;
      if (op.kind !== undefined && !isKind(op.kind)) return null;
      if (text === undefined && attrs === undefined && op.kind === undefined) {
        return null;
      }
      return {
        op: "replace",
        id: op.id,
        version: op.version,
        ...(text !== undefined ? { text } : {}),
        ...(op.kind !== undefined ? { kind: op.kind } : {}),
        ...(attrs !== undefined ? { attrs } : {}),
      };
    }
    case "insert_after": {
      if (op.id !== null && !isId(op.id)) return null;
      if (!isKind(op.kind)) return null;
      return {
        op: "insert_after",
        id: op.id,
        kind: op.kind,
        text: text ?? "",
        ...(attrs !== undefined ? { attrs } : {}),
      };
    }
    case "delete":
      return isId(op.id) && WHOLE(op.version)
        ? { op: "delete", id: op.id, version: op.version }
        : null;
    case "move":
      if (!isId(op.id) || !WHOLE(op.version)) return null;
      if (op.after !== null && !isId(op.after)) return null;
      return { op: "move", id: op.id, version: op.version, after: op.after };
    default:
      return null;
  }
}

export function createHubUiDocRoutes(
  hub: Hub | undefined,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  const opened = (context: Ctx): Hub | Response => {
    context.header("cache-control", "no-store");
    if (!hub) {
      return context.json({ ok: false, code: "laf:hub_not_configured" }, 404);
    }
    if (hub.link.status().state === "refused") {
      return context.json({ ok: false, code: HUB_FACTS.passRefused }, 502);
    }
    return hub;
  };

  const settle = <T>(context: Ctx, live: Hub, answer: HubAnswer<T>) => {
    if (answer.ok) return context.json(answer.body as Record<string, unknown>);
    if (answer.code === HUB_FACTS.passRefused) live.link.passRefused("api_ui");
    return context.json(
      { ok: false, code: answer.code },
      statusFor(answer.status),
    );
  };

  const keyOf = (context: Ctx): string | null => {
    const sent = context.req.header("idempotency-key");
    if (sent === undefined) return randomUUID();
    return KEY_SHAPE.test(sent) ? sent : null;
  };

  const ask = async (
    context: Ctx,
    request: Omit<HubRequest, "origin" | "idempotencyKey">,
    write: boolean,
  ) => {
    const live = opened(context);
    if (live instanceof Response) return live;
    const key = write ? keyOf(context) : undefined;
    if (key === null) return invalid(context, "idempotencyKey");
    return settle(
      context,
      live,
      await live.http.request({
        ...request,
        origin: "person",
        ...(key ? { idempotencyKey: key } : {}),
      }),
    );
  };

  const docId = (context: Ctx): string | null => {
    const value = context.req.param("id");
    return value && ID_SHAPE.test(value) ? value : null;
  };

  routes.get("/docs", requireUser, async (context) => {
    const folder = context.req.query("folder");
    if (folder !== undefined && folder.length > 512) {
      return invalid(context, "folder");
    }
    const query = folder ? `?${new URLSearchParams({ folder })}` : "";
    return ask(context, { path: `/docs${query}`, retry: false }, false);
  });

  routes.post("/docs", requireUser, async (context) => {
    const body = await jsonOf(context);
    const title = typeof body?.title === "string" ? body.title.trim() : null;
    if (title === null || title.length > TITLE_MAX) {
      return invalid(context, "title");
    }
    return ask(
      context,
      { method: "POST", path: "/docs", body: { title } },
      true,
    );
  });

  routes.get("/docs/:id", requireUser, async (context) => {
    const id = docId(context);
    if (id === null) return invalid(context, "path");
    return ask(context, { path: `/docs/${id}`, retry: false }, false);
  });

  routes.post("/docs/:id/blocks", requireUser, async (context) => {
    const id = docId(context);
    if (id === null) return invalid(context, "path");
    const body = await jsonOf(context);
    const ops = Array.isArray(body?.ops) ? body.ops : null;
    if (!ops || ops.length === 0 || ops.length > DOC_OPS_MAX) {
      return invalid(context, "ops");
    }
    const spelled = ops.map(personOp);
    if (spelled.some((op) => op === null)) return invalid(context, "ops");
    return ask(
      context,
      { method: "POST", path: `/docs/${id}/blocks`, body: { ops: spelled } },
      true,
    );
  });

  for (const door of ["lock", "unlock"] as const) {
    routes.post(
      `/docs/:id/blocks/:block/${door}`,
      requireUser,
      async (context) => {
        const id = docId(context);
        const block = context.req.param("block");
        if (id === null || !isId(block)) return invalid(context, "path");
        return ask(
          context,
          {
            method: "POST",
            path: `/docs/${id}/blocks/${block}/${door}`,
            retry: false,
          },
          true,
        );
      },
    );
  }

  return routes;
}
