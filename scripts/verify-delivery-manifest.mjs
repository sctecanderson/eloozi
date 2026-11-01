#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? process.cwd());
const manifestName = 'MANIFEST.sha256.json';

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function walk(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute, relative));
    else if (entry.isFile()) files.push(relative.replaceAll('\\', '/'));
    else throw new Error(`Tipo de arquivo nao suportado: ${relative}`);
  }
  return files;
}

try {
  const manifest = JSON.parse(await readFile(path.join(root, manifestName), 'utf8'));
  if (manifest.format !== 'Eloozi SHA-256 manifest v1' || !Array.isArray(manifest.files)) {
    throw new Error('Formato de manifesto invalido.');
  }

  const expected = new Map();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.startsWith('/')
      || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Caminho relativo inseguro no manifesto: ${entry.path}`);
    }
    if (entry.path === manifestName || expected.has(entry.path)) {
      throw new Error(`Caminho duplicado ou manifesto listado nele mesmo: ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Tamanho/SHA-256 invalido: ${entry.path}`);
    }
    expected.set(entry.path, entry);
  }

  const actualFiles = (await walk(root)).filter(name => name !== manifestName).sort();
  const expectedFiles = [...expected.keys()].sort();
  const missing = expectedFiles.filter(name => !actualFiles.includes(name));
  const extra = actualFiles.filter(name => !expected.has(name));
  if (missing.length || extra.length) {
    if (missing.length) fail(`Arquivos faltantes: ${missing.join(', ')}`);
    if (extra.length) fail(`Arquivos extras: ${extra.join(', ')}`);
  }

  let mismatches = 0;
  for (const [relative, entry] of expected) {
    if (missing.includes(relative)) continue;
    const absolute = path.join(root, ...relative.split('/'));
    const [contents, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    if (info.size !== entry.size || sha256 !== entry.sha256) {
      mismatches++;
      fail(`Hash/tamanho divergente: ${relative}`);
    }
  }

  if (!process.exitCode) console.log(`PASS: ${expected.size} arquivos, sem faltantes/extras, hashes conferidos; ${mismatches} divergencias.`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
