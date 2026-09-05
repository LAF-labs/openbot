import { queryOptions } from "@tanstack/react-query";
import { appConfig } from "@/lib/generated/application-config";

/**
 * Which sign-ins this deployment offers — asked of the server, not compiled in.
 *
 * The list used to be baked into the web image at build time from the `AUTH_PROVIDERS` build arg,
 * and the fleet measured what that means: an image built for `google` drew a Google button on a
 * VM whose `.env` said `laf`, and the button posted into a callback that deployment had never
 * registered. The server has always known the real answer — it refuses to start unless the
 * declaration and the credentials agree — so the surface asks it (`GET /api/auth/providers`) and
 * draws from what it says.
 *
 * The baked list is kept as the FALLBACK, and only that: for a server too old to have the route
 * (a web image ahead of its API), or one that cannot be reached at all. An empty answer from a
 * server that does answer is honoured as an answer — it is the deployment saying nobody can sign
 * in yet, which the screen already knows how to say in Korean.
 */
export const KNOWN_PROVIDERS = ["google", "kakao", "naver", "laf"] as const;
export type OfferedProvider = (typeof KNOWN_PROVIDERS)[number];

/** What this build was compiled with. Never the answer while the server can give one. */
export const bakedProviders: readonly string[] = appConfig.auth.providers;

/**
 * The server's body, or null when it is not the shape this app understands.
 *
 * Unknown names are dropped rather than failing the whole answer: a provider this build has no
 * button for cannot be offered whatever the server says, and one unfamiliar name must not turn a
 * good list into the baked fallback.
 */
export function parseProviders(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const { providers } = body as { providers?: unknown };
  if (!Array.isArray(providers)) return null;
  return providers.filter(
    (one): one is OfferedProvider =>
      typeof one === "string" &&
      (KNOWN_PROVIDERS as readonly string[]).includes(one),
  );
}

export async function fetchSignInProviders(
  fetchImpl: typeof fetch = fetch,
): Promise<readonly string[]> {
  let response: Response;
  try {
    response = await fetchImpl("/api/auth/providers", {
      credentials: "include",
    });
  } catch {
    return bakedProviders;
  }
  if (!response.ok) return bakedProviders;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return bakedProviders;
  }
  return parseProviders(body) ?? bakedProviders;
}

export const signInProvidersKey = ["auth", "providers"] as const;

export function signInProvidersQueryOptions() {
  return queryOptions({
    queryKey: signInProvidersKey,
    queryFn: () => fetchSignInProviders(),
    // The deployment's providers change with a restart, not with a click; asking once per screen
    // visit is plenty, and the fallback means a stale answer is never a blank screen.
    staleTime: 5 * 60_000,
  });
}
