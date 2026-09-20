import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { createApiMiddleware } from './src/server/api';
import { Repo } from './src/server/repo';

const dataPath = process.env.BFIB_DATA_FILE ?? resolve(process.cwd(), 'data', 'state.json');

function apiPlugin(): Plugin {
  const repo = new Repo(dataPath);
  return {
    name: 'bfib-api',
    configureServer(server) {
      server.middlewares.use(createApiMiddleware(repo) as never);
    },
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5225,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
} as never);
