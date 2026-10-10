import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 后端端口跟启动脚本/主进程一致：NOVAI_PORT（默认 3000）。此前这里写死 3101，
// 按文档起 3000 的后端时新外壳的 /api、/ws、/output、/assets 全打到空端口。
const BACKEND_PORT = process.env.NOVAI_PORT || 3000;
const BACKEND_HTTP = `http://127.0.0.1:${BACKEND_PORT}`;
const BACKEND_WS = `ws://127.0.0.1:${BACKEND_PORT}`;

// 构建产物放进 static/v2，由后端 /v2 路由返回 index.html；
// 旧页面（/static/*.html）仍由原来的 StaticFiles 提供，新外壳用 iframe 承载还没重写的页面。
export default defineConfig({
    base: '/static/v2/',
    plugins: [vue()],
    build: {
        outDir: '../static/v2',
        emptyOutDir: true,
        assetsDir: 'assets',
        target: 'es2019',
        sourcemap: false,
    },
    server: {
        port: 5173,
        proxy: {
            '/api': BACKEND_HTTP,
            '/ws': { target: BACKEND_WS, ws: true },
            '^/static/(?!v2)': BACKEND_HTTP,
            '/output': BACKEND_HTTP,
            '/assets': BACKEND_HTTP,
        },
    },
});
