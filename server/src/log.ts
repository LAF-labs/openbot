/**
 * The server's log. Every line this process writes for an operator goes through here.
 *
 * The shape, the scrubbing and the reasons are in `shared/log.ts`; this is the one instance, named
 * the way the compose service is named, so `docker compose logs server` and `"svc":"server"` agree.
 */
import { createLogger, reportCrashes } from "../../shared/log";

export const log = createLogger("server");

// Here rather than in index.ts, so it is in force before the first import that can throw at boot
// (`loadConfig`, the database, the tenant package) rather than after all of them.
reportCrashes(log);
