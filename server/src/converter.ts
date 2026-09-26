/**
 * The converter's entry: the `converter` service in docker-compose.yml, and every child it starts.
 *
 *   bun dist/converter.js --socket <path> [--require-isolation]   the daemon, one per deployment
 *   bun dist/converter.js --job                                    one file, then gone
 *
 * Built into the server's image beside `dist/index.js` (server/Dockerfile) and run from it with a
 * different command, so a deployment pulls nothing new. Settings come from the command line and
 * never from the environment: the service is handed no environment worth reading, and the server's
 * one reader of it (`config.ts`) is the server's.
 */
import { answerOneJob, jobCommandFor } from "./attachments/converter-process";

const argv = process.argv.slice(2);

if (argv.includes("--job")) {
  answerOneJob();
} else {
  const at = argv.indexOf("--socket");
  const { runConverterDaemon } = await import("./attachments/converter-daemon");
  await runConverterDaemon({
    socketPath: at >= 0 ? argv[at + 1] : undefined,
    requireIsolation: argv.includes("--require-isolation"),
    // This very file as the child: `process.argv[1]` is the bundle in the image and the source in
    // development, so the daemon always starts what it is.
    jobCommand: jobCommandFor(process.argv[1] ?? ""),
  });
}
