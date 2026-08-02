import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    legacy({
      targets: ['ie 11'],
      modernPolyfills: false,
      renderModernChunks: false,
      renderLegacyChunks: true
    })
  ],
  build: {
    outDir: 'build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: './index.html'
      }
    },
    sourcemap: false
  },
  server: {
    host: '0.0.0.0',
    port: 8080
  }
});
