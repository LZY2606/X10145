import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiHandler } from './src/server/api.js';
import { Storage } from './src/server/storage.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const storage = new Storage(resolve(here, 'data'));

function apiPlugin(): Plugin {
  return {
    name: 'binary-bench-api',
    configureServer(server) {
      const handler = createApiHandler({ storage });
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        const handled = await handler(req, res);
        if (!handled) next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5225,
    strictPort: false,
  },
});
