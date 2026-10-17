import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HUB_FACTS } from "../../../shared/hub/protocol";
import { HUB_UPLOAD_MAX_BYTES } from "../../../shared/hub/upload";
import { SKILL_SLUG_PATTERN } from "../../../shared/tools/skills";
import type { AppVariables } from "../auth/guards";
import type { HubAnswer, HubHttp, HubRequest } from "./http";
import type { HubLink } from "./link";

/**
 * The 회사 screen's doors (`app/src/routes/_authed/_app/company.tsx`), behind the person's session
 * like every other route: the server asks the company hub with this VM's pass and hands the answer
 * back. The browser never learns the hub's address or the pass (hub design §4.6, appendix A.2).
 *
 *   GET  /api/hub/members                     who is in the company
 *   GET  /api/hub/rooms                       the rooms this person is in
 *   POST /api/hub/rooms                       a new room
 *   GET  /api/hub/rooms/:id/messages          a room's newest messages (or `since=` / `before=`)
 *   POST /api/hub/rooms/:id/messages          this person's message
 *   GET  /api/hub/files                       the team's files
 *   GET  /api/hub/files/:id/content           one file's bytes, to open or save
 *   PUT  /api/hub/files                       a file from this person's computer
 *   GET  /api/hub/skills · /skills/:slug      the team's skills, and one's instructions
 *   GET  /api/hub/memory · /memory/proposals  confirmed team memory, and the lines waiting
 *   POST /api/hub/memory/:id/confirm|retire   an admin's 확인 / 숨기기
 *
 * WHAT THE SERVER ADDS, AND WHY THE HUB STILL DECIDES. Every call carries `x-laf-origin: person` —
 * these are presses, never a run — and every write an `Idempotency-Key`, the browser's own when it
 * sent one, so a press retried after a dropped answer is one message, not two. Whether this member
 * may read a room, confirm a line or see a file is the hub's to say (`visible_to`, its roles); this
 * door checks only the shape of what it forwards: ids that cannot climb out of their path, numbers
 * that are numbers, a body with only the fields the screen sends.
 *
 * A HUB FAILURE IS NEVER THE HUB'S OWN STATUS when that status would mean something else here: a
 * 401 is this person's session ending to the app, and a 5xx is this server failing. Both come back
 * as 502 with the fact. A refusal the hub named — 400, 403, 404, 409, 413, 507 — keeps its status
 * and its code, which the screen has words for.
 *
 * READS ARE ASKED ONCE. The hub client retries a 5xx three times over ten seconds, which is right
 * for a Bot's call and wrong for a screen a person is looking at: the screen's own query retries,
 * and "cannot reach" after one try is the sooner true answer. Writes keep the retries — their key
 * makes a second try harmless.
 */

type Hub = { http: HubHttp; link: HubLink };
type Ctx = Context<{ Variables: AppVariables }>;

const NOT_CONFIGURED = { ok: false, code: "laf:hub_not_configured" } as const;

/** A hub id as the hub makes them (`r_<uuid>`, `m_<uuid>`), or a file's. No `/`, no `.`. */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,100}$/;
/** The hub's own key shape (`hub/src/idempotency.ts`). */
const KEY_SHAPE = /^[A-Za-z0-9_.:-]{8,128}$/;
const WHOLE = /^\d{1,15}$/;

const invalid = (context: Ctx, field: string) =>
  context.json({ ok: false, code: "laf:request_invalid", field }, 400);

/** The hub's status where it means the same here, 502 where it would mean something else. */
function statusFor(
  status: number | null,
): 400 | 403 | 404 | 409 | 413 | 502 | 507 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 413:
    case 507:
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

export function createHubUiRoutes(
  hub: Hub | undefined,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * The hub to ask, or the answer already: not configured, or a pass already refused — said here,
   * without asking the hub.
   */
  const opened = (context: Ctx): Hub | Response => {
    context.header("cache-control", "no-store");
    if (!hub) return context.json(NOT_CONFIGURED, 404);
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

  const read =
    (path: (context: Ctx) => string | null) => async (context: Ctx) => {
      const hub = opened(context);
      if (hub instanceof Response) return hub;
      const target = path(context);
      if (target === null) return invalid(context, "path");
      return settle(
        context,
        hub,
        await hub.http.request({
          path: target,
          origin: "person",
          retry: false,
        }),
      );
    };

  /** The browser's key when it sent a usable one; otherwise one made here, for this press only. */
  const keyOf = (context: Ctx): string | null => {
    const sent = context.req.header("idempotency-key");
    if (sent === undefined) return randomUUID();
    return KEY_SHAPE.test(sent) ? sent : null;
  };

  const write = async (
    context: Ctx,
    request: Omit<HubRequest, "origin" | "idempotencyKey">,
  ) => {
    const hub = opened(context);
    if (hub instanceof Response) return hub;
    const key = keyOf(context);
    if (key === null) return invalid(context, "idempotencyKey");
    return settle(
      context,
      hub,
      await hub.http.request({
        ...request,
        origin: "person",
        idempotencyKey: key,
      }),
    );
  };

  const idParam = (context: Ctx, name: string): string | null => {
    const value = context.req.param(name);
    return value && ID_SHAPE.test(value) ? value : null;
  };

  /** The listed query fields that are present, each checked and spelled again here. */
  const queryOf = (
    context: Ctx,
    fields: Record<string, (value: string) => boolean>,
  ): string | null => {
    const kept = new URLSearchParams();
    for (const [name, valid] of Object.entries(fields)) {
      const value = context.req.query(name);
      if (value === undefined) continue;
      if (!valid(value)) return null;
      kept.set(name, value);
    }
    const spelled = kept.toString();
    return spelled ? `?${spelled}` : "";
  };

  /*
   * The guard on each route rather than `use("*")`: these routes share `/api/hub` with
   * `routes.ts`'s two, and a wildcard here would stand in front of those a second time.
   */
  routes.get(
    "/members",
    requireUser,
    read(() => "/members"),
  );

  routes.get(
    "/rooms",
    requireUser,
    read(() => "/rooms"),
  );

  routes.post("/rooms", requireUser, async (context) => {
    const body = await jsonOf(context);
    if (!body || typeof body.name !== "string") return invalid(context, "name");
    const members = Array.isArray(body.members) ? body.members : [];
    if (!members.every((id) => typeof id === "string" && ID_SHAPE.test(id))) {
      return invalid(context, "members");
    }
    return write(context, {
      method: "POST",
      path: "/rooms",
      body: { name: body.name, members },
    });
  });

  routes.get(
    "/rooms/:id/messages",
    requireUser,
    read((context) => {
      const id = idParam(context, "id");
      const query = queryOf(context, {
        since: (value) => WHOLE.test(value),
        before: (value) => WHOLE.test(value),
        limit: (value) => WHOLE.test(value),
      });
      return id === null || query === null
        ? null
        : `/rooms/${id}/messages${query}`;
    }),
  );

  routes.post("/rooms/:id/messages", requireUser, async (context) => {
    const id = idParam(context, "id");
    if (id === null) return invalid(context, "path");
    const body = await jsonOf(context);
    if (!body || typeof body.text !== "string") return invalid(context, "text");
    const mentions = Array.isArray(body.mentions) ? body.mentions : [];
    if (!mentions.every((one) => typeof one === "string")) {
      return invalid(context, "mentions");
    }
    // A person posts as themself. `as: "bot"` is their 라피's, and only its run sends that.
    return write(context, {
      method: "POST",
      path: `/rooms/${id}/messages`,
      body: { text: body.text, mentions, as: "member" },
    });
  });

  routes.get(
    "/files",
    requireUser,
    read((context) => {
      const query = queryOf(context, {
        folder: (value) => value.length <= 512,
        cursor: (value) => value.length <= 512,
      });
      return query === null ? null : `/files${query}`;
    }),
  );

  /*
   * THE FILE ITSELF, streamed from the hub to the person without being held here. Saved, never
   * drawn by this origin: a team file is somebody's spreadsheet or somebody's page of HTML, and a
   * page this origin rendered could read this person's session.
   */
  routes.get("/files/:id/content", requireUser, async (context) => {
    const hub = opened(context);
    if (hub instanceof Response) return hub;
    const id = idParam(context, "id");
    if (id === null) return invalid(context, "path");
    if (!hub.http.raw) {
      return context.json({ ok: false, code: HUB_FACTS.unreachable }, 502);
    }
    const answer = await hub.http.raw({
      method: "GET",
      path: `/files/${id}/content`,
      origin: "person",
      signal: context.req.raw.signal,
    });
    if (!answer.ok) {
      if (answer.code === HUB_FACTS.passRefused) {
        hub.link.passRefused("api_ui");
      }
      return context.json(
        { ok: false, code: answer.code },
        statusFor(answer.status),
      );
    }
    const upstream = answer.response;
    const headers = new Headers({
      "content-type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition":
        upstream.headers.get("content-disposition") ?? "attachment",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(upstream.body, { status: 200, headers });
  });

  /*
   * A FILE FROM THE PERSON'S COMPUTER, passed through as the multipart body the browser built
   * (`meta`, `blob`) — the hub reads it as it arrives (`hub/src/files/multipart.ts`), so neither end
   * holds a gigabyte in memory. Only a body that declares its length is taken: the hub refuses a
   * file past its limit from that number before reading a byte, and so does this door.
   */
  routes.put(
    "/files",
    requireUser,
    bodyLimit({
      maxSize: HUB_UPLOAD_MAX_BYTES,
      onError: (context) =>
        context.json({ ok: false, code: "laf:hub_file_too_large" }, 413),
    }),
    async (context) => {
      const hub = opened(context);
      if (hub instanceof Response) return hub;
      const type = context.req.header("content-type") ?? "";
      const length = context.req.header("content-length");
      if (!type.toLowerCase().startsWith("multipart/form-data") || !length) {
        return invalid(context, "body");
      }
      const key = keyOf(context);
      if (key === null) return invalid(context, "idempotencyKey");
      if (!hub.http.raw) {
        return context.json({ ok: false, code: HUB_FACTS.unreachable }, 502);
      }
      const answer = await hub.http.raw({
        method: "PUT",
        path: "/files",
        headers: { "content-type": type, "content-length": length },
        body: context.req.raw.body,
        idempotencyKey: key,
        origin: "person",
        signal: context.req.raw.signal,
      });
      if (!answer.ok) {
        if (answer.code === HUB_FACTS.passRefused) {
          hub.link.passRefused("api_ui");
        }
        return context.json(
          { ok: false, code: answer.code },
          statusFor(answer.status),
        );
      }
      const body: unknown = await answer.response.json().catch(() => null);
      return context.json(
        (body ?? { ok: false, code: HUB_FACTS.unreachable }) as Record<
          string,
          unknown
        >,
        body ? 200 : 502,
      );
    },
  );

  routes.get(
    "/skills",
    requireUser,
    read(() => "/skills"),
  );

  routes.get(
    "/skills/:slug",
    requireUser,
    read((context) => {
      const slug = context.req.param("slug");
      return slug && SKILL_SLUG_PATTERN.test(slug)
        ? `/skills/${encodeURIComponent(slug)}`
        : null;
    }),
  );

  routes.get(
    "/memory",
    requireUser,
    read(() => "/memory"),
  );

  routes.get(
    "/memory/proposals",
    requireUser,
    read(() => "/memory/proposals"),
  );

  for (const decision of ["confirm", "retire"] as const) {
    routes.post(`/memory/:id/${decision}`, requireUser, async (context) => {
      const id = idParam(context, "id");
      if (id === null) return invalid(context, "path");
      return write(context, {
        method: "POST",
        path: `/memory/${id}/${decision}`,
      });
    });
  }

  return routes;
}
