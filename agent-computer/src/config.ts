/**
 * What this process is told by its environment, read once at boot.
 *
 * Here rather than scattered through the modules that use each value, so the boot line in
 * `index.ts` and the code that acts on a value can never read two different spellings of it — and
 * so a test can hand a module a setting without touching `process.env`.
 */

export type ComputerConfig = {
  /** See {@link readConfig}: without it the process does not start. */
  token: string;
  port: number;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  allowPrivateHosts: boolean;
  /** See {@link readConfig}: false only where the deployment said `off`. */
  egressFirewall: boolean;
  profilesDir: string;
  workspaceDir: string;
};

/**
 * The settings, or null when the one that cannot be defaulted is missing.
 *
 * THE SECRET EVERY CALLER MUST PRESENT. This process drives a browser that holds real logins.
 * Policy, audit, actor identity and SPIFFE identity live in the server and are not on the direct
 * computer port. Refusing to start without a token makes missing authentication a deployment
 * failure, never an open computer — which is why this answers null rather than a default, and
 * `index.ts` exits on it.
 */
export function readConfig(
  environment: Record<string, string | undefined> = process.env,
): ComputerConfig | null {
  const token = environment.COMPUTER_TOKEN?.trim();
  if (!token) return null;
  return {
    token,
    port: Number.parseInt(environment.PORT ?? "4100", 10),
    navigationTimeoutMs: Number.parseInt(
      environment.NAVIGATION_TIMEOUT_MS ?? "30000",
      10,
    ),
    /**
     * How long one action waits for its element.
     *
     * Much shorter than a navigation. Playwright waits for a control to become clickable, which is
     * the behaviour we want, but a ref that no longer resolves would otherwise hang for the full
     * navigation timeout before saying so, and the person is sitting watching a screen that is not
     * changing.
     */
    actionTimeoutMs: Number.parseInt(
      environment.ACTION_TIMEOUT_MS ?? "10000",
      10,
    ),
    /**
     * Whether this browser may open the deployment's own network.
     *
     * THE SAME VARIABLE THE SERVER READS, because the two halves of one floor must agree. The server
     * judges the address a Bot asks for before the request leaves (`computer/client.ts`); this
     * process judges every hop the browser then actually follows (`navigation-guard.ts`), and a
     * laptop that has opted the server into browsing `localhost` has to opt the browser in with the
     * same word or every local navigation is refused one hop later with no way to see why. Off
     * unless it says `true`, exactly as the server does, so a hosted deployment cannot reach its own
     * network by forgetting.
     */
    allowPrivateHosts:
      environment.AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS?.trim() === "true",
    /**
     * Whether a browser waits for the host's egress rules (egress-guard.ts).
     *
     * On unless it says `off`, which is the laptop's way past it: Docker Desktop has no host to put
     * the rules on. The variable kept its name from when it switched the container's own firewall,
     * so a laptop's `.env` means the same thing it always did.
     */
    egressFirewall:
      environment.AGENT_COMPUTER_EGRESS_FIREWALL?.trim().toLowerCase() !==
      "off",
    profilesDir: environment.PROFILES_DIR ?? "/profiles",
    workspaceDir: environment.WORKSPACE_DIR ?? "/workspace",
  };
}
