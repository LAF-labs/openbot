import { normalizeHostname } from "./host-verdict";

/**
 * THE ADDRESSES THIS DEPLOYMENT ITSELF ANSWERS AT, WHICH ITS BOT'S BROWSER NEVER OPENS.
 *
 * A person answers a Bot's questions in the app — 이번만 허용 on a card, the Boundaries page that says
 * what is asked about at all — and signs in to the app with Naver, Kakao or Google. The Bot's
 * browser holds a profile people sign in to those same providers in, to connect their shop. So a
 * browser that could open the app could sign in to it as the person and press 허용 on the Bot's own
 * question: the one screen where somebody says yes, reachable from the channel the model acts
 * through. Everything the model reads is untrusted, and a page saying "open your own LAF page and
 * allow it" is one sentence. No rule stopped it until 2026-10-03 (found reading trycua/cua's
 * cua-driver, which refuses its own consent UI in every mode).
 *
 * WHICH ADDRESSES. The ones the server is already told are its own, by the variables it already
 * reads — so the two halves of the floor cannot be told different things:
 *
 * - `BETTER_AUTH_URL`, `PUBLIC_ORIGIN`, `TRUSTED_ORIGINS`: the app.
 * - `LAF_OIDC_ISSUER`: the fleet's sign-in broker, where a session for the app begins.
 *
 * Every hop is judged, so a flow begun anywhere else is stopped when it reaches one of these: a
 * provider's own redirect back to the app's callback is refused before it is sent, which is the
 * request a session would have been set on.
 *
 * COMPARED AS HOST AND PORT, NOT AS A NAME AND NOT AS A WHOLE ORIGIN. Not the name alone: on a
 * laptop the app is `localhost:<port>`, and refusing the name would refuse every local page a
 * development browser is opted in to open. Not the scheme too: `http://` to a host that serves
 * `https://` is one redirect — or one upgrade the browser makes by itself — from the same app, and a
 * port left unsaid is the same door under either scheme. No suffix is matched: a deployment's
 * neighbours and its parent domain are other people's sites.
 */

/** The variables a deployment's own addresses are read from. The server's own, and in its spelling. */
export const OWN_ADDRESS_VARIABLES = [
  "BETTER_AUTH_URL",
  "PUBLIC_ORIGIN",
  "TRUSTED_ORIGINS",
  "LAF_OIDC_ISSUER",
] as const;

/**
 * What two addresses of one app share: the host, and the port where one is said.
 *
 * `URL.port` is empty for the scheme's own port, so `https://shop.example` and
 * `http://shop.example` give the same key, and `http://localhost:3010` is not `localhost:4000`.
 */
export function addressKeyOf(url: URL): string {
  return `${normalizeHostname(url.hostname)}:${url.port}`;
}

/**
 * This deployment's own addresses, as the keys {@link addressKeyOf} gives.
 *
 * A value that is not a web address names nothing and is left out: the server's own configuration
 * is where a malformed one is refused, with the variable's name, and this must not be a second
 * place that fails a start.
 */
export function ownAddressesFrom(
  environment: Record<string, string | undefined>,
): string[] {
  const keys = new Set<string>();
  for (const name of OWN_ADDRESS_VARIABLES) {
    for (const value of (environment[name] ?? "").split(",")) {
      const written = value.trim();
      if (!written || !URL.canParse(written)) continue;
      const url = new URL(written);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      keys.add(addressKeyOf(url));
    }
  }
  return [...keys];
}
