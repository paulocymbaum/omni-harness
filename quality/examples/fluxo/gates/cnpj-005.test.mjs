// Gate CNPJ-G005 — assertNoRawBusinessDocumentLeak detecta CNPJ alfanumérico limpo no record.
// ANTES da implementação este teste DEVE falhar (strip /\D/g gera fragmento numérico).
// Compila functions (lib é derivado do src) e exercita o comportamento real.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

let leak;
before(() => {
  const b = spawnSync('npm', ['--prefix', 'functions', 'run', 'build'], { encoding: 'utf8' });
  assert.equal(b.status, 0, `build das functions falhou:\n${b.stdout}${b.stderr}`);
  leak = createRequire(import.meta.url)('../../../functions/lib/features/businesses.js')
    .assertNoRawBusinessDocumentLeak;
});

test('alfanumérico limpo no record é vazamento (false)', () => {
  assert.equal(leak({ note: 'x 12ABC34501DE35 y' }, '12.ABC.345/01DE-35'), false);
});

test('alfanumérico em minúsculas no record é vazamento (false)', () => {
  assert.equal(leak({ note: '12abc34501de35' }, '12.ABC.345/01DE-35'), false);
});

test('record limpo e documento vazio retornam true; numérico legado continua detectado', () => {
  assert.equal(leak({ name: 'Bar do Zé' }, '12.ABC.345/01DE-35'), true);
  assert.equal(leak({ name: 'x' }, ''), true);
  assert.equal(leak({ note: '12345678000190' }, '12.345.678/0001-90'), false);
});

test('businesses.ts não usa mais replace(/\\D/g) e importa stripCnpjFormatting', () => {
  const s = fs.readFileSync('functions/src/features/businesses.ts', 'utf8');
  assert.doesNotMatch(s, /replace\(\/\\D\/g/);
  assert.match(s, /stripCnpjFormatting/);
});
