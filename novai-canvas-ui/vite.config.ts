import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  base: "/static/novai-canvas/",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  server: {
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://127.0.0.1:" + (process.env.NOVAI_PORT || 3000),
    },
  },
  build: {
    outDir: "../static/novai-canvas",
    emptyOutDir: true,
    cssCodeSplit: false,
    target: "es2020",
    rollupOptions: {
      output: {
        entryFileNames: "canvas.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (asset) => asset.name?.endsWith(".css") ? "canvas.css" : "assets/[name]-[hash][extname]",
        // 懒加载 chunk 只能从无查询串的 hash 文件里 import 共享模块：入口 canvas.js 在页面里带 ?v=，
        // 若共享模块留在入口，懒 chunk 就会 import "../canvas.js"（无 ?v=）从而把入口执行第二遍、出现两份 React。
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          const pkg = id.split("node_modules/").pop()?.split("/") ?? [];
          const name = pkg[0]?.startsWith("@") ? pkg[0] + "/" + pkg[1] : pkg[0];
          if (!name) return;
          if (name === "react" || name === "react-dom" || name === "scheduler" || name === "streamdown" || name.startsWith("@streamdown/")) {
            // streamdown 的代码块高亮体保留为独立懒 chunk，其余 streamdown 代码进 vendor，懒 chunk 便只 import vendor（无查询串）
            if (/[\\/]streamdown[\\/]dist[\\/]highlighted-body-/.test(id)) return;
            return "vendor-react";
          }
        },
      },
    },
  },
});
