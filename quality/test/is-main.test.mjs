// isMain: o ponto de entrada é reconhecido com espaço no caminho, com symlink e importado como módulo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUALITY_DIR } from './helpers.mjs';

const IS_MAIN = path.join(QUALITY_DIR, 'lib', 'is-main.mjs');
const ROOT = path.dirname(QUALITY_DIR);
const script = `import { isMain } from ${JSON.stringify(IS_MAIN)};\nconsole.log(isMain(import.meta.url) ? 'MAIN' : 'IMPORTADO');\n`;
const run = (file) => spawnSync(process.execPath, [file], { encoding: 'utf8' }).stdout.trim();

test('executado direto, com espaço no caminho e via symlink: MAIN (a guarda antiga falhava com espaço)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ismain-'));
  try {
    const spaced = path.join(tmp, 'dir com espaco');
    fs.mkdirSync(spaced);
    fs.writeFileSync(path.join(spaced, 'main.mjs'), script);
    assert.equal(run(path.join(spaced, 'main.mjs')), 'MAIN');
    fs.symlinkSync(path.join(spaced, 'main.mjs'), path.join(tmp, 'atalho.mjs'));
    assert.equal(run(path.join(tmp, 'atalho.mjs')), 'MAIN');
    // a forma antiga, só para provar o defeito que o helper corrige
    fs.writeFileSync(path.join(spaced, 'antigo.mjs'), "console.log(import.meta.url === `file://${process.argv[1]}` ? 'MAIN' : 'NO-OP');\n");
    assert.equal(run(path.join(spaced, 'antigo.mjs')), 'NO-OP');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('importado por outro módulo: IMPORTADO', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ismain-'));
  try {
    fs.writeFileSync(path.join(tmp, 'lib.mjs'), script);
    fs.writeFileSync(path.join(tmp, 'entrada.mjs'), "await import('./lib.mjs');\n");
    assert.equal(run(path.join(tmp, 'entrada.mjs')), 'IMPORTADO');
    assert.equal(spawnSync(process.execPath, ['-e', `import(${JSON.stringify(IS_MAIN)}).then(m => console.log(m.isMain('file:///x/y.mjs', undefined)))`], { encoding: 'utf8' }).stdout.trim(), 'false');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('os três scripts usam o helper e continuam executando o main', () => {
  for (const rel of ['.claude/hooks/sync-spec-jira.mjs', 'quality/agents/sync-clinerules.mjs', 'quality/agents/graphify-build.mjs']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /isMain\(import\.meta\.url\)/, rel);
    assert.doesNotMatch(text, /import\.meta\.url === `file:\/\//, rel);
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'quality/agents/sync-clinerules.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /em sincronia/); // se o main não rodasse, a saída seria vazia
});
