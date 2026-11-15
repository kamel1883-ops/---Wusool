import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API Worker runs separately in development (`npm run dev:api`, port 8787)
// and is proxied here so the browser only ever talks to one origin.
// PREVIEW_ALLOWED_HOSTS carries the exact cloud preview hostname for this VM;
// there is deliberately no wildcard allowlist.
const allowedHosts = (process.env.PREVIEW_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
