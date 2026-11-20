import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const files = globSync('tests/**/*.test.ts', { cwd }).sort();
// Catch a discovery regression instead of accepting Node's zero-test exit code.
if (files.length < 26) throw new Error(`Expected at least 26 test files, found ${files.length}.`);
console.log(`Running ${files.length} test files`);
const result = spawnSync(process.execPath, ['--test', ...files], { cwd, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
