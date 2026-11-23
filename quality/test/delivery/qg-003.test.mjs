// Gate QG-003-WORKFLOW — CI dos gates de qualidade (.github/workflows/quality.yml).
// Antes da implementação este teste DEVE falhar: o workflow não existia.
// Rode: node --test quality/test/delivery/qg-003.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WF = path.join(ROOT, '.github', 'workflows', 'quality.yml');
// Mesma regra do qg-001: toda action pinada por SHA de commit (40 hex).
const PINNED = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}(?:\s|#|$)/;

function readWorkflow() {
  assert(fs.existsSync(WF), '.github/workflows/quality.yml não existe; crie o workflow do QUALITY.md §7.');
  return fs.readFileSync(WF, 'utf8');
}

test('qg-003: workflow de qualidade existe, tem nome e roda em PR e push na main', () => {
  const yml = readWorkflow();
  assert.match(yml, /^name: Gates de Qualidade/m, 'nome do workflow deve ser "Gates de Qualidade"');
  assert.match(yml, /^\s*pull_request:/m, 'deve rodar em pull_request');
  assert.match(yml, /branches: \[main\]/, 'deve rodar em push na main');
});

test('qg-003: toda action do workflow está pinada por SHA', () => {
  const yml = readWorkflow();
  const soltos = [];
  for (const m of yml.matchAll(/(?:^|\n)\s*(?:- )?uses:\s*(\S+)/g)) {
    const ref = m[1];
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue;
    if (!PINNED.test(ref)) soltos.push(ref);
  }
  assert.deepEqual(soltos, [], `actions sem pin: ${soltos.join(', ')}`);
});

test('qg-003: filtro por camada com dorny/paths-filter e jobs por camada', () => {
  const yml = readWorkflow();
  assert.match(yml, /dorny\/paths-filter@[0-9a-f]{40}/, 'faltou o paths-filter pinado');
  for (const camada of ['flutter:', 'ocr:', 'web:']) {
    assert.ok(yml.includes(camada), `filtro da camada ${camada} ausente`);
  }
  for (const job of ['  flutter:', '  ocr:', '  web:', '  higiene:', '  gate:']) {
    assert.ok(yml.includes(`\n${job}`), `job ${job.trim()} ausente`);
  }
});

test('qg-003: higiene roda self-testes, ratchet global e o motor no diff', () => {
  const yml = readWorkflow();
  assert.match(yml, /node --test quality\/test\/\*\.test\.mjs/, 'self-testes do motor ausentes');
  assert.match(yml, /node quality\/baseline\.mjs --check/, 'ratchet global (baseline --check) ausente');
  assert.match(yml, /node quality\/run\.mjs --tier \w+ --base origin\/main/, 'motor sem comparação com origin/main');
});

test('qg-003: gate consolidador é sempre avaliado e reprova com qualquer falha', () => {
  const yml = readWorkflow();
  const gateIdx = yml.indexOf('\n  gate:');
  assert.ok(gateIdx >= 0, 'job gate ausente');
  const gate = yml.slice(gateIdx);
  assert.match(gate, /if: always\(\)/, 'gate precisa de if: always() para avaliar jobs ignorados/falhos');
  assert.match(gate, /needs: \[higiene, flutter, ocr, web\]/, 'gate precisa depender de todos os jobs de qualidade');
  assert.match(gate, /!= "success" && "\$r" != "skipped"/, 'gate deve aceitar só success ou skipped');
});

test('qg-003: expressões não indexam named-value por variável (falha de startup no GitHub)', () => {
  // Incidente real: ${{ needs[j].result }} dentro de loop bash — o GitHub expande
  // ${{ }} antes do shell e named-value indexado por identificador não existe lá.
  // Indexação numérica (ex.: matrix.include[0]) continua permitida.
  const yml = readWorkflow();
  const dinamicas = [];
  for (const m of yml.matchAll(/\$\{\{[^}]*\}\}/g)) {
    if (/\[[A-Za-z_]/.test(m[0])) dinamicas.push(m[0].trim());
  }
  assert.deepEqual(dinamicas, [], `expressões com indexação dinâmica: ${dinamicas.join(', ')}`);
});

test('qg-003: app mobile tem cobertura do diff com mínimo de 80%', () => {
  const yml = readWorkflow();
  assert.match(yml, /flutter test --coverage/, 'testes sem cobertura');
  assert.match(yml, /diff-cover coverage\/lcov\.info[^\n]*--fail-under 80/, 'diff-cover ausente ou com limite errado');
});
