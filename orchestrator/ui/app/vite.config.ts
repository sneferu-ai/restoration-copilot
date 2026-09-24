import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Two entry points (spec §4): the operator console and the bay guide PWA.
// The build emits hashed assets under ../web/static/restoration/app/ and an
// un-hashed service worker at ../web/static/restoration/app/guide-sw.js so the
// guide's registration path is stable across builds.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src"),
  base: "/static/restoration/app/",
  // root is src/, so Vite's default publicDir (<root>/public) never saw the
  // app-level public/ holding the launch-frozen brand mark — the built console
  // 404'd on /static/restoration/app/brand-mark.svg (round-4 P0). Point at the
  // real public dir; brand-mark.svg and guide-sw.js are copied verbatim to the
  // outDir root, and scripts/verify-static-assets.mjs (postbuild) proves it.
  publicDir: resolve(__dirname, "public"),
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: resolve(__dirname, "../web/static/restoration/app"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        operator: resolve(__dirname, "src/operator/index.html"),
        guide: resolve(__dirname, "src/guide/index.html"),
      },
      output: {
        entryFileNames: "[name]-[hash].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/restoration": "http://localhost:8000",
      "/admin": "http://localhost:8000",
      "/bridge": "http://localhost:8000",
      "/guide": "http://localhost:8000",
    },
  },
});
