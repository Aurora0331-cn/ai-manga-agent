import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发：前端跑 5173，/api 与 /exports 代理到后端 5174。
// 生产：vite build 产出 dist/，由 Express 同源托管。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5174',
      '/exports': 'http://127.0.0.1:5174'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
