/**
 * Where a state-changing request is allowed to have come from.
 *
 * WHY A COOKIE IS NOT ENOUGH HERE. Sessions are cookies, and better-auth's default is
 * `SameSite=Lax` — which stops a cross-site POST from a form on another site, and stops nothing at
 * all between two sites that are same-site with each other. Every deployment of this product lives
 * at `https://<name>.agent.laf-co.com`: one registrable domain, so every customer's VM is same-site
 * with every other customer's VM. `Lax` is not a boundary between them. A page on one customer's
 * deployment could post to another's with that person's cookie attached, and the only thing that
 * would have said no is this.
 *
 * THE RULE, AND WHY IT IS SHAPED LIKE THIS:
 *
 * - An `Origin` that is present must be one this deployment trusts. Browsers attach it to every
 *   request that can change something, and they do not let a page lie about it.
 * - An ABSENT `Origin` passes. That is curl, the fleet tool, a routine's webhook sender and the
 *   desktop shell's own inward calls — none of which are a browser being driven by somebody else's
 *   page, which is the whole thing being defended against. Refusing them would break every machine
 *   caller for a property they cannot demonstrate.
 * - ...unless `Sec-Fetch-Site: cross-site` is there, which is a browser saying the request came
 *   from another site while sending no origin. That is not a machine caller.
 *
 * An UPGRADE is stricter (`upgradeOriginAllowed`): a browser always sends `Origin` on a WebSocket
 * handshake, so an absent one there is not a browser, and the two sockets this deployment opens are
 * both browser-only — the live screen a person types into, and the activity feed.
 */

/** The one code the surface sees for this. The server sends facts; the surface owns the words. */
export const ORIGIN_REFUSED = "laf:origin_refused";

/** The body every refusal here answers with. */
export const originRefusalBody = {
  error: ORIGIN_REFUSED,
  code: ORIGIN_REFUSED,
} as const;

/**
 * Whether an ordinary state-changing request may be answered.
 *
 * Compared as whole origins and nothing more — no suffix matching, no scheme-blind compare. A
 * check that admitted `https://evil-laf-co.com` because it ends the right way is worse than none.
 */
export function originAllowed(
  headers: Headers,
  trustedOrigins: readonly string[],
): boolean {
  const origin = headers.get("origin");
  if (origin) return trustedOrigins.includes(origin);
  return headers.get("sec-fetch-site")?.toLowerCase() !== "cross-site";
}

/** The same question for a WebSocket handshake, where an absent `Origin` is also a refusal. */
export function upgradeOriginAllowed(
  headers: Headers,
  trustedOrigins: readonly string[],
): boolean {
  const origin = headers.get("origin");
  return Boolean(origin) && trustedOrigins.includes(origin as string);
}

/**
 * The two paths the rule does not apply to.
 *
 * `/api/auth/*` is better-auth's own, and it checks its own trusted origins — applying this on top
 * would mean two lists to keep in step, and the OAuth callback arrives with an origin belonging to
 * the provider.
 *
 * `POST /api/routines/:id/trigger` is a machine webhook, authenticated by a token in a header that
 * no browser attaches and no cross-site page can read (routines/routes.ts). It is the one route in
 * this product deliberately not behind a session, so a cookie is not what it would be riding.
 */
export function isOriginExempt(pathname: string): boolean {
  if (pathname.startsWith("/api/auth/")) return true;
  return /^\/api\/routines\/[^/]+\/trigger\/?$/.test(pathname);
}
