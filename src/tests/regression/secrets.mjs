import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assert, failure } from './helpers.mjs';

async function main() {
  assert(process.argv.length === 2, 'Configura el helper mediante variables de entorno');
  const sentinel = process.env.REGRESSION_SECRET_SENTINEL;
  assert(sentinel && sentinel.length >= 16, 'Define REGRESSION_SECRET_SENTINEL (valor ficticio, mínimo 16 caracteres)');
  const directory = await realpath(process.env.REGRESSION_FRONTEND_DIR || 'build/frontend');
  const needles = [...new Set([sentinel, encodeURIComponent(sentinel), JSON.stringify(sentinel).slice(1, -1)])];
  let files = 0;
  const leaks = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'No se siguen symlinks en el artefacto frontend');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) {
        files++;
        const content = await readFile(file);
        if (needles.some(value => content.includes(Buffer.from(value)))) leaks.push(path.relative(directory, file));
      }
    }
  }
  await scan(directory);
  assert(files > 0, 'No hay artefactos para inspeccionar');
  assert.equal(leaks.length, 0, `Sentinel encontrado en frontend: ${leaks.join(', ')}`);
  console.log(`OK sentinel ausente en ${files} archivos frontend (incluye sourcemaps si existen).`);
}

main().catch(failure);
