import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import { LoginSealError } from "./crypto";
import {
  type LoginInput,
  LoginRefused,
  type LoginVault,
  SAVED_LOGINS_MAX,
} from "./store";

/**
 * 로그인 보관함's doors (`docs/laf/redesign-2026-10.md` §6, piece 2-3), every one the person's own,
 * behind their session:
 *
 *   GET    /api/logins        what they saved: what each is called and where it may go
 *   POST   /api/logins        save one — {label, site?, origins, username, password}
 *   PATCH  /api/logins/:id    change what is sent; anything left out stays as it is, and `{}`
 *                             changes nothing
 *   DELETE /api/logins/:id    gone, now
 *
 * NO DOOR HERE GIVES A VALUE BACK. Not the list, not the row a save or a change answers with, and
 * there is no "show password": a value goes in through POST and PATCH and comes out only where the
 * server puts it into a page for the Bot (piece 2-4), which is not a route. A person who forgot
 * what they saved types it again.
 *
 * Facts only; the surface owns the words (the screen is piece 2-5). Nothing is cached anywhere
 * between here and the window.
 */
export function createLoginRoutes(
  vault: Pick<LoginVault, "list" | "save" | "replace" | "remove">,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const notFound = {
    error: "laf:login_not_found",
    code: "laf:login_not_found",
  };
  /*
   * A BODY THAT CANNOT BE READ IS NOT AN EMPTY ONE. Bytes that are not JSON, a list, a string:
   * read as "nothing was sent", a change answered 200 with the row as it stood — to a window that
   * had tried to replace a password, that says the new one is saved while the old one still is
   * (Codex's read of this change). An explicit `{}` is still a change of nothing.
   */
  const unreadable = { error: "laf:login_invalid", code: "laf:login_invalid" };

  /** A refusal as the form reads it: which fact, and which field where it is one. */
  const refused = (error: LoginRefused) => ({
    error: error.code,
    code: error.code,
    ...(error.field ? { field: error.field } : {}),
  });

  /** The body, as an object or as nothing: a list or a string is not a login. */
  const written = async (request: {
    json: () => Promise<unknown>;
  }): Promise<Partial<LoginInput> | null> => {
    const body = await request.json().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Partial<LoginInput>)
      : null;
  };

  routes.get("/", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    return context.json({
      logins: await vault.list(context.var.actor.id),
      max: SAVED_LOGINS_MAX,
    });
  });

  routes.post("/", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    const body = await written(context.req);
    if (!body) return context.json(unreadable, 400);
    try {
      return context.json(
        await vault.save(context.var.actor.id, {
          label: body.label,
          site: body.site,
          origins: body.origins,
          username: body.username,
          password: body.password,
        }),
        201,
      );
    } catch (error) {
      if (error instanceof LoginRefused) {
        // Full is not a mistake in what was written.
        return context.json(
          refused(error),
          error.code === "laf:logins_full" ? 409 : 400,
        );
      }
      throw error;
    }
  });

  routes.patch("/:id", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    const body = await written(context.req);
    if (!body) return context.json(unreadable, 400);
    try {
      const changed = await vault.replace(
        context.var.actor.id,
        context.req.param("id"),
        // Named one by one: nothing a body carries beyond these reaches the vault.
        {
          ...("label" in body ? { label: body.label } : {}),
          ...("site" in body ? { site: body.site } : {}),
          ...("origins" in body ? { origins: body.origins } : {}),
          ...("username" in body ? { username: body.username } : {}),
          ...("password" in body ? { password: body.password } : {}),
        },
      );
      return changed ? context.json(changed) : context.json(notFound, 404);
    } catch (error) {
      if (error instanceof LoginRefused) {
        return context.json(refused(error), 400);
      }
      /*
       * One value was sent, and the one the row holds does not open — the deployment's key is not
       * the one that sealed it. Not this request's mistake and not a crash: a fact the screen has
       * a sentence for ("이 로그인은 아이디와 비밀번호를 둘 다 다시 넣어 주세요"), because sending
       * both is what puts the row right.
       */
      if (error instanceof LoginSealError) {
        return context.json({ error: error.message, code: error.message }, 409);
      }
      throw error;
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    context.header("cache-control", "no-store");
    const gone = await vault.remove(
      context.var.actor.id,
      context.req.param("id"),
    );
    return gone ? context.body(null, 204) : context.json(notFound, 404);
  });

  return routes;
}
