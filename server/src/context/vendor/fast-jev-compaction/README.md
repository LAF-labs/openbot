# fast-jev-compaction (vendored)

Upstream: https://github.com/tamaratran/fast-jev-compaction at `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`
(2026-09-17), MIT — see `LICENSE`. Copied from upstream's `src/`, not installed from npm: the npm
package `fast-jev-compaction` is published from a fork with other contents
(`~/laf/docs/jev-oss-evaluation.md` §3.1). Upstream's own suite runs as
`server/tests/vendor/fast-jev-compaction.test.ts` (bun:test in place of vitest, nothing else changed).

What LAF uses: `compact()` for the keep/drop decisions and `collectToolCalls()` to map them back to
tool-call ids. The decisions are applied by `server/src/context/compaction.ts`, not by
`applyDecisions`, so kept messages stay the exact objects (and bytes) the conversation holds.

Local changes, each marked `LAF local change` in the code:

- `CompactOptions.describeResult` / `ResolvedCompactOptions.describeResult` (`types.ts`,
  `compact.ts`, `state.ts`): what stands for a result in the state. Upstream shows Jev only
  `ok, N chars (omitted)`, so a result is judged blind; in the 2026-09-25 evaluation that dropped an
  order result holding a refund reason nobody restated. LAF passes a redacted excerpt.
- A three-line attribution header on every file.

Before updating: read the upstream diff from this commit, re-run the vendored suite and the
needle-recall arm of `bun run eval:compaction`.
