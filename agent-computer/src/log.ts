/**
 * The computer's log. One instance, named the way the compose service is named.
 *
 * The shape and the scrubbing are in `shared/log.ts`, which this image carries for the purpose:
 * a browser holding real logins is the process whose log most needs to be sure of what it says.
 */
import { createLogger, reportCrashes } from "../../shared/log";

export const log = createLogger("agent-computer");

reportCrashes(log);
