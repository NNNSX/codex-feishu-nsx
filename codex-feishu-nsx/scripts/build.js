import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: [
    // The SDK must stay external because it spawns the Codex CLI subprocess and resolves
    // dist/cli.js relative to its own package location. Bundling it
    // breaks that path resolution.
    '@openai/codex-sdk',
    // Keep package dependencies external so the daemon can be built from any checkout
    // without embedding package-manager or local workspace paths in the bundle.
    '@larksuiteoapi/node-sdk',
    'markdown-it',
    // Node.js built-ins
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: {
    js: [
      "import { createRequire } from 'module';",
      "import { fileURLToPath } from 'url';",
      "import { dirname } from 'path';",
      "const require = createRequire(import.meta.url);",
      "const __filename = fileURLToPath(import.meta.url);",
      "const __dirname = dirname(__filename);",
    ].join(' '),
  },
});

console.log('Built dist/daemon.mjs');
