import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function collect(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...collect(fullPath));
    else if (entry.isFile() && fullPath.endsWith('.js')) output.push(fullPath);
  }
  return output;
}

const files = ['index.js', ...collect('src'), ...collect('tests')];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}
console.log(`JavaScript syntax check passed (${files.length} files).`);
