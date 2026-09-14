/**
 * The server's log. Every line this process writes for an operator goes through here.
 *
 * The shape, the scrubbing and the reasons are in `shared/log.ts`; this is the one instance, named
 * the way the compose service is named, so `docker compose logs server` and `"svc":"server"` agree.
 */
import { createLogger, rememberLines, reportCrashes } from "../../shared/log";

/**
 * The tail of what this process wrote, for the 문의·의견 box's diagnostic details
 * (`support/diagnostics.ts`), which read a person's own events out of it and nothing else.
 *
 * Two thousand lines: the box keeps fifty of ONE person's, and on a VM with staff on it most lines
 * are somebody else's or nobody's. A million characters caps what a burst of long lines can hold.
 */
export const recentLines = rememberLines({ lines: 2_000, chars: 1_000_000 });

export const log = createLogger("server", recentLines.sink);

// Here rather than in index.ts, so it is in force before the first import that can throw at boot
// (`loadConfig`, the database, the tenant package) rather than after all of them.
reportCrashes(log);
