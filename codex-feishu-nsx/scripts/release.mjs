import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.resolve(skillDir, '..', 'codex-feishu-nsx-core');
const node = process.execPath;

function run(cwd, args) {
  console.log(`$ ${node} ${args.join(' ')}`);
  execFileSync(node, args, { cwd, stdio: 'inherit' });
}

if (!fs.existsSync(path.join(coreDir, 'node_modules'))) {
  throw new Error(`Core dependencies not found: ${coreDir}`);
}

run(coreDir, [path.join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
const coreTestDir = path.join(coreDir, 'src', '__tests__', 'unit');
const coreTests = fs.readdirSync(coreTestDir)
  .filter((name) => /^bridge-.*\.test\.ts$/.test(name))
  .map((name) => path.join('src', '__tests__', 'unit', name));
run(coreDir, ['--test', '--import', 'tsx', '--test-timeout=15000', ...coreTests]);
run(coreDir, [path.join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json']);

const linkedCore = fs.realpathSync(path.join(skillDir, 'node_modules', 'codex-feishu-nsx-core'));
fs.cpSync(path.join(coreDir, 'dist'), path.join(linkedCore, 'dist'), { recursive: true, force: true });
run(skillDir, [path.join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
const appTestDir = path.join(skillDir, 'src', '__tests__');
const appTests = fs.readdirSync(appTestDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join('src', '__tests__', name));
run(skillDir, ['--test', '--test-concurrency=1', '--import', 'tsx', '--test-timeout=15000', ...appTests]);
run(skillDir, ['scripts/build.js']);

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const coreArtifact = path.join('dist', 'lib', 'bridge', 'bridge-manager.js');
if (hash(path.join(coreDir, coreArtifact)) !== hash(path.join(linkedCore, coreArtifact))) {
  throw new Error('Core artifact synchronization check failed.');
}

console.log('Release verification complete: typechecks, tests, core sync, and app bundle passed.');
