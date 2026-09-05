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

export default defineConfig({
  plugins: [tanstackRouter(), react(), tailwindcss()],
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
