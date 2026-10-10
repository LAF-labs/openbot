/**
 * 계정 — the logins a person saved for their Bot's browser, as this screen reads and writes them.
 *
 * THE SERVER HANDS BACK NO VALUE, AND THIS KEEPS NONE. A saved login is listed by what the person
 * called it and where it may go; the sign-in name and the password leave this window once, on the
 * request that saves them, and are never read back (`server/src/logins/routes.ts` has no door
 * that would). So nothing here caches a value, and the form that held one is thrown away with the
 * dialog.
 */
import { type QueryClient, queryOptions } from "@tanstack/react-query";

export type SavedLogin = {
  id: string;
  /** What the person called it. */
  label: string;
  /** The key of a site this product knows (`@/lib/sites/catalogue`), or null. */
  site: string | null;
  /** The origins it may be put into, as the server normalised them. */
  origins: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type SavedLogins = { logins: SavedLogin[]; max: number };

/** What a person writes to save one. To change one, a value left out is a value kept. */
export type LoginWritten = {
  label: string;
  site: string | null;
  origins: string[];
  username?: string;
  password?: string;
};

export const loginKeys = { all: ["logins"] as const };

/**
 * A request the server refused, or that never reached it: the fact as a code, and which box it is
 * about where the server said. The words are this screen's (`refusals.ts`).
 */
export class LoginRefusal extends Error {
  readonly code: string;
  readonly field: string | undefined;
  constructor(code: string, field?: string) {
    super(code);
    this.name = "LoginRefusal";
    this.code = code;
    this.field = field;
  }
}

/** Not the server's: nothing answered, or what answered was no answer of these routes. */
export const LOGINS_UNREACHABLE = "laf:logins_unreachable";

async function send(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`/api/logins${path}`, {
    method,
    credentials: "include",
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  }).catch(() => null);
  if (!response) throw new LoginRefusal(LOGINS_UNREACHABLE);
  if (response.status === 204) return null;
  const answer = (await response.json().catch(() => null)) as {
    code?: unknown;
    field?: unknown;
  } | null;
  if (!response.ok) {
    const code =
      typeof answer?.code === "string" && answer.code.startsWith("laf:")
        ? answer.code
        : LOGINS_UNREACHABLE;
    throw new LoginRefusal(
      code,
      typeof answer?.field === "string" ? answer.field : undefined,
    );
  }
  return answer;
}

function isSavedLogin(value: unknown): value is SavedLogin {
  if (!value || typeof value !== "object") return false;
  const one = value as Partial<SavedLogin>;
  return (
    typeof one.id === "string" &&
    typeof one.label === "string" &&
    Array.isArray(one.origins) &&
    one.origins.every((origin) => typeof origin === "string")
  );
}

export function savedLoginsQueryOptions() {
  return queryOptions({
    queryKey: loginKeys.all,
    queryFn: async (): Promise<SavedLogins> => {
      const answer = (await send("GET", "")) as {
        logins?: unknown;
        max?: unknown;
      } | null;
      const logins = Array.isArray(answer?.logins)
        ? answer.logins.filter(isSavedLogin)
        : [];
      return {
        logins,
        max: typeof answer?.max === "number" ? answer.max : logins.length,
      };
    },
  });
}

/** Save a new one, or change one: the list is read again either way, from the server. */
export async function writeLogin(
  queryClient: QueryClient,
  written: LoginWritten,
  id?: string,
): Promise<void> {
  await send(id ? "PATCH" : "POST", id ? `/${encodeURIComponent(id)}` : "", {
    label: written.label,
    site: written.site,
    origins: written.origins,
    ...(written.username ? { username: written.username } : {}),
    ...(written.password ? { password: written.password } : {}),
  });
  await queryClient.invalidateQueries({ queryKey: loginKeys.all });
}

export async function removeLogin(
  queryClient: QueryClient,
  id: string,
): Promise<void> {
  await send("DELETE", `/${encodeURIComponent(id)}`);
  await queryClient.invalidateQueries({ queryKey: loginKeys.all });
}
