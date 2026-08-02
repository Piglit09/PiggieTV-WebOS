import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

type AppInfo = {
  id: string;
  version: string;
};

const appInfo = JSON.parse(
  readFileSync(new URL('./appinfo.json', import.meta.url), 'utf8')
) as AppInfo;

function readGitMetadata(args: string[], fallback: string) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim() || fallback;
  } catch {
    return fallback;
  }
}

const buildCommit = readGitMetadata(['rev-parse', 'HEAD'], 'unavailable');
const worktreeStatus = readGitMetadata(['status', '--porcelain', '--untracked-files=normal'], '');
const diagnosticBuildCommit = buildCommit !== 'unavailable' && worktreeStatus
  ? `${buildCommit}-dirty`
  : buildCommit;
const buildTimestamp = readGitMetadata(['show', '-s', '--format=%cI', 'HEAD'], 'unavailable');

export default defineConfig({
  base: './',
  define: {
    'import.meta.env.VITE_PTV_VERSION': JSON.stringify(appInfo.version),
    'import.meta.env.VITE_PTV_PACKAGE_ID': JSON.stringify(appInfo.id),
    'import.meta.env.VITE_PTV_BUILD_TS': JSON.stringify(buildTimestamp),
    'import.meta.env.VITE_PTV_COMMIT': JSON.stringify(diagnosticBuildCommit)
  },
  plugins: [
    react(),
    legacy({
      targets: ['Chrome >= 68'],
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
