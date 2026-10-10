/**
 * The addresses of a saved login, as the 계정 screen offers, reads and draws them.
 *
 * Apart from the screen because they decide something and draw nothing: a login is put only into
 * a document of an origin it was saved for (`shared/login-origin.ts`), so what is offered for a
 * site, and how what a person typed is read, is whether the login is ever used.
 */
import { BUSINESS_SITES } from "@/lib/sites/catalogue";

/** The select's value for a site that is not one of ours. A site id is never empty. */
export const ANOTHER_SITE = "another";

/**
 * The hosts a site's logins are offered for: where its sign-in boxes are, where its sign-in
 * starts, then the hosts it is. The first is what decides whether the login is ever used — a
 * login goes only into a document of an origin it was saved for.
 */
export function addressesOf(siteId: string): string[] {
  const site = BUSINESS_SITES.find((one) => one.id === siteId);
  if (!site) return [];
  const start = URL.canParse(site.loginUrl)
    ? [new URL(site.loginUrl).host]
    : [];
  return [...new Set([...(site.signInHosts ?? []), ...start, ...site.hosts])];
}

/** An origin as a person reads it: the host, and the scheme only where it is not the usual one. */
export function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, "");
}

/** What was typed into the addresses box, one address to a line or between commas. */
export function addressesIn(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}
