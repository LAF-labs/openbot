import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * One proxy, declared once. The dev server and `vite preview` each need their
 * own copy — preview does not inherit `server.proxy`, and a production box
 * that serves the built app through preview would otherwise answer every
 * `/api` call with the app's own HTML.
 */
const apiProxy = {
  // `ws: true` is required for the live screen. Without it Vite answers the upgrade request with
  // the app's HTML and the socket fails with an opaque error that looks like a server problem.
  "/api": {
    target: `http://localhost:${process.env.SERVER_PORT ?? "3001"}`,
    ws: true,
  },
  /*
   * The one page the SERVER draws rather than the app: where a consent started in the desktop
   * shell lands, because that flow finishes in a browser with no session (`connected-page.ts`).
   * Without this line Vite's SPA fallback answers it with index.html — the app, signed out, which
   * is the exact screen the page exists to avoid. The front door forwards it for the same reason.
   */
  "/connected": {
    target: `http://localhost:${process.env.SERVER_PORT ?? "3001"}`,
  },
};

/**
 * The installed package a module came from, read from the LAST `node_modules/` in its path.
 *
 * Bun installs isolated: the real path of a dependency is
 * `node_modules/.bun/<name>@<version>/node_modules/<name>/…`, and Vite resolves the symlink before
 * it hands the id to Rollup. Reading the FIRST `node_modules/` would name every package `.bun`;
 * reading the last one names it correctly here and under a hoisted npm layout both.
 */
const packageOf = (id: string): string | null => {
  const marker = id.lastIndexOf("node_modules/");
  if (marker === -1) {
    return null;
  }
  const [first, second] = id
    .slice(marker + "node_modules/".length)
    .split("/") as Array<string | undefined>;
  if (!first) {
    return null;
  }
  return first.startsWith("@") && second ? `${first}/${second}` : first;
};

/**
 * WHAT IS GROUPED BY HAND, AND — MORE IMPORTANTLY — WHAT IS LEFT ALONE.
 *
 * The first four are what every screen needs, so they are static imports of the entry however the
 * routes are split. Naming them keeps them in chunks with stable contents: editing a screen no
 * longer invalidates React and the router in everybody's cache.
 *
 * The transcript's renderer (`markdown`) is the opposite case. It is reached only through route
 * components, which `autoCodeSplitting` turns into dynamic imports, so this group comes out as an
 * ASYNC chunk — the sign-in screen never fetches it. The grouping only gives it one name instead of
 * a hash that moves whenever the chat screens do.
 *
 * Shiki's grammars, Mermaid's diagram types, KaTeX and Cytoscape are deliberately ABSENT. Streamdown
 * already reaches all four through `import()`, so Rollup gives each grammar and each diagram type a
 * chunk of its own and a transcript downloads only the languages it actually shows. Listing them
 * here would MERGE those chunks: one `shiki` entry fuses ~300 grammars — 16 MB of them, `emacs-lisp`
 * and `cpp` and `wasm` included — into a single file that any fenced code block would then have to
 * pull down in full. Hand-grouping is not automatically the smaller build; here it is 16 MB worse.
 */
const MANUAL_CHUNKS: Record<string, string> = {
  react: "vendor-react",
  "react-dom": "vendor-react",
  scheduler: "vendor-react",
  "use-sync-external-store": "vendor-react",
  "@tanstack/react-router": "vendor-router",
  "@tanstack/router-core": "vendor-router",
  "@tanstack/history": "vendor-router",
  "@tanstack/react-query": "vendor-query",
  "@tanstack/query-core": "vendor-query",
  /*
   * THE THREE-LINE PACKAGES THAT DECIDE WHETHER A MEGABYTE IS ASYNC.
   *
   * `clsx` and `tailwind-merge` are what `cn()` is made of, so every screen uses them — including
   * Streamdown, and including the entry. Rollup has to put a module shared like that somewhere, and
   * left to itself it put both inside the `markdown` chunk. The entry then imported `markdown` for
   * two functions totalling under 3 kB, which made the chunk a STATIC dependency: 1.08 MB of
   * transcript renderer, `<link rel="modulepreload">`-ed on the sign-in screen. The measured entry
   * was 331 kB and the sign-in screen still fetched 1.6 MB. Naming a chunk of their own is what
   * makes the split real rather than cosmetic.
   */
  clsx: "vendor-utils",
  "tailwind-merge": "vendor-utils",
  "class-variance-authority": "vendor-utils",
  streamdown: "markdown",
  "react-markdown": "markdown",
  marked: "markdown",
};

export default defineConfig({
  plugins: [
    /*
     * EVERY ROUTE'S COMPONENT BECOMES A DYNAMIC IMPORT, WITHOUT A SINGLE `.lazy.tsx` FILE.
     *
     * Without this the entry chunk was 3.16 MB and held all 22 routes — the nine admin screens, the
     * chat transcript and, through it, Streamdown, Shiki and Mermaid. All of it was paid for on
     * `/sign`, a screen with one field on it. The plugin rewrites each `createFileRoute`'s
     * `component` / `errorComponent` / `pendingComponent` / `notFoundComponent` into a split module;
     * `beforeLoad` and `loader` stay in the entry, which is what keeps the redirect in `_authed`
     * synchronous — the signed-out person is sent to `/sign` without a screen's worth of JavaScript
     * being fetched first.
     */
    tanstackRouter({ autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      /*
       * The prompt and the tool catalogue are not the app's to copy.
       *
       * `shared/` is the one source for what a Bot is told and what tools it has; the surface
       * registers from it and the server's unattended loop imports the same objects. Plain
       * dependency-free TypeScript, so it bundles like any other module.
       */
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  build: {
    /*
     * MEASURED, NOT PICKED: just above the largest chunk this build deliberately produces.
     *
     * Three chunks clear 500 kB and none of them is ours to shrink — `markdown` at 1,049 kB is one
     * npm package (Streamdown, with Shiki's core inside it), `copilotkit` at 815 kB is another, and
     * `emacs-lisp` at 780 kB is a Shiki grammar, one of ~300 that only load when a transcript shows
     * that language. All three are async: none is fetched before a transcript exists. Leaving the
     * default 500 meant six warnings on every build, all of them unactionable, which is how a build
     * teaches people to skim past its warnings. 1100 keeps it a signal — the entry chunk is 331 kB,
     * so anything that fires this is either a new dependency nobody weighed or the split coming
     * undone.
     */
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          /*
           * Vite's own `__vitePreload`, which every dynamic import calls. It is a virtual module
           * with no package to read, and it rode into the `markdown` chunk for the same reason
           * `clsx` did — see above. It belongs with the other shared scraps.
           */
          if (id.includes("vite/preload-helper")) {
            return "vendor-utils";
          }
          const pkg = packageOf(id);
          return pkg ? MANUAL_CHUNKS[pkg] : undefined;
        },
      },
    },
  },
  server: {
    port: Number.parseInt(process.env.APP_PORT ?? "3010", 10),
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    port: Number.parseInt(process.env.APP_PORT ?? "3010", 10),
    strictPort: true,
    host: "127.0.0.1",
    proxy: apiProxy,
  },
});
