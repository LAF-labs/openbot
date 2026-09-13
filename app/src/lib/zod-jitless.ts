import { config } from "zod";

/**
 * Zod without `new Function`, before any schema exists.
 *
 * Zod 4 compiles object parsers with `new Function` when it may, and finds out whether it may by
 * trying once — the moment the first `z.object` is built, which is at import time. Under the front
 * door's policy (`app/Caddyfile`, no `'unsafe-eval'`) that try is refused and caught, and the page
 * still reports it: measured 2026-09-13, one `script-src` violation from Zod's probe on every load
 * of every screen, and nothing else. Zod says the same beside the probe (`jitless` skips it). The
 * parsers are the interpreted ones Zod falls back to under the policy anyway; this only stops the
 * attempt.
 *
 * Imported FIRST in main.tsx, because module bodies run in import order and the probe runs in the
 * body of whichever module builds the first schema.
 */
config({ jitless: true });
