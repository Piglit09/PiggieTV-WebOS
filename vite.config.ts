import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

type AppInfo = {
  id: string;
  version: string;
};

const appInfo = JSON.parse(
  readFileSync(new URL('./appinfo.json', import.meta.url), 'utf8')
) as AppInfo;

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
const { createBuildManifest } = createRequire(import.meta.url)('./scripts/ptv-build-manifest.cjs') as {
  createBuildManifest: (options: { sourceRoot: string }) => void;
};
const gitExecutable = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git';

function readGitMetadata(args: string[], fallback: string) {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_TERMINAL_PROMPT = '0';
    return execFileSync(gitExecutable, [
      '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', ...args
    ], {
      cwd: sourceRoot,
      env,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim() || fallback;
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

export default defineConfig(({ command }) => {
  if (command === 'build') {
    execFileSync(process.execPath, [fileURLToPath(new URL('./scripts/ptv-workspace-preflight.cjs', import.meta.url)), 'build'], {
      cwd: sourceRoot,
      stdio: 'inherit'
    });
  }
  return {
  base: './',
  define: {
    'import.meta.env.VITE_PTV_VERSION': JSON.stringify(appInfo.version),
    'import.meta.env.VITE_PTV_PACKAGE_ID': JSON.stringify(appInfo.id),
    'import.meta.env.VITE_PTV_BUILD_TS': JSON.stringify(buildTimestamp),
    'import.meta.env.VITE_PTV_COMMIT': JSON.stringify(diagnosticBuildCommit),
    'import.meta.env.VITE_PTV_DIAGNOSTICS': JSON.stringify(process.env.PTV_DIAGNOSTICS === '1')
  },
  plugins: [
    react(),
    legacy({
      targets: ['Chrome >= 68'],
      modernPolyfills: false,
      renderModernChunks: false,
      renderLegacyChunks: true
    }),
    {
      name: 'ptv-build-provenance',
      apply: 'build',
      enforce: 'post',
      closeBundle() {
        createBuildManifest({ sourceRoot });
      }
    }
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
  };
});
