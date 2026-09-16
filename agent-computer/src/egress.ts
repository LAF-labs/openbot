/**
 * Where this computer's traffic leaves from.
 *
 * ONE ADDRESS FOR THE DEPLOYMENT, NOT ONE PER BOT — and that is a loss, recorded here rather than
 * discovered. `EGRESS_PROXY_<BOT>` used to give each Bot its own upstream proxy, so the far side saw
 * a different address per Bot and could allow-list or attribute by it. Sharing one browser profile
 * (2026-09-16, `profiles.ts`) means sharing one Chromium — a user-data directory admits one process
 * — and a proxy is chosen once, at launch, for the browser. There is no longer anything for a
 * per-Bot proxy to attach to.
 *
 * So `EGRESS_PROXY_DEFAULT` is the whole of the configuration now, and a deployment that still names
 * a per-Bot variable is TOLD, at launch, that it is not being honoured. Silently browsing somebody's
 * bank from an address their security team did not choose is precisely the failure this warning
 * exists to prevent; `ignoredEgressVariables` is what the boot line reads.
 *
 * This does not anonymise anything and it is not a security boundary by itself. It gives the far
 * side a stable address to allow-list, which is what a security team actually asks for. No proxy
 * configured means going out directly, which is the right default for a laptop and the wrong one for
 * a deployment that cares.
 *
 * This module has no Playwright import, so proxy parsing tests can run outside the browser image.
 */

/** A proxy as Playwright wants it: credentials separated from the URL. */
export type Egress = {
  server: string;
  username?: string;
  password?: string;
};

/** The one variable a shared browser can honour. */
const DEFAULT_VARIABLE = "EGRESS_PROXY_DEFAULT";

/**
 * Every `EGRESS_PROXY_*` this deployment sets that the browser cannot honour any more.
 *
 * Names only. The values are proxy URLs and a proxy URL routinely carries a password, so nothing
 * that reads this — a log line, a boot announcement — can leak one by accident.
 */
export function ignoredEgressVariables(
  env: Record<string, string | undefined>,
): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        name.startsWith("EGRESS_PROXY_") &&
        name !== DEFAULT_VARIABLE &&
        !!env[name]?.trim(),
    )
    .sort();
}

/**
 * The proxy the deployment's browser leaves through, or null for direct.
 *
 * Reads `EGRESS_PROXY_DEFAULT` and nothing else. A per-Bot variable is not consulted, not merged and
 * not quietly promoted to the default: see the header.
 */
export function deploymentEgress(
  env: Record<string, string | undefined>,
): Egress | null {
  const raw = env[DEFAULT_VARIABLE];
  if (!raw?.trim()) return null;

  // Credentials commonly arrive inside the URL, which is how proxies are handed out. They are split
  // out so that the server string this returns can be shown to a person without leaking a password.
  try {
    const url = new URL(raw.trim());
    const username = url.username
      ? decodeURIComponent(url.username)
      : undefined;
    const password = url.password
      ? decodeURIComponent(url.password)
      : undefined;
    url.username = "";
    url.password = "";
    return {
      server: url.toString().replace(/\/$/, ""),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  } catch {
    // Not a URL. Passed through as a bare `host:port`, which Playwright also accepts, so an operator
    // who writes the obvious thing is not told they are wrong.
    return { server: raw.trim() };
  }
}

/**
 * The label for that egress, for people and for the admin list.
 *
 * Host only. A proxy URL routinely carries a password, and this string is rendered in a browser and
 * returned by an API.
 */
export function deploymentEgressLabel(
  env: Record<string, string | undefined>,
): string | null {
  const proxy = deploymentEgress(env);
  if (!proxy) return null;
  try {
    // `||` handles bare `proxy.internal:8080`, which URL parses as a scheme plus path and an empty
    // host rather than throwing.
    return new URL(proxy.server).host || proxy.server;
  } catch {
    return proxy.server;
  }
}
