/**
 * What a browser fetches before the first screen after sign-in can draw, and whether that includes
 * something that belongs behind a lazy boundary.
 *
 * MEASURED 2026-09-10 (audit A4, finding 5), and again on 2026-09-13 at `61a0fc8`: the static closure
 * of the entry, the two layouts and Home was 46 JavaScript files, 2,898 kB raw and 893 kB gzipped,
 * and 1,864 kB of that raw was the transcript renderer (`markdown`, 1,049 kB) and CopilotKit (815
 * kB) — on a screen with no transcript. One `import { Streamdown }` in a tool renderer the provider
 * registers, and the provider itself wrapping every signed-in screen. `vite.config.ts` had promised
 * since W2 that the renderer was reached "only through route components"; the promise was a sentence
 * in a comment, and nothing noticed it stop being true.
 *
 * Pure, so the rule is tested on a synthetic graph without a thirty-second build; `vite.config.ts`
 * runs the same functions over Rollup's real graph and refuses the build when they find an offence.
 */

/** One chunk as the closure sees it. */
export type ChunkEdges = {
  fileName: string;
  /** Static imports, by file name — Rollup's `imports`, never its `dynamicImports`. */
  imports: readonly string[];
  isEntry?: boolean;
  /** The module a split chunk stands for: `…/routes/_authed.tsx?tsr-split=component` and the like. */
  facadeModuleId?: string | null;
  /** The lazy-only packages this chunk holds JavaScript from. Empty for everything else. */
  heavy?: readonly string[];
};

/** Everything `start` imports statically, transitively, `start` included. */
export function staticClosure(
  start: string,
  chunks: readonly ChunkEdges[],
): string[] {
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const fileName = stack.pop() as string;
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    for (const next of byFile.get(fileName)?.imports ?? []) stack.push(next);
  }
  return [...seen];
}

/**
 * The packages that must stay behind a lazy boundary: the transcript renderer (Streamdown, with
 * Shiki's core and its markdown parsers) and the CopilotKit runtime client.
 */
export const LAZY_ONLY_PACKAGES = [
  "streamdown",
  "react-markdown",
  "marked",
  "shiki",
  "@copilotkit/react-core",
  "@copilotkit/core",
  "@copilotkit/runtime-client-gql",
  "@ag-ui/client",
] as const;

/**
 * The installed package a module came from, read from the LAST `node_modules/` in its path.
 *
 * Bun installs isolated: the real path of a dependency is
 * `node_modules/.bun/<name>@<version>/node_modules/<name>/…`, and Vite resolves the symlink before
 * it hands the id to Rollup. Reading the FIRST `node_modules/` would name every package `.bun`;
 * reading the last one names it correctly here and under a hoisted npm layout both.
 */
export function packageOf(id: string): string | null {
  const marker = id.lastIndexOf("node_modules/");
  if (marker === -1) return null;
  const [first, second] = id
    .slice(marker + "node_modules/".length)
    .split("/") as Array<string | undefined>;
  if (!first) return null;
  return first.startsWith("@") && second ? `${first}/${second}` : first;
}

/**
 * The lazy-only package a module belongs to, if it is JavaScript from one.
 *
 * JAVASCRIPT ONLY, and that was learned the first time the check ran: `main.tsx` imports
 * `@copilotkit/react-core/v2/styles.css`, whose module id sits in the entry chunk's module list, and
 * the check refused a build whose JavaScript was clean. A stylesheet is not the megabyte this is
 * about, and it is not in any `.js` file the browser has to parse.
 */
export function lazyOnlyPackageOf(moduleId: string): string | null {
  const path = moduleId.split("?")[0] ?? "";
  if (!/\.[cm]?[jt]sx?$/.test(path)) return null;
  const pkg = packageOf(path);
  return pkg && (LAZY_ONLY_PACKAGES as readonly string[]).includes(pkg)
    ? pkg
    : null;
}

/**
 * The route modules whose components are on screen at the first paint after sign-in: the layout
 * every signed-in screen renders through, the one with the rail, and Home.
 *
 * By module rather than by chunk name, because Rollup names Home's chunk `index-*` — as it does the
 * entry, and one of CopilotKit's own chunks.
 */
export const FIRST_PAINT_ROUTES = [
  "src/routes/_authed.tsx",
  "src/routes/_authed/_app.tsx",
  "src/routes/_authed/_app/index.tsx",
] as const;

function isFirstPaint(chunk: ChunkEdges): boolean {
  if (chunk.isEntry) return true;
  const facade = chunk.facadeModuleId?.split("?")[0];
  return (
    facade !== undefined &&
    FIRST_PAINT_ROUTES.some((route) => facade.endsWith(`/${route}`))
  );
}

/** For each first-paint chunk, the chunks holding lazy-only packages its static closure reaches. */
export function lazyBoundaryOffences(
  chunks: readonly ChunkEdges[],
): { from: string; reaches: { fileName: string; packages: string[] }[] }[] {
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  return chunks
    .filter(isFirstPaint)
    .map((chunk) => ({
      from: chunk.fileName,
      reaches: staticClosure(chunk.fileName, chunks).flatMap((fileName) => {
        const packages = byFile.get(fileName)?.heavy ?? [];
        return packages.length > 0
          ? [{ fileName, packages: [...packages] }]
          : [];
      }),
    }))
    .filter((offence) => offence.reaches.length > 0);
}
