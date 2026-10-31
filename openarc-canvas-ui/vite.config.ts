import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/static/openarc-canvas/",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:" + (process.env.NOVAI_PORT || 3000),
    },
  },
  build: {
    outDir: "../static/openarc-canvas",
    emptyOutDir: true,
    cssCodeSplit: false,
    target: "es2020",
    rollupOptions: {
      output: {
        entryFileNames: "canvas.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (asset) => asset.name?.endsWith(".css") ? "canvas.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
