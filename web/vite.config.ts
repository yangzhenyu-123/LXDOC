import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 后端 API 反向代理（含 /api/files 鉴权文件接口）
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // OnlyOffice Document Server 反代（前端 api.js 与 iframe 同源访问）
      // 部署时 VITE_ONLYOFFICE_URL=/onlyoffice；本地开发指向容器 8081 端口
      '/onlyoffice': {
        target: process.env.VITE_ONLYOFFICE_PROXY ?? 'http://localhost:8081',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
