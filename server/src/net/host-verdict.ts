/**
 * The verdicts moved to `shared/net/host-verdict.ts` on 2026-09-13, when the Bot's browser began
 * refusing hosts itself: a redirect from an allowed host to `169.254.169.254` was judged by the
 * server once, before the request, and never again, so the container has to hold the same floor —
 * and the one thing this file's own header promised was that there would not be two lists. Every
 * server import keeps its path through this re-export.
 */
export * from "../../../shared/net/host-verdict";
