/**
 * The navigation floor lives in `shared/net/navigation-target.ts` since 2026-09-13, so that the
 * browser container applies the same decision to every hop it is about to request
 * (`agent-computer/src/navigation-guard.ts`). Server imports keep this path.
 */
export * from "../../../shared/net/navigation-target";
