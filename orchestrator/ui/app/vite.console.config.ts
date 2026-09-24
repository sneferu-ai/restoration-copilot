import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

// Console SPA → served by the WSGI host at /restoration-ui with bundles under
// /static/restoration/app/ (the existing traversal-proof _static handler).
export default defineConfig({
  root: resolve(__dirname, "console"),
  plugins: [react(), tailwindcss()],
  base: "/static/restoration/app/",
  publicDir: resolve(__dirname, "console/public"),
  resolve: {
    alias: { "@shared": resolve(__dirname, "shared") },
  },
  build: {
    outDir: resolve(__dirname, "../web/static/restoration/app"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: { index: resolve(__dirname, "console/index.html") },
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-query": ["@tanstack/react-query"],
          "vendor-forms": ["react-hook-form", "@hookform/resolvers", "zod"],
          "vendor-charts": ["recharts"],
          "vendor-idb": ["idb"],
        },
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/restoration": "http://localhost:8000",
      "/admin": "http://localhost:8000",
      "/live": "http://localhost:8000",
      "/bridge": "http://localhost:8000",
    },
  },
});
