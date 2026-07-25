import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

function run(cwd, args) {
  console.log(`$ ${node} ${args.join(' ')}`);
  execFileSync(node, args, { cwd, stdio: 'inherit' });
}

run(skillDir, [path.join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
const appTestDir = path.join(skillDir, 'src', '__tests__');
const appTests = fs.readdirSync(appTestDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join('src', '__tests__', name));
run(skillDir, ['--test', '--test-concurrency=1', '--import', 'tsx', '--test-timeout=15000', ...appTests]);
run(skillDir, ['scripts/build.js']);

console.log('Release verification complete: typecheck, tests, and daemon bundle passed.');
