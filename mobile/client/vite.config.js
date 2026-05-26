import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server runs on :5174 (different from desktop client's :5173) and
// proxies /api straight to the mobile companion backend on :8081.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:8081',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
