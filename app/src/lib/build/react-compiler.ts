import type { PluginOptions } from "babel-plugin-react-compiler";

/**
 * THE OPTIONS THE BUILD COMPILES WITH, AND THE ONLY ONES THE COVERAGE CHECK MEASURES WITH.
 *
 * `vite.config.ts` hands these to `babel-plugin-react-compiler`, and
 * `tests/react-compiler.test.ts` runs the same compiler with the same options over every module in
 * `src`, adding only a logger. Written twice, the two would drift apart the first time somebody
 * tuned the build, and the check would go on measuring a compiler the app no longer uses.
 *
 * `target: "19"` imports the memo cache from `react/compiler-runtime`, which React 19 ships; there is
 * no runtime package to install. `panicThreshold: "none"` means a function the compiler cannot prove
 * safe is left exactly as written instead of failing the build: the one thing that notices how many
 * functions that happened to is the ceiling in the test.
 *
 * `validateNoImpureFunctionsInRender`, off by default, turns a quiet change of behaviour into a
 * skip the ceiling counts. The compiler assumes rendering is pure, so a `Date.now()` read while
 * rendering is computed once and kept; with this on, a component that does it is left uncompiled
 * instead — behaving as it always did — and named in the list. It knows `Date.now`,
 * `performance.now` and `Math.random`, not `new Date()`: that one is `useNow` (`lib/use-now.ts`).
 */
export const REACT_COMPILER_OPTIONS = {
  target: "19",
  panicThreshold: "none",
  environment: { validateNoImpureFunctionsInRender: true },
} as const satisfies PluginOptions;
