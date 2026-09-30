import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const folder of ['src','public','scripts','tests']) {
  for (const file of await readdir(folder)) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${folder}/${file}`], { stdio:'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('Sintaxis JavaScript verificada.');
