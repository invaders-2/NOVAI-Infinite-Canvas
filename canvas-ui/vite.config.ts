import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 库模式：产物直接落到 NOVAI 的 static/canvas-assistant/，由 canvas-assistant-bridge.js 动态加载。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 库模式不会自动替换 process.env.NODE_ENV，浏览器里会直接 ReferenceError
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "../static/canvas-assistant",
    emptyOutDir: true,
    cssCodeSplit: false,
    target: "es2020",
    lib: {
      entry: fileURLToPath(new URL("./src/entry.tsx", import.meta.url)),
      name: "NovaiCanvasAssistant",
      formats: ["iife"],
      fileName: () => "assistant-ui.js",
      cssFileName: "assistant-ui",
    },
    rollupOptions: {
      output: { extend: true },
    },
  },
});
