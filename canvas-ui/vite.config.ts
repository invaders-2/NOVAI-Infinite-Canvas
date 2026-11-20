import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot } from "vite";

// 库模式：产物直接落到 NOVAI 的 static/canvas-assistant/，由 canvas-assistant-bridge.js 动态加载。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 库模式不会自动替换 process.env.NODE_ENV，浏览器里会直接 ReferenceError
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // 仅 dev：回放入口读取 _verification-thinking-integration/ 里录制的真实 SSE 事件
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        fileURLToPath(new URL("../_verification-thinking-integration", import.meta.url)),
      ],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:" + (process.env.NOVAI_PORT || 3000),
        // 本机 starlette 0.41 的 GZipMiddleware 没有排除 text/event-stream，浏览器默认带
        // Accept-Encoding: gzip 会把 SSE 压成一整块再吐出来，逐词流式直接看不到。
        // 开发代理强制 identity，后端就不压缩，SSE 才能一条条到浏览器（仅影响 dev）。
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("accept-encoding", "identity"));
        },
      },
    },
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
