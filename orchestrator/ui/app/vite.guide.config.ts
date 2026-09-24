import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

// Bay Guide SPA → served by the guide handler at /guide/{token} with bundles
// under /guide/bundles/ (SP-5: token-free, content-hashed, immutable).
export default defineConfig({
  root: resolve(__dirname, "guide"),
  plugins: [react(), tailwindcss()],
  base: "/guide/bundles/",
  publicDir: resolve(__dirname, "guide/public"),
  resolve: {
    alias: { "@shared": resolve(__dirname, "shared") },
  },
  build: {
    outDir: resolve(__dirname, "dist/guide"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: { index: resolve(__dirname, "guide/index.html") },
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-idb": ["idb"],
        },
      },
    },
  },
  server: {
    port: 5175,
    proxy: {
      "/guide": "http://localhost:8000",
      "/restoration": "http://localhost:8000",
    },
  },
});
