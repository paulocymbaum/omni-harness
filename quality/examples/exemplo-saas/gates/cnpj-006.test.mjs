// Gate CNPJ-G006 — sanitizeAuditDetails redige CNPJ alfanumérico e preserva o comportamento atual.
// ANTES da implementação os casos alfanuméricos DEVEM falhar. Compila functions e exercita o lib real.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

let sanitize;
before(() => {
  const b = spawnSync('npm', ['--prefix', 'functions', 'run', 'build'], { encoding: 'utf8' });
  assert.equal(b.status, 0, `build das functions falhou:\n${b.stdout}${b.stderr}`);
  sanitize = createRequire(import.meta.url)('../../../functions/lib/identity/shared/audit.js')
    .sanitizeAuditDetails;
});

test('CNPJ alfanumérico limpo é redigido', () => {
  assert.deepEqual(sanitize({ note: '12ABC34501DE35' }), { note: '[REDACTED_CNPJ]' });
});

test('CNPJ alfanumérico mascarado e minúsculo é redigido', () => {
  assert.deepEqual(sanitize({ note: '12.ABC.345/01DE-35' }), { note: '[REDACTED_CNPJ]' });
  assert.deepEqual(sanitize({ note: '12abc34501de35' }), { note: '[REDACTED_CNPJ]' });
});

test('falsos positivos evitados: 14 letras e referência curta ficam intactos', () => {
  assert.deepEqual(sanitize({ note: 'ABCDEFGHIJKLMN' }), { note: 'ABCDEFGHIJKLMN' });
  assert.deepEqual(sanitize({ note: 'abc123' }), { note: 'abc123' });
  assert.deepEqual(sanitize({ note: 'Rua das Flores 12' }), { note: 'Rua das Flores 12' });
});

test('comportamento numérico existente preservado (CPF e CNPJ)', () => {
  assert.deepEqual(sanitize({ note: 'cnpj consultado 12345678000190' }), { note: '[REDACTED_CNPJ]' });
  assert.deepEqual(sanitize({ note: '123.456.789-09' }), { note: '[REDACTED_CPF]' });
});
