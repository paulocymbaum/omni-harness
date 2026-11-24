// Gate CNPJ-G004-STATIC — formulário do site aceita CNPJ alfanumérico (sem vitest: node_modules ausente).
// ANTES da implementação este teste DEVE falhar (replace(/\D/g) no bloco do CNPJ).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PAGES = 'ofluxo_site/src/platform/presentation/pages';
const src = fs.readFileSync(`${PAGES}/domain-pages.tsx`, 'utf8');
const start = src.indexOf("label=\"CNPJ\"") >= 0 ? src.indexOf("label=\"CNPJ\"") : src.indexOf('const [cnpj, setCnpj]');
const call = src.indexOf("'businessVerifyCnpjAndCreate'");
const block = src.slice(start, call + 400);

test('bloco do CNPJ não usa replace(/\\D/g) nem inputMode numeric', () => {
  assert.ok(start >= 0 && call > start, 'bloco do CNPJ não localizado');
  assert.doesNotMatch(block, /cnpj\.replace\(\/\\D\/g/);
  assert.doesNotMatch(block, /inputMode="numeric"/);
});

test('CPF continua com \\D (não regredir)', () => {
  assert.match(src, /cpf\.replace\(\/\\D\/g/);
});

test('helper de normalização existe e o formulário o usa', () => {
  const candidates = ['cnpj-input.ts', '../../domain/cnpj.ts'].map((p) => path.join(PAGES, p));
  const helper = candidates.find((p) => fs.existsSync(p));
  assert.ok(helper, 'helper cnpj-input.ts (pages/) ou domain/cnpj.ts não existe');
  const h = fs.readFileSync(helper, 'utf8');
  assert.match(h, /\[\^0-9A-Za-z\]/);
  assert.match(h, /toUpperCase\(\)/);
  assert.match(block, /normalizeCnpjInput\(cnpj\)/);
});
